"""Sends finished workouts to Strava and Garmin Connect.

Part of the analyzer service (analyzer.py mounts `router`). The app posts a
finished workout to /exports/strava or /exports/garmin; this module turns it
into what each service takes and remembers what it has sent, so a workout is
never posted twice.

Strava: its official API. A manual "Weight Training" activity is created, and
since that API has no fields for exercises, sets or reps, the workout is
written out in the description. Needs an API application of your own
(STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in server/.env) and one
"Connect" click, which stores a token in connections.json next to this file.

Garmin Connect: there is no official way for a personal project to add an
activity (the developer programme is for approved businesses, the personal API
only reads). What exists is the upload the Garmin Connect website itself uses,
reached with your own login through the unofficial `garminconnect` library.
The workout goes up as a FIT file with its exercises, sets, reps and weights.
The password is used once to obtain tokens and is not stored.
"""

from __future__ import annotations

import datetime
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import zlib
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

import jsonstore

STORE = Path(__file__).with_name("connections.json")
GARMIN_TOKENS = Path(__file__).with_name("garmin-tokens")

STRAVA_API = "https://www.strava.com/api/v3"
STRAVA_OAUTH = "https://www.strava.com/oauth"
STRAVA_SCOPE = "activity:write"

SIGNATURE = "Logged by my own app automatically"
LB_PER_KG = 2.2046226218
FIT_EPOCH = 631065600  # seconds between 1970-01-01 and the FIT format's 1989-12-31
CONNECT_AGAIN = "connect again in the app under Settings → Connections"

# Bounds on what a workout may claim: beyond them it is not a workout but a way to crash the FIT writer.
EARLIEST = FIT_EPOCH * 1000  # milliseconds; the FIT format can't say anything earlier
LATEST = 4_102_444_800_000  # 2100-01-01

router = APIRouter()
# One workout at a time per service: checking whether it was sent, sending it and
# remembering that have to be one step, or two requests for the same workout —
# the app retrying while the first is still on its way — would both post it.
_sending = {"strava": threading.Lock(), "garmin": threading.Lock()}


# --- what the app sends -------------------------------------------------------

class SetIn(BaseModel):
    weight: float | None = Field(default=None, ge=0, le=5000)  # kilograms; None for a bodyweight set
    reps: int | None = Field(default=None, ge=0, le=100_000)
    rpe: float | None = Field(default=None, ge=0, le=10)
    warmup: bool = False


class ExerciseIn(BaseModel):
    name: str = Field(max_length=200)
    muscle: str = Field(default="", max_length=40)
    sets: list[SetIn] = Field(default_factory=list, max_length=200)


class WorkoutIn(BaseModel):
    id: str = Field(min_length=1, max_length=100)
    name: str = Field(default="", max_length=200)
    started_at: int = Field(ge=EARLIEST, le=LATEST)  # milliseconds since 1970, like every time in the app
    ended_at: int = Field(ge=EARLIEST, le=LATEST)
    utc_offset_minutes: int = Field(default=0, ge=-14 * 60, le=14 * 60)  # local time minus UTC where it was logged
    notes: str = Field(default="", max_length=5000)
    exercises: list[ExerciseIn] = Field(default_factory=list, max_length=100)


class ExportRequest(BaseModel):
    workout: WorkoutIn
    unit: Literal["kg", "lb"] = "kg"
    effort: Literal["rpe", "rir"] = "rpe"


class GarminLogin(BaseModel):
    email: str = Field(default="", max_length=200)
    password: str = Field(default="", max_length=200, repr=False)
    mfa_code: str = Field(default="", max_length=20)


# --- what is kept on disk -----------------------------------------------------

# Every change is read, made and written back while holding jsonstore.lock.

def load_store() -> dict:
    return jsonstore.read(STORE)


def save_store(data: dict) -> None:
    """Writes the tokens and the list of sent workouts, readable by the owner only."""
    jsonstore.write(STORE, data)


def sent_before(workout_id: str, target: str) -> dict | None:
    found = load_store().get("exports", {}).get(workout_id, {}).get(target)
    return found if isinstance(found, dict) else None


def remember_sent(workout_id: str, target: str, result: dict) -> None:
    with jsonstore.lock:
        store = load_store()
        store.setdefault("exports", {}).setdefault(workout_id, {})[target] = result
        save_store(store)


def http_client() -> httpx.Client:
    return httpx.Client(timeout=30)


# --- the workout in words -----------------------------------------------------

def number(value: float) -> str:
    """Up to two decimals, without trailing zeros: 87.5, 100, 2.25."""
    return f"{value:.2f}".rstrip("0").rstrip(".")


def weight_text(kilograms: float, unit: str) -> str:
    return f"{number(round(kilograms * LB_PER_KG, 1))} lb" if unit == "lb" else f"{number(kilograms)} kg"


def set_text(item: SetIn, unit: str, effort: str) -> str:
    if item.weight is not None and item.reps is not None:
        text = f"{weight_text(item.weight, unit)} × {item.reps}"
    elif item.weight is not None:
        text = weight_text(item.weight, unit)
    elif item.reps is not None:
        text = f"{item.reps} reps"
    else:
        text = "done"
    if item.rpe is not None:
        text += f" @ RPE {number(item.rpe)}" if effort == "rpe" else f" @ {number(max(0.0, 10 - item.rpe))} RIR"
    return text


def describe(workout: WorkoutIn, unit: str, effort: str) -> str:
    """The workout written out the way a strength app's Strava post reads: each exercise, then its sets."""
    blocks = []
    for exercise in workout.exercises:
        lines, working = [exercise.name], 0
        for item in exercise.sets:
            if item.warmup:
                label = "Warm-up"
            else:
                working += 1
                label = f"Set {working}"
            lines.append(f"{label}: {set_text(item, unit, effort)}")
        blocks.append("\n".join(lines))
    if workout.notes.strip():
        blocks.append(workout.notes.strip())
    blocks.append(SIGNATURE)
    return "\n\n".join(blocks)


def title(workout: WorkoutIn) -> str:
    return workout.name.strip() or "Workout"


def seconds_long(workout: WorkoutIn) -> int:
    return max(1, round((workout.ended_at - workout.started_at) / 1000))


def local_start(workout: WorkoutIn) -> str:
    """The start on the clock of the person who trained, which is what Strava asks for."""
    moment = datetime.datetime.fromtimestamp(workout.started_at / 1000, datetime.timezone.utc)
    return (moment + datetime.timedelta(minutes=workout.utc_offset_minutes)).strftime("%Y-%m-%dT%H:%M:%S")


# --- Strava -------------------------------------------------------------------

_strava_states: dict[str, tuple[float, str]] = {}  # state → (valid until, where to go back to)


def strava_app() -> tuple[str, str] | None:
    """The API application's id and secret from server/.env, if both are there."""
    client_id = os.environ.get("STRAVA_CLIENT_ID", "").strip()
    secret = os.environ.get("STRAVA_CLIENT_SECRET", "").strip()
    return (client_id, secret) if client_id and secret else None


def need_strava_app() -> tuple[str, str]:
    app = strava_app()
    if not app:
        raise HTTPException(409, "Strava isn't set up on the analyzer: put STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET "
                                 "from strava.com/settings/api into server/.env and restart it.")
    return app


def strava_message(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return ""
    if not isinstance(body, dict):
        return ""
    parts = [body["message"]] if isinstance(body.get("message"), str) else []
    for error in body.get("errors") or []:
        if isinstance(error, dict):
            parts.append(" ".join(str(error[key]) for key in ("resource", "field", "code") if error.get(key)))
    return " — ".join(part for part in parts if part)[:200]


def forget_strava() -> None:
    with jsonstore.lock:
        store = load_store()
        if store.pop("strava", None) is not None:
            save_store(store)


def strava_tokens(grant: dict) -> dict:
    """Exchanges an authorization code or a refresh token for a fresh access token."""
    client_id, secret = need_strava_app()
    try:
        with http_client() as client:
            response = client.post(f"{STRAVA_OAUTH}/token", data={"client_id": client_id, "client_secret": secret, **grant})
    except httpx.HTTPError as error:
        raise HTTPException(502, "The analyzer couldn't reach Strava.") from error
    if response.status_code in (400, 401):
        if grant.get("grant_type") == "refresh_token":
            forget_strava()
            raise HTTPException(401, f"Strava no longer accepts this connection; {CONNECT_AGAIN}.")
        raise HTTPException(502, f"Strava refused the sign-in ({strava_message(response) or response.status_code}). "
                                 "Check STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in server/.env.")
    if response.status_code >= 400:
        raise HTTPException(502, f"Strava's sign-in failed ({response.status_code}): {strava_message(response) or 'no details'}")
    return response.json()


def strava_access_token() -> str:
    saved = load_store().get("strava")
    if not isinstance(saved, dict) or not saved.get("refresh_token"):
        raise HTTPException(409, f"Strava isn't connected; {CONNECT_AGAIN}.")
    if saved.get("access_token") and saved.get("expires_at", 0) - time.time() > 60:
        return saved["access_token"]
    fresh = strava_tokens({"grant_type": "refresh_token", "refresh_token": saved["refresh_token"]})
    with jsonstore.lock:
        store = load_store()
        # Strava may hand out a new refresh token with any refresh; the old one then stops working.
        store["strava"] = {**saved, "access_token": fresh["access_token"], "expires_at": fresh["expires_at"],
                           "refresh_token": fresh.get("refresh_token") or saved["refresh_token"]}
        save_store(store)
    return fresh["access_token"]


def send_to_strava(request: ExportRequest) -> dict:
    workout = request.workout
    token = strava_access_token()
    try:
        with http_client() as client:
            response = client.post(f"{STRAVA_API}/activities", headers={"Authorization": f"Bearer {token}"}, data={
                "name": title(workout),
                "sport_type": "WeightTraining",
                "start_date_local": local_start(workout),
                "elapsed_time": seconds_long(workout),
                "description": describe(workout, request.unit, request.effort),
            })
    except httpx.HTTPError as error:
        raise HTTPException(502, "The analyzer couldn't reach Strava.") from error

    detail = strava_message(response)
    note = f" ({detail})" if detail else ""
    if response.status_code == 401:
        forget_strava()
        raise HTTPException(401, f"Strava no longer accepts this connection; {CONNECT_AGAIN}.")
    if response.status_code == 403:
        raise HTTPException(403, "Strava didn't allow adding an activity. Connect again and leave "
                                 f"“Upload your activities” ticked.{note}")
    if response.status_code == 429:
        raise HTTPException(429, "Strava's rate limit was hit; the workout will be sent later.")
    if response.status_code >= 400:
        # 5xx: Strava's trouble, worth another try later. 4xx: this workout as sent will never be taken.
        status = 502 if response.status_code >= 500 else 422
        raise HTTPException(status, f"Strava didn't take the workout ({response.status_code}){note}")
    activity_id = str(response.json().get("id", ""))
    return {"id": activity_id, "url": f"https://www.strava.com/activities/{activity_id}"}


@router.get("/strava/connect")
def strava_connect(request: Request, back: str = "/#/settings") -> RedirectResponse:
    """Sends the browser to Strava to approve the connection."""
    client_id, _ = need_strava_app()
    # Only ever back into this app: an address on another site could be anyone's.
    if not back.startswith("/") or back.startswith("//"):
        back = "/#/settings"
    now = time.time()
    for state in [state for state, (until, _) in _strava_states.items() if until < now]:
        del _strava_states[state]
    state = secrets.token_urlsafe(24)
    _strava_states[state] = (now + 600, back)
    query = httpx.QueryParams({
        "client_id": client_id,
        "redirect_uri": str(request.base_url).rstrip("/") + "/strava/callback",
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": STRAVA_SCOPE,
        "state": state,
    })
    return RedirectResponse(f"{STRAVA_OAUTH}/authorize?{query}", status_code=302)


@router.get("/strava/callback")
def strava_callback(state: str = "", code: str = "", scope: str = "", error: str = "") -> RedirectResponse:
    """Where Strava sends the browser back to; stores the tokens and returns to the app."""
    until, back = _strava_states.pop(state, (0.0, ""))
    if until < time.time():
        raise HTTPException(400, "That Strava sign-in has expired or didn't start here. Start it again from the app's Settings.")

    def return_with(outcome: str) -> RedirectResponse:
        path, _, fragment = back.partition("#")
        joiner = "&" if "?" in path else "?"
        return RedirectResponse(f"{path}{joiner}strava={outcome}" + (f"#{fragment}" if fragment else ""), status_code=302)

    if error or not code:
        return return_with("denied")
    if STRAVA_SCOPE not in scope.split(","):
        return return_with("no-upload-permission")
    tokens = strava_tokens({"grant_type": "authorization_code", "code": code})
    athlete = tokens.get("athlete") if isinstance(tokens.get("athlete"), dict) else {}
    name = " ".join(part for part in (athlete.get("firstname"), athlete.get("lastname")) if part) or "Strava athlete"
    with jsonstore.lock:
        store = load_store()
        store["strava"] = {"account": name, "access_token": tokens["access_token"],
                           "refresh_token": tokens["refresh_token"], "expires_at": tokens["expires_at"]}
        save_store(store)
    return return_with("connected")


@router.post("/strava/disconnect")
def strava_disconnect() -> dict:
    saved = load_store().get("strava")
    if isinstance(saved, dict) and saved.get("access_token"):
        try:  # tell Strava too; if it can't be reached the local tokens still go
            with http_client() as client:
                client.post(f"{STRAVA_OAUTH}/deauthorize", data={"access_token": saved["access_token"]})
        except httpx.HTTPError:
            pass
    forget_strava()
    return connections()


# --- Garmin Connect -----------------------------------------------------------

_garmin_waiting: dict[str, Any] = {}  # a login waiting for its verification code: {"client", "state", "until"}


def new_garmin(email: str | None = None, password: str | None = None) -> Any:
    """A client for Garmin Connect. Imported here so the analyzer starts without the library being used."""
    from garminconnect import Garmin
    return Garmin(email, password, return_on_mfa=True)


def garmin_status(error: Exception) -> int | None:
    """The HTTP status behind one of the library's errors, when it wraps an answer from Garmin."""
    status = getattr(getattr(error, "response", None), "status_code", None)
    return status if isinstance(status, int) else None


def garmin_failure(error: Exception) -> HTTPException:
    """Turns the library's errors into what to tell the person."""
    kind = type(error).__name__
    status = garmin_status(error)
    if "TooManyRequests" in kind or status == 429:
        return HTTPException(429, "Garmin is limiting requests from here right now; try again in an hour.")
    if "Authentication" in kind or status in (401, 403):
        return HTTPException(401, f"Garmin didn't accept the login ({str(error)[:150]}).")
    # The library reports every answer of 400 and up as a "connection" error. Garmin
    # saying no to this request is not Garmin being out of reach: trying again won't help.
    if status is not None and 400 <= status < 500 and status != 408:
        return HTTPException(422, f"Garmin Connect refused the request ({status}: {str(error)[:150]}).")
    if "Connection" in kind:
        return HTTPException(502, f"Garmin Connect couldn't be reached ({str(error)[:150]}).")
    return HTTPException(502, f"Garmin Connect failed ({kind}: {str(error)[:150]}).")


def keep_garmin_login(client: Any) -> dict:
    """Saves the tokens of a completed login (never the password) and notes whose account it is."""
    GARMIN_TOKENS.mkdir(mode=0o700, exist_ok=True)
    client.client.dump(str(GARMIN_TOKENS))
    try:
        name = client.get_full_name()
    except Exception:  # the profile isn't loaded after a login without a code; the tokens are what matters
        name = None
    if not name:
        try:
            session = garmin_session()
            name = session.get_full_name()
        except Exception:
            name = None
    with jsonstore.lock:
        store = load_store()
        store["garmin"] = {"account": name or "Garmin account"}
        save_store(store)
    return connections()


def garmin_session() -> Any:
    """A client signed in with the saved tokens."""
    if not load_store().get("garmin") or not GARMIN_TOKENS.is_dir():
        raise HTTPException(409, f"Garmin isn't connected; {CONNECT_AGAIN}.")
    client = new_garmin()
    try:
        client.login(str(GARMIN_TOKENS))
    except Exception as error:
        failure = garmin_failure(error)
        if failure.status_code == 401:
            forget_garmin()
            raise HTTPException(401, f"Garmin no longer accepts the saved login; {CONNECT_AGAIN}.") from error
        raise failure from error
    return client


def forget_garmin() -> None:
    shutil.rmtree(GARMIN_TOKENS, ignore_errors=True)
    with jsonstore.lock:
        store = load_store()
        if store.pop("garmin", None) is not None:
            save_store(store)


@router.post("/garmin/connect")
def garmin_connect(login: GarminLogin) -> dict:
    code = login.mfa_code.strip()
    if code:
        waiting = _garmin_waiting.pop("login", None)
        if not waiting or waiting["until"] < time.time():
            raise HTTPException(409, "That sign-in has expired; enter your email and password again.")
        try:
            waiting["client"].resume_login(waiting["state"], code)
        except Exception as error:
            raise garmin_failure(error) from error
        return keep_garmin_login(waiting["client"])

    if not login.email.strip() or not login.password:
        raise HTTPException(422, "Enter the email and password of your Garmin account.")
    client = new_garmin(login.email.strip(), login.password)
    try:
        status, state = client.login()
    except Exception as error:
        raise garmin_failure(error) from error
    if status == "needs_mfa":
        _garmin_waiting["login"] = {"client": client, "state": state, "until": time.time() + 600}
        raise HTTPException(409, "Garmin sent a verification code to your email or phone; enter it to finish.",
                            headers={"X-Needs-Code": "1"})
    return keep_garmin_login(client)


@router.post("/garmin/disconnect")
def garmin_disconnect() -> dict:
    forget_garmin()
    return connections()


# Words in an exercise's name → the FIT format's exercise category. Checked in
# order, so "leg curl" is found before "curl" and "split squat" before "squat".
GARMIN_CATEGORIES: tuple[tuple[tuple[str, ...], str], ...] = (
    (("bench press", "chest press", "floor press", "incline press", "decline press"), "BENCH_PRESS"),
    (("calf raise", "calf press"), "CALF_RAISE"),
    (("leg curl", "hamstring curl", "nordic"), "LEG_CURL"),
    (("lateral raise", "front raise", "rear delt raise"), "LATERAL_RAISE"),
    (("leg raise", "knee raise", "toes to bar"), "LEG_RAISE"),
    (("hip thrust", "glute bridge", "hip raise", "glute kickback", "frog pump", "pull through"), "HIP_RAISE"),
    (("hyperextension", "back extension", "good morning"), "HYPEREXTENSION"),
    (("swing",), "HIP_SWING"),
    (("lunge", "split squat", "step up"), "LUNGE"),
    (("clean", "snatch", "jerk", "thruster"), "OLYMPIC_LIFT"),
    (("deadlift", "rack pull"), "DEADLIFT"),
    (("pull up", "chin up", "pulldown", "pull down", "muscle up"), "PULL_UP"),
    (("push up", "pushup"), "PUSH_UP"),
    (("overhead press", "shoulder press", "military press", "arnold press", "push press"), "SHOULDER_PRESS"),
    (("face pull", "external rotation", "internal rotation"), "SHOULDER_STABILITY"),
    (("tricep", "skullcrusher", "skull crusher", "pushdown", "dip"), "TRICEPS_EXTENSION"),
    (("shrug",), "SHRUG"),
    (("row", "pullover"), "ROW"),
    (("fly", "flye", "crossover", "pec deck"), "FLYE"),
    (("curl",), "CURL"),
    (("squat", "leg press", "leg extension"), "SQUAT"),
    (("plank",), "PLANK"),
    (("sit up", "situp"), "SIT_UP"),
    (("crunch", "ab wheel", "rollout"), "CRUNCH"),
    (("carry", "farmer"), "CARRY"),
    (("jump",), "PLYO"),
)
GARMIN_BY_MUSCLE = {"core": "CORE", "cardio": "CARDIO", "fullBody": "TOTAL_BODY"}


def garmin_category(name: str, muscle: str = "") -> str | None:
    """The FIT exercise category an exercise belongs to, judged by its name; None when nothing fits."""
    words = " " + re.sub(r"[^a-z]+", " ", name.lower()).strip() + " "
    for keywords, category in GARMIN_CATEGORIES:
        if any(f" {keyword} " in words or f" {keyword}s " in words for keyword in keywords):
            return category
    return GARMIN_BY_MUSCLE.get(muscle)


def garmin_exercise_name(category: str, name: str) -> int | None:
    """The FIT number of the exact exercise within its category, when Garmin's list has one made of the same words."""
    from fit_tool.profile import profile_type

    listing = getattr(profile_type, "".join(part.capitalize() for part in category.split("_")) + "ExerciseName", None)
    if listing is None:
        return None
    ours = frozenset(re.sub(r"[^a-z]+", " ", name.lower()).split())
    for member in listing:
        if frozenset(member.name.lower().split("_")) == ours:
            return member.value
    return None


def build_fit(workout: WorkoutIn, unit: str) -> bytes:
    """The workout as a FIT activity file: a strength session with one "set" record per set.

    The app doesn't record when each set was done, so the sets are spread evenly
    over the workout; reps, weights and exercises are as logged.
    """
    from fit_tool.fit_file_builder import FitFileBuilder
    from fit_tool.profile import profile_type as fit
    from fit_tool.profile.messages.activity_message import ActivityMessage
    from fit_tool.profile.messages.event_message import EventMessage
    from fit_tool.profile.messages.exercise_title_message import ExerciseTitleMessage
    from fit_tool.profile.messages.file_id_message import FileIdMessage
    from fit_tool.profile.messages.lap_message import LapMessage
    from fit_tool.profile.messages.session_message import SessionMessage
    from fit_tool.profile.messages.set_message import SetMessage

    start, total = workout.started_at, seconds_long(workout)
    end = start + total * 1000
    builder = FitFileBuilder(auto_define=True, min_string_size=50)

    file_id = FileIdMessage()
    file_id.type = fit.FileType.ACTIVITY
    file_id.manufacturer = fit.Manufacturer.DEVELOPMENT.value
    file_id.product = 0
    file_id.time_created = start
    file_id.serial_number = zlib.crc32(workout.id.encode()) or 1  # stable per workout, so a repeat upload is recognised
    builder.add(file_id)

    def timer(kind: Any, at: int) -> None:
        event = EventMessage()
        event.event = fit.Event.TIMER
        event.event_type = kind
        event.timestamp = at
        builder.add(event)

    timer(fit.EventType.START, start)

    kinds: list[tuple[int | None, int | None]] = []
    for index, exercise in enumerate(workout.exercises):
        category = garmin_category(exercise.name, exercise.muscle)
        number_in_fit = getattr(fit.ExerciseCategory, category).value if category else None
        exact = garmin_exercise_name(category, exercise.name) if category else None
        kinds.append((number_in_fit, exact))
        heading = ExerciseTitleMessage()  # carries the name as logged, whatever Garmin's own lists call it
        heading.message_index = index
        if number_in_fit is not None:
            heading.exercise_category = number_in_fit
        if exact is not None:
            heading.exercise_name = exact
        heading.workout_step_name = exercise.name[:48]
        builder.add(heading)

    all_sets = [(index, item) for index, exercise in enumerate(workout.exercises) for item in exercise.sets]
    slot = total / max(1, len(all_sets))
    for position, (index, item) in enumerate(all_sets):
        number_in_fit, exact = kinds[index]
        record = SetMessage()
        record.message_index = position
        record.start_time = start + round(position * slot * 1000)
        record.duration = round(min(90.0, max(1.0, slot / 2)), 3)  # seconds under the bar: a guess, see above
        record.timestamp = record.start_time + round(record.duration * 1000)
        record.set_type = fit.SetType.ACTIVE
        if item.reps is not None:
            record.repetitions = max(0, min(item.reps, 65_000))
        if item.weight is not None:
            record.weight = max(0.0, min(item.weight, 4_000.0))
        record.weight_display_unit = fit.FitBaseUnit.POUND if unit == "lb" else fit.FitBaseUnit.KILOGRAM
        if number_in_fit is not None:
            record.category = [number_in_fit]
        if exact is not None:
            record.category_subtype = [exact]
        record.workout_step_index = index
        builder.add(record)

    timer(fit.EventType.STOP_ALL, end)

    for message in (LapMessage(), SessionMessage()):
        message.message_index = 0
        message.timestamp = end
        message.start_time = start
        message.total_elapsed_time = total
        message.total_timer_time = total
        message.sport = fit.Sport.TRAINING
        message.sub_sport = fit.SubSport.STRENGTH_TRAINING
        if isinstance(message, SessionMessage):
            message.first_lap_index = 0
            message.num_laps = 1
        builder.add(message)

    activity = ActivityMessage()
    activity.timestamp = end
    activity.total_timer_time = total
    activity.num_sessions = 1
    activity.type = fit.Activity.MANUAL
    activity.event = fit.Event.ACTIVITY
    activity.event_type = fit.EventType.STOP
    activity.local_timestamp = end // 1000 - FIT_EPOCH + workout.utc_offset_minutes * 60
    builder.add(activity)

    return builder.build().to_bytes()


def garmin_upload_result(answer: Any) -> tuple[str | None, str]:
    """(activity id, problem) from what Garmin's upload answers; either may be empty."""
    if hasattr(answer, "json"):
        try:
            answer = answer.json()
        except ValueError:
            answer = None
    result = answer.get("detailedImportResult") if isinstance(answer, dict) else None
    if not isinstance(result, dict):
        return None, ""
    for done in result.get("successes") or []:
        if isinstance(done, dict) and done.get("internalId"):
            return str(done["internalId"]), ""
    for failed in result.get("failures") or []:
        if not isinstance(failed, dict):
            continue
        messages = " ".join(str(message.get("content", "")) for message in failed.get("messages") or [] if isinstance(message, dict)).strip()
        if "duplicate" in messages.lower() and failed.get("internalId"):
            return str(failed["internalId"]), ""  # it is there already: as good as sent
        return None, messages or "Garmin rejected the file"
    return None, ""


def send_to_garmin(request: ExportRequest) -> dict:
    workout = request.workout
    client = garmin_session()
    folder = Path(tempfile.mkdtemp(prefix="gymtracker-fit-"))
    try:
        path = folder / "workout.fit"
        path.write_bytes(build_fit(workout, request.unit))
        try:
            answer = client.upload_activity(str(path))
        except Exception as error:
            # Garmin says "you already have this one" with an error status; its
            # answer is read like any other before the error is taken at its word.
            answer = getattr(error, "response", None)
            if garmin_upload_result(answer) == (None, ""):
                failure = garmin_failure(error)
                if failure.status_code == 401:
                    forget_garmin()
                    raise HTTPException(401, f"Garmin no longer accepts the saved login; {CONNECT_AGAIN}.") from error
                raise failure from error
    finally:
        shutil.rmtree(folder, ignore_errors=True)

    activity_id, problem = garmin_upload_result(answer)
    if problem:
        raise HTTPException(422, f"Garmin didn't take the workout ({problem[:200]}).")
    if not activity_id:
        # Accepted but still being processed: Garmin hasn't said which activity it became.
        return {"id": "", "url": "https://connect.garmin.com/modern/activities"}
    for rename in (lambda: client.set_activity_name(activity_id, title(workout)),
                   lambda: client.set_activity_description(activity_id, describe(workout, request.unit, request.effort))):
        try:  # the activity is in; a missing title or description isn't worth failing over
            rename()
        except Exception:
            pass
    return {"id": activity_id, "url": f"https://connect.garmin.com/modern/activity/{activity_id}"}


# --- the two endpoints the app uses most ---------------------------------------

@router.get("/connections")
def connections() -> dict:
    """Which services finished workouts can go to, and as whom."""
    store = load_store()
    strava = store.get("strava") if isinstance(store.get("strava"), dict) else None
    garmin = store.get("garmin") if isinstance(store.get("garmin"), dict) else None
    return {
        "strava": {"configured": strava_app() is not None, "connected": bool(strava and strava.get("refresh_token")),
                   "account": strava.get("account") if strava else None},
        "garmin": {"configured": True, "connected": bool(garmin) and GARMIN_TOKENS.is_dir(),
                   "account": garmin.get("account") if garmin else None},
    }


@router.post("/exports/{target}")
def export(target: str, request: ExportRequest) -> dict:
    """Sends a finished workout to a service — once: asking again returns what was created the first time."""
    if target not in ("strava", "garmin"):
        raise HTTPException(404, f"There is no connection called “{target}”.")
    workout = request.workout
    if workout.ended_at <= workout.started_at:
        raise HTTPException(422, "That workout has no end time; only finished workouts can be sent.")
    with _sending[target]:
        already = sent_before(workout.id, target)
        if already:
            return {**already, "already": True}
        result = send_to_strava(request) if target == "strava" else send_to_garmin(request)
        result["at"] = int(time.time() * 1000)
        remember_sent(workout.id, target, result)
        return {**result, "already": False}
