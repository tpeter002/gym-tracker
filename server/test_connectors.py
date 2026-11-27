# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi", "fit-tool", "garmin-fit-sdk", "httpx", "pytest"]
# ///
"""Tests for connectors.py: sending finished workouts to Strava and Garmin Connect.

    uv run server/test_connectors.py

Nothing here talks to Strava or Garmin. Strava's API is an in-process stand-in
that records what it is sent; Garmin's library is replaced by a fake; and the
FIT files are read back with Garmin's own FIT SDK to check they are valid.
"""

from __future__ import annotations

import json
import stat
import sys
import threading
import urllib.parse
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from garmin_fit_sdk import Decoder, Stream

import connectors

START = 1_795_712_400_000  # 2026-11-26 17:00:00 UTC, in milliseconds
WORKOUT = {
    "id": "workout-1",
    "name": "Push",
    "started_at": START,
    "ended_at": START + 62 * 60_000,
    "utc_offset_minutes": 60,
    "notes": "Felt strong.",
    "exercises": [
        {"name": "Bench Press (Barbell)", "muscle": "chest", "sets": [
            {"weight": 40, "reps": 10, "rpe": None, "warmup": True},
            {"weight": 87.5, "reps": 8, "rpe": 7.5, "warmup": False},
            {"weight": 87.5, "reps": 7, "rpe": None, "warmup": False},
        ]},
        {"name": "Pull Up", "muscle": "back", "sets": [{"weight": None, "reps": 9, "rpe": 9, "warmup": False}]},
        {"name": "Half-Kneeling Cable Y Raise", "muscle": "shoulders", "sets": [{"weight": 7.5, "reps": None, "rpe": None, "warmup": False}]},
    ],
}
DESCRIPTION = """\
Bench Press (Barbell)
Warm-up: 40 kg × 10
Set 1: 87.5 kg × 8 @ RPE 7.5
Set 2: 87.5 kg × 7

Pull Up
Set 1: 9 reps @ RPE 9

Half-Kneeling Cable Y Raise
Set 1: 7.5 kg

Felt strong.

Logged by my own app automatically"""


def request_for(workout: dict = WORKOUT, **settings) -> connectors.ExportRequest:
    return connectors.ExportRequest(workout=workout, **settings)


@pytest.fixture(autouse=True)
def clean_slate(monkeypatch, tmp_path):
    """Each test starts with nothing connected, nothing sent and no Strava application configured."""
    monkeypatch.setattr(connectors, "STORE", tmp_path / "connections.json")
    monkeypatch.setattr(connectors, "GARMIN_TOKENS", tmp_path / "garmin-tokens")
    monkeypatch.delenv("STRAVA_CLIENT_ID", raising=False)
    monkeypatch.delenv("STRAVA_CLIENT_SECRET", raising=False)
    connectors._strava_states.clear()
    connectors._garmin_waiting.clear()


class Strava:
    """Stands in for strava.com: answers by path and keeps every request."""

    def __init__(self, monkeypatch) -> None:
        self.requests: list[httpx.Request] = []
        self.answers: dict[str, tuple[int, object]] = {
            "/oauth/token": (200, {"access_token": "access-1", "refresh_token": "refresh-1", "expires_at": 4_000_000_000,
                                   "athlete": {"firstname": "Sam", "lastname": "Lifter"}}),
            "/api/v3/activities": (201, {"id": 987654321, "name": "Push"}),
            "/oauth/deauthorize": (200, {"access_token": "access-1"}),
        }
        self.failure: Exception | None = None
        monkeypatch.setattr(connectors, "http_client", lambda: httpx.Client(transport=httpx.MockTransport(self.handle)))

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.failure:
            raise self.failure
        status, body = self.answers[request.url.path]
        return httpx.Response(status, json=body) if not isinstance(body, str) else httpx.Response(status, text=body)

    def form(self, index: int = -1) -> dict:
        return dict(urllib.parse.parse_qsl(self.requests[index].content.decode()))

    def paths(self) -> list[str]:
        return [request.url.path for request in self.requests]


@pytest.fixture
def strava(monkeypatch) -> Strava:
    monkeypatch.setenv("STRAVA_CLIENT_ID", "4242")
    monkeypatch.setenv("STRAVA_CLIENT_SECRET", "app-secret")
    return Strava(monkeypatch)


@pytest.fixture
def service() -> TestClient:
    app = FastAPI()
    app.include_router(connectors.router)
    return TestClient(app, follow_redirects=False)


def connect_strava(service: TestClient, back: str | None = None) -> httpx.Response:
    """Goes through Strava's approval as someone who says yes."""
    params = {"back": back} if back else {}
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(service.get("/strava/connect", params=params).headers["location"]).query)["state"][0]
    return service.get("/strava/callback", params={"state": state, "code": "the-code", "scope": "read,activity:write"})


def export(service: TestClient, target: str = "strava", workout: dict = WORKOUT, **settings) -> httpx.Response:
    return service.post(f"/exports/{target}", json={"workout": workout, **settings})


# --- the workout in words -------------------------------------------------------

def test_the_description_lists_every_exercise_and_set_and_ends_with_the_signature():
    assert connectors.describe(request_for().workout, "kg", "rpe") == DESCRIPTION


def test_the_description_follows_the_apps_units():
    text = connectors.describe(request_for().workout, "lb", "rir")
    assert "Warm-up: 88.2 lb × 10" in text
    assert "Set 1: 192.9 lb × 8 @ 2.5 RIR" in text
    assert "Set 1: 9 reps @ 1 RIR" in text
    assert "Set 1: 16.5 lb" in text


def test_a_workout_with_nothing_special_still_reads_well():
    bare = {**WORKOUT, "notes": "  ", "exercises": [{"name": "Plank", "sets": [{}]}]}
    assert connectors.describe(request_for(bare).workout, "kg", "rpe") == "Plank\nSet 1: done\n\nLogged by my own app automatically"
    empty = {**WORKOUT, "notes": "", "exercises": []}
    assert connectors.describe(request_for(empty).workout, "kg", "rpe") == "Logged by my own app automatically"


def test_numbers_drop_needless_zeros():
    assert [connectors.number(value) for value in (100.0, 87.5, 2.25, 0.126, 60.10)] == ["100", "87.5", "2.25", "0.13", "60.1"]


def test_title_duration_and_local_start():
    workout = request_for().workout
    assert connectors.title(workout) == "Push"
    assert connectors.title(request_for({**WORKOUT, "name": "  "}).workout) == "Workout"
    assert connectors.seconds_long(workout) == 62 * 60
    assert connectors.local_start(workout) == "2026-11-26T18:00:00"  # 17:00 UTC on a clock one hour ahead
    assert connectors.local_start(request_for({**WORKOUT, "utc_offset_minutes": -480}).workout) == "2026-11-26T09:00:00"


# --- connecting Strava ----------------------------------------------------------

def test_nothing_is_connected_to_begin_with(service):
    assert service.get("/connections").json() == {
        "strava": {"configured": False, "connected": False, "account": None},
        "garmin": {"configured": True, "connected": False, "account": None},
    }


def test_strava_needs_its_application_in_the_env_file_first(service):
    response = service.get("/strava/connect")
    assert response.status_code == 409
    assert "STRAVA_CLIENT_ID" in response.json()["detail"]
    assert export(service).status_code == 409


def test_connecting_sends_the_browser_to_strava(service, strava):
    response = service.get("/strava/connect", params={"back": "/#/settings"})
    assert response.status_code == 302
    address = urllib.parse.urlsplit(response.headers["location"])
    assert f"{address.scheme}://{address.netloc}{address.path}" == "https://www.strava.com/oauth/authorize"
    query = dict(urllib.parse.parse_qsl(address.query))
    state = query.pop("state")
    assert len(state) >= 24
    assert query == {
        "client_id": "4242",
        "redirect_uri": "http://testserver/strava/callback",
        "response_type": "code",
        "approval_prompt": "auto",
        "scope": "activity:write",
    }
    assert "app-secret" not in response.headers["location"]
    assert strava.requests == []  # nothing is sent to Strava from here; the browser goes there


def test_approval_stores_the_tokens_and_returns_to_the_app(service, strava):
    response = connect_strava(service, back="/#/settings")
    assert response.status_code == 302
    assert response.headers["location"] == "/?strava=connected#/settings"
    assert strava.form() == {"client_id": "4242", "client_secret": "app-secret", "code": "the-code", "grant_type": "authorization_code"}
    assert str(strava.requests[-1].url) == "https://www.strava.com/oauth/token"

    assert service.get("/connections").json()["strava"] == {"configured": True, "connected": True, "account": "Sam Lifter"}
    saved = json.loads(connectors.STORE.read_text())["strava"]
    assert saved == {"account": "Sam Lifter", "access_token": "access-1", "refresh_token": "refresh-1", "expires_at": 4_000_000_000}
    assert stat.S_IMODE(connectors.STORE.stat().st_mode) == 0o600  # tokens: for the owner's eyes only


def test_a_sign_in_can_be_used_once_and_only_if_it_started_here(service, strava):
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(service.get("/strava/connect").headers["location"]).query)["state"][0]
    assert service.get("/strava/callback", params={"state": "made-up", "code": "x", "scope": "activity:write"}).status_code == 400
    assert service.get("/strava/callback", params={"state": state, "code": "x", "scope": "activity:write"}).status_code == 302
    assert service.get("/strava/callback", params={"state": state, "code": "x", "scope": "activity:write"}).status_code == 400


def test_an_expired_sign_in_is_refused(service, strava, monkeypatch):
    state = urllib.parse.parse_qs(urllib.parse.urlsplit(service.get("/strava/connect").headers["location"]).query)["state"][0]
    later = connectors.time.time() + 3600
    monkeypatch.setattr(connectors.time, "time", lambda: later)
    assert service.get("/strava/callback", params={"state": state, "code": "x", "scope": "activity:write"}).status_code == 400
    assert strava.requests == []


def test_saying_no_or_unticking_uploads_connects_nothing(service, strava):
    for params, outcome in [({"error": "access_denied"}, "denied"), ({"code": "c", "scope": "read"}, "no-upload-permission")]:
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(service.get("/strava/connect").headers["location"]).query)["state"][0]
        response = service.get("/strava/callback", params={"state": state, **params})
        assert response.headers["location"] == f"/?strava={outcome}#/settings"
    assert strava.requests == []
    assert service.get("/connections").json()["strava"]["connected"] is False


def test_the_way_back_can_only_lead_into_the_app(service, strava):
    for unsafe in ("https://evil.example/", "//evil.example/", "javascript:alert(1)"):
        assert connect_strava(service, back=unsafe).headers["location"] == "/?strava=connected#/settings"
    assert connect_strava(service, back="/gym/?x=1#/settings").headers["location"] == "/gym/?x=1&strava=connected#/settings"


def test_a_refused_code_is_explained(service, strava):
    strava.answers["/oauth/token"] = (400, {"message": "Bad Request", "errors": [{"resource": "Application", "field": "client_id", "code": "invalid"}]})
    response = connect_strava(service)
    assert response.status_code == 502
    assert response.json()["detail"] == ("Strava refused the sign-in (Bad Request — Application client_id invalid). "
                                         "Check STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in server/.env.")
    assert service.get("/connections").json()["strava"]["connected"] is False


def test_disconnecting_tells_strava_and_forgets_the_tokens(service, strava):
    connect_strava(service)
    assert service.post("/strava/disconnect").json()["strava"] == {"configured": True, "connected": False, "account": None}
    assert strava.paths()[-1] == "/oauth/deauthorize"
    assert strava.form() == {"access_token": "access-1"}
    assert "strava" not in json.loads(connectors.STORE.read_text())


def test_disconnecting_works_when_strava_cannot_be_reached(service, strava):
    connect_strava(service)
    strava.failure = httpx.ConnectError("offline")
    assert service.post("/strava/disconnect").json()["strava"]["connected"] is False


# --- sending to Strava ----------------------------------------------------------

def test_a_workout_becomes_a_weight_training_activity_with_the_sets_in_its_description(service, strava):
    connect_strava(service)
    response = export(service)
    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["url"], body["already"]) == ("987654321", "https://www.strava.com/activities/987654321", False)
    assert body["at"] > 0

    sent = strava.requests[-1]
    assert (sent.method, str(sent.url)) == ("POST", "https://www.strava.com/api/v3/activities")
    assert sent.headers["authorization"] == "Bearer access-1"
    assert strava.form() == {
        "name": "Push",
        "sport_type": "WeightTraining",
        "start_date_local": "2026-11-26T18:00:00",
        "elapsed_time": "3720",
        "description": DESCRIPTION,
    }


def test_the_same_workout_is_never_posted_twice(service, strava):
    connect_strava(service)
    first = export(service).json()
    posted = len(strava.requests)
    again = export(service).json()
    assert again == {**first, "already": True}
    assert len(strava.requests) == posted  # Strava wasn't asked a second time
    # A different workout is its own activity.
    strava.answers["/api/v3/activities"] = (201, {"id": 111})
    assert export(service, workout={**WORKOUT, "id": "workout-2"}).json()["id"] == "111"


def test_units_and_effort_scale_come_from_the_app(service, strava):
    connect_strava(service)
    export(service, unit="lb", effort="rir")
    assert "Set 1: 192.9 lb × 8 @ 2.5 RIR" in strava.form()["description"]


def test_an_expired_token_is_renewed_first_and_the_new_one_kept(service, strava, monkeypatch):
    connect_strava(service)
    saved = json.loads(connectors.STORE.read_text())
    saved["strava"]["expires_at"] = 1_000  # long ago
    connectors.STORE.write_text(json.dumps(saved))
    strava.answers["/oauth/token"] = (200, {"access_token": "access-2", "refresh_token": "refresh-2", "expires_at": 4_100_000_000})
    strava.requests.clear()

    assert export(service).status_code == 200
    assert strava.paths() == ["/oauth/token", "/api/v3/activities"]
    assert strava.form(0) == {"client_id": "4242", "client_secret": "app-secret", "grant_type": "refresh_token", "refresh_token": "refresh-1"}
    assert strava.requests[1].headers["authorization"] == "Bearer access-2"
    saved = json.loads(connectors.STORE.read_text())["strava"]
    assert (saved["access_token"], saved["refresh_token"], saved["expires_at"], saved["account"]) == ("access-2", "refresh-2", 4_100_000_000, "Sam Lifter")


def test_a_connection_strava_has_revoked_is_dropped_and_said_so(service, strava):
    connect_strava(service)
    saved = json.loads(connectors.STORE.read_text())
    saved["strava"]["expires_at"] = 1_000
    connectors.STORE.write_text(json.dumps(saved))
    strava.answers["/oauth/token"] = (400, {"message": "Bad Request"})
    response = export(service)
    assert (response.status_code, response.json()["detail"]) == (
        401, "Strava no longer accepts this connection; connect again in the app under Settings → Connections.")
    assert service.get("/connections").json()["strava"]["connected"] is False


@pytest.mark.parametrize("status, body, expected_status, expected", [
    (401, {"message": "Authorization Error"}, 401,
     "Strava no longer accepts this connection; connect again in the app under Settings → Connections."),
    (403, {"message": "Forbidden", "errors": [{"resource": "AccessToken", "field": "activity:write_permission", "code": "missing"}]}, 403,
     "Strava didn't allow adding an activity. Connect again and leave “Upload your activities” ticked. "
     "(Forbidden — AccessToken activity:write_permission missing)"),
    (429, {"message": "Rate Limit Exceeded"}, 429, "Strava's rate limit was hit; the workout will be sent later."),
    (500, "<html>oops</html>", 502, "Strava didn't take the workout (500)"),
    # A request Strava will never take is a different failure from Strava having a bad moment.
    (400, {"message": "Bad Request", "errors": [{"resource": "Activity", "field": "elapsed_time", "code": "invalid"}]}, 422,
     "Strava didn't take the workout (400) (Bad Request — Activity elapsed_time invalid)"),
])
def test_what_strava_refuses_is_explained_and_not_counted_as_sent(service, strava, status, body, expected_status, expected):
    connect_strava(service)
    strava.answers["/api/v3/activities"] = (status, body)
    response = export(service)
    assert (response.status_code, response.json()["detail"]) == (expected_status, expected)
    stored = json.loads(connectors.STORE.read_text()) if connectors.STORE.exists() else {}  # gone after a 401
    assert "exports" not in stored
    # Once Strava takes it, the same request goes through.
    if status != 401:
        strava.answers["/api/v3/activities"] = (201, {"id": 5})
        assert export(service).json()["id"] == "5"


def test_strava_out_of_reach_is_a_temporary_failure(service, strava):
    connect_strava(service)
    strava.failure = httpx.ConnectError("offline")
    response = export(service)
    assert (response.status_code, response.json()["detail"]) == (502, "The analyzer couldn't reach Strava.")


def test_sending_needs_a_connection_and_a_finished_workout(service, strava):
    response = export(service)
    assert (response.status_code, response.json()["detail"]) == (
        409, "Strava isn't connected; connect again in the app under Settings → Connections.")
    connect_strava(service)
    assert export(service, workout={**WORKOUT, "ended_at": WORKOUT["started_at"]}).status_code == 422
    assert export(service, target="fitbit").status_code == 404
    assert export(service, workout={**WORKOUT, "exercises": [{"name": "x", "sets": [{}] * 201}]}).status_code == 422
    assert export(service, workout={**WORKOUT, "id": ""}).status_code == 422
    assert strava.paths().count("/api/v3/activities") == 0


# --- Garmin: the file -----------------------------------------------------------

def read_fit(data: bytes) -> dict:
    assert Decoder(Stream.from_byte_array(bytearray(data))).check_integrity()
    messages, errors = Decoder(Stream.from_byte_array(bytearray(data))).read()
    assert errors == []
    return messages


@pytest.mark.parametrize("name, muscle, category", [
    ("Bench Press (Barbell)", "chest", "BENCH_PRESS"),
    ("Incline Bench Press (Dumbbell)", "chest", "BENCH_PRESS"),
    ("Squat (Barbell)", "quads", "SQUAT"),
    ("Bulgarian Split Squat (Dumbbell)", "quads", "LUNGE"),
    ("Romanian Deadlift (Barbell)", "hamstrings", "DEADLIFT"),
    ("Seated Leg Curl (Machine)", "hamstrings", "LEG_CURL"),
    ("Bicep Curl (Dumbbell)", "biceps", "CURL"),
    ("Pull Up", "back", "PULL_UP"),
    ("Lat Pulldown (Cable)", "back", "PULL_UP"),
    ("Bent Over Row (Barbell)", "back", "ROW"),
    ("Overhead Press (Dumbbell)", "shoulders", "SHOULDER_PRESS"),
    ("Lateral Raise (Dumbbell)", "shoulders", "LATERAL_RAISE"),
    ("Face Pull (Cable)", "shoulders", "SHOULDER_STABILITY"),
    ("Triceps Rope Pushdown (Cable)", "triceps", "TRICEPS_EXTENSION"),
    ("Triceps Kickback (Dumbbell)", "triceps", "TRICEPS_EXTENSION"),
    ("Glute Kickback (Cable)", "glutes", "HIP_RAISE"),
    ("Hip Thrust (Barbell)", "glutes", "HIP_RAISE"),
    ("Standing Calf Raise (Machine)", "calves", "CALF_RAISE"),
    ("Chest Fly (Cable)", "chest", "FLYE"),
    ("Plank", "core", "PLANK"),
    ("Dead Bug", "core", "CORE"),
    ("Wall Sit", "quads", None),
    ("Half-Kneeling Cable Y Raise", "shoulders", None),
])
def test_exercises_find_their_garmin_category_by_name(name, muscle, category):
    assert connectors.garmin_category(name, muscle) == category


def test_an_exercise_garmin_lists_under_the_same_words_gets_its_exact_number():
    from fit_tool.profile import profile_type as fit
    assert connectors.garmin_exercise_name("PULL_UP", "Pull Up") == fit.PullUpExerciseName.PULL_UP.value
    assert connectors.garmin_exercise_name("PLANK", "Plank") == fit.PlankExerciseName.PLANK.value
    assert connectors.garmin_exercise_name("BENCH_PRESS", "Some Press Nobody Lists") is None
    assert connectors.garmin_exercise_name("NOT_A_CATEGORY", "Pull Up") is None


def test_the_fit_file_is_a_strength_session_with_every_set():
    messages = read_fit(connectors.build_fit(request_for().workout, "kg"))

    file_id = messages["file_id_mesgs"][0]
    assert (file_id["type"], file_id["manufacturer"]) == ("activity", "development")
    session = messages["session_mesgs"][0]
    assert (session["sport"], session["sub_sport"]) == ("training", "strength_training")
    assert (session["total_elapsed_time"], session["total_timer_time"], session["num_laps"]) == (3720, 3720, 1)
    assert session["start_time"].timestamp() * 1000 == START
    assert messages["lap_mesgs"][0]["sub_sport"] == "strength_training"
    activity = messages["activity_mesgs"][0]
    assert (activity["type"], activity["num_sessions"], activity["total_timer_time"]) == ("manual", 1, 3720)
    # One hour ahead of UTC, in the FIT format's seconds since the end of 1989.
    assert activity["local_timestamp"] == (START // 1000 + 3720) - 631065600 + 3600

    sets = messages["set_mesgs"]
    assert [(item.get("repetitions"), item.get("weight")) for item in sets] == [(10, 40), (8, 87.5), (7, 87.5), (9, None), (None, 7.5)]
    assert {item["set_type"] for item in sets} == {"active"}
    assert {item["weight_display_unit"] for item in sets} == {"kilogram"}
    assert [item.get("category") for item in sets] == ["bench_press"] * 3 + ["pull_up", None]
    assert [item["wkt_step_index"] for item in sets] == [0, 0, 0, 1, 2]
    # Spread over the workout in order, each inside it.
    starts = [item["start_time"].timestamp() * 1000 for item in sets]
    assert starts == sorted(starts) and starts[0] == START and starts[-1] < START + 3720_000
    assert all(1 <= item["duration"] <= 90 for item in sets)

    titles = messages["exercise_title_mesgs"]
    assert [title["wkt_step_name"] for title in titles] == ["Bench Press (Barbell)", "Pull Up", "Half-Kneeling Cable Y Raise"]
    assert [title.get("exercise_category") for title in titles] == ["bench_press", "pull_up", None]
    assert [event["event_type"] for event in messages["event_mesgs"]] == ["start", "stop_all"]


def test_the_fit_file_shows_pounds_when_the_app_does_and_stores_kilograms():
    sets = read_fit(connectors.build_fit(request_for().workout, "lb"))["set_mesgs"]
    assert {item["weight_display_unit"] for item in sets} == {"pound"}
    assert sets[1]["weight"] == 87.5


def test_a_workout_without_sets_is_still_a_valid_file():
    messages = read_fit(connectors.build_fit(request_for({**WORKOUT, "exercises": []}).workout, "kg"))
    assert "set_mesgs" not in messages
    assert messages["session_mesgs"][0]["sub_sport"] == "strength_training"


def test_the_file_identifies_its_workout_so_garmin_recognises_a_repeat():
    def serial(workout_id: str) -> int:
        return read_fit(connectors.build_fit(request_for({**WORKOUT, "id": workout_id}).workout, "kg"))["file_id_mesgs"][0]["serial_number"]
    assert serial("workout-1") == serial("workout-1")
    assert serial("workout-1") != serial("workout-2")


# --- Garmin: the account --------------------------------------------------------

class GarminConnectAuthenticationError(Exception):
    pass


class GarminConnectTooManyRequestsError(Exception):
    pass


class GarminConnectConnectionError(Exception):
    """Like the library's: `response` is Garmin's answer when the error stands for one."""

    def __init__(self, message: str, response: httpx.Response | None = None) -> None:
        super().__init__(message)
        self.response = response


class Garmin:
    """Stands in for the garminconnect library and for Garmin behind it."""

    def __init__(self, monkeypatch) -> None:
        self.password = "correct-horse"
        self.needs_code = False
        self.tokens_work = True
        self.login_error: Exception | None = None
        self.upload_error: Exception | None = None
        self.upload_answer: object = {"detailedImportResult": {"successes": [{"internalId": 555001}], "failures": []}}
        self.uploads: list[tuple[str, bytes]] = []
        self.renamed: list[tuple[str, str, str]] = []
        self.logins: list[tuple] = []
        monkeypatch.setattr(connectors, "new_garmin", self.new_client)

    def new_client(self, email=None, password=None):
        world = self

        class Client:
            def __init__(self) -> None:
                self.client = SimpleNamespace(dump=lambda path: (Path(path) / "garmin_tokens.json").write_text('{"token": "t-1"}'))

            def login(self, tokenstore=None):
                world.logins.append((email, bool(password), tokenstore))
                if world.login_error:
                    raise world.login_error
                if tokenstore:
                    if not world.tokens_work or not (Path(tokenstore) / "garmin_tokens.json").exists():
                        raise GarminConnectAuthenticationError("token rejected")
                    return None, None
                if password != world.password:
                    raise GarminConnectAuthenticationError("Invalid credentials")
                return ("needs_mfa", {"session": "cookie"}) if world.needs_code else (None, None)

            def resume_login(self, state, code):
                world.logins.append(("resume", state, code))
                if code != "123456":
                    raise GarminConnectAuthenticationError("Wrong code")
                return None, None

            def get_full_name(self):
                return "Sam Lifter"

            def upload_activity(self, path):
                world.uploads.append((Path(path).name, Path(path).read_bytes()))
                if world.upload_error:
                    raise world.upload_error
                return world.upload_answer

            def set_activity_name(self, activity_id, name):
                world.renamed.append(("name", activity_id, name))

            def set_activity_description(self, activity_id, text):
                world.renamed.append(("description", activity_id, text))

        return Client()


@pytest.fixture
def garmin(monkeypatch) -> Garmin:
    return Garmin(monkeypatch)


def connect_garmin(service: TestClient, **fields) -> httpx.Response:
    return service.post("/garmin/connect", json={"email": "sam@example.org", "password": "correct-horse", **fields})


def test_connecting_garmin_keeps_tokens_and_never_the_password(service, garmin):
    response = connect_garmin(service)
    assert response.status_code == 200
    assert response.json()["garmin"] == {"configured": True, "connected": True, "account": "Sam Lifter"}
    assert (connectors.GARMIN_TOKENS / "garmin_tokens.json").exists()
    assert stat.S_IMODE(connectors.GARMIN_TOKENS.stat().st_mode) == 0o700
    everything = connectors.STORE.read_text() + "".join(path.read_text() for path in connectors.GARMIN_TOKENS.iterdir())
    assert "correct-horse" not in everything and "sam@example.org" not in everything


def test_a_wrong_password_connects_nothing(service, garmin):
    response = connect_garmin(service, password="nope")
    assert (response.status_code, response.json()["detail"]) == (401, "Garmin didn't accept the login (Invalid credentials).")
    assert service.get("/connections").json()["garmin"]["connected"] is False
    assert service.post("/garmin/connect", json={"email": "", "password": ""}).status_code == 422


def test_garmin_limiting_sign_ins_is_said_plainly(service, garmin):
    garmin.login_error = GarminConnectTooManyRequestsError("429")
    response = connect_garmin(service)
    assert (response.status_code, response.json()["detail"]) == (429, "Garmin is limiting requests from here right now; try again in an hour.")


def test_a_verification_code_finishes_the_sign_in(service, garmin):
    garmin.needs_code = True
    first = connect_garmin(service)
    assert first.status_code == 409
    assert first.headers["x-needs-code"] == "1"
    assert "verification code" in first.json()["detail"]
    assert service.get("/connections").json()["garmin"]["connected"] is False

    wrong = service.post("/garmin/connect", json={"mfa_code": "000000"})
    assert wrong.status_code == 401
    # A failed code ends that attempt; the next one starts from the password again.
    assert service.post("/garmin/connect", json={"mfa_code": "123456"}).status_code == 409

    connect_garmin(service)
    done = service.post("/garmin/connect", json={"mfa_code": " 123456 "})
    assert done.json()["garmin"]["connected"] is True
    assert garmin.logins[-1] == ("resume", {"session": "cookie"}, "123456")


def test_a_code_without_a_sign_in_waiting_is_refused(service, garmin):
    response = service.post("/garmin/connect", json={"mfa_code": "123456"})
    assert (response.status_code, response.json()["detail"]) == (409, "That sign-in has expired; enter your email and password again.")


def test_disconnecting_garmin_removes_the_tokens(service, garmin):
    connect_garmin(service)
    assert service.post("/garmin/disconnect").json()["garmin"] == {"configured": True, "connected": False, "account": None}
    assert not connectors.GARMIN_TOKENS.exists()
    assert export(service, "garmin").status_code == 409


# --- sending to Garmin ----------------------------------------------------------

def test_a_workout_goes_to_garmin_as_a_fit_file_with_its_name_and_description(service, garmin):
    connect_garmin(service)
    response = export(service, "garmin")
    assert response.status_code == 200
    body = response.json()
    assert (body["id"], body["url"], body["already"]) == ("555001", "https://connect.garmin.com/modern/activity/555001", False)

    assert garmin.logins[-1] == (None, False, str(connectors.GARMIN_TOKENS))  # signed in with the saved tokens, no password
    (filename, data), = garmin.uploads
    assert filename.endswith(".fit")
    sets = read_fit(data)["set_mesgs"]
    assert [(item.get("repetitions"), item.get("weight")) for item in sets] == [(10, 40), (8, 87.5), (7, 87.5), (9, None), (None, 7.5)]
    assert garmin.renamed == [("name", "555001", "Push"), ("description", "555001", DESCRIPTION)]


def test_garmin_gets_each_workout_once_too(service, garmin):
    connect_garmin(service)
    first = export(service, "garmin").json()
    assert export(service, "garmin").json() == {**first, "already": True}
    assert len(garmin.uploads) == 1


def test_strava_and_garmin_are_tracked_separately(service, strava, garmin):
    connect_strava(service)
    connect_garmin(service)
    assert export(service, "strava").json()["already"] is False
    assert export(service, "garmin").json()["already"] is False
    sent = json.loads(connectors.STORE.read_text())["exports"]["workout-1"]
    assert sorted(sent) == ["garmin", "strava"]


def test_a_file_garmin_already_has_counts_as_sent(service, garmin):
    connect_garmin(service)
    garmin.upload_answer = {"detailedImportResult": {"successes": [], "failures": [
        {"internalId": 555001, "messages": [{"code": 202, "content": "Duplicate Activity."}]}]}}
    assert export(service, "garmin").json()["id"] == "555001"


def test_a_file_garmin_rejects_is_explained_and_can_be_sent_again(service, garmin):
    connect_garmin(service)
    garmin.upload_answer = {"detailedImportResult": {"successes": [], "failures": [{"messages": [{"content": "Unsupported file."}]}]}}
    response = export(service, "garmin")
    assert (response.status_code, response.json()["detail"]) == (422, "Garmin didn't take the workout (Unsupported file.).")
    garmin.upload_answer = {"detailedImportResult": {"successes": [{"internalId": 7}]}}
    assert export(service, "garmin").json()["id"] == "7"


def test_an_upload_garmin_is_still_processing_is_sent_without_a_link_to_it(service, garmin):
    connect_garmin(service)
    garmin.upload_answer = SimpleNamespace(json=lambda: {"detailedImportResult": {"successes": [], "failures": []}})
    body = export(service, "garmin").json()
    assert (body["id"], body["url"]) == ("", "https://connect.garmin.com/modern/activities")
    assert garmin.renamed == []


def test_saved_garmin_tokens_that_stopped_working_end_the_connection(service, garmin):
    connect_garmin(service)
    garmin.tokens_work = False
    response = export(service, "garmin")
    assert (response.status_code, response.json()["detail"]) == (
        401, "Garmin no longer accepts the saved login; connect again in the app under Settings → Connections.")
    assert service.get("/connections").json()["garmin"]["connected"] is False


def test_garmin_out_of_reach_or_busy_keeps_the_connection(service, garmin):
    connect_garmin(service)
    garmin.upload_error = GarminConnectConnectionError("timed out")
    response = export(service, "garmin")
    assert (response.status_code, response.json()["detail"]) == (502, "Garmin Connect couldn't be reached (timed out).")
    garmin.upload_error = GarminConnectTooManyRequestsError("slow down")
    assert export(service, "garmin").status_code == 429
    assert service.get("/connections").json()["garmin"]["connected"] is True


def garmin_said(status: int, body: object = None) -> GarminConnectConnectionError:
    """The error the library raises for any answer of 400 and up."""
    answer = httpx.Response(status, json=body) if body is not None else httpx.Response(status, text="")
    return GarminConnectConnectionError(f"HTTP {status}", response=answer)


def test_garmin_saying_no_is_not_garmin_being_out_of_reach(service, garmin):
    connect_garmin(service)
    # The library calls every error status a connection error; a request Garmin refuses will never go through.
    garmin.upload_error = garmin_said(400)
    response = export(service, "garmin")
    assert (response.status_code, response.json()["detail"]) == (422, "Garmin Connect refused the request (400: HTTP 400).")
    for status, expected in ((500, 502), (503, 502), (408, 502), (429, 429)):  # these do pass by themselves
        garmin.upload_error = garmin_said(status)
        assert export(service, "garmin").status_code == expected
    assert service.get("/connections").json()["garmin"]["connected"] is True
    # Nothing was counted as sent along the way.
    garmin.upload_error = None
    assert export(service, "garmin").json()["already"] is False


def test_garmin_refusing_the_login_on_an_upload_asks_to_connect_again(service, garmin):
    connect_garmin(service)
    garmin.upload_error = garmin_said(401)
    response = export(service, "garmin")
    assert response.status_code == 401
    assert "Garmin no longer accepts the saved login" in response.json()["detail"]
    assert service.get("/connections").json()["garmin"]["connected"] is False


def test_a_workout_garmin_already_has_counts_as_sent_even_when_garmin_says_so_with_an_error(service, garmin):
    connect_garmin(service)
    duplicate = {"detailedImportResult": {"successes": [], "failures": [
        {"internalId": 555001, "messages": [{"code": 202, "content": "Duplicate Activity."}]}]}}
    garmin.upload_error = garmin_said(409, duplicate)
    response = export(service, "garmin")
    assert response.status_code == 200
    assert response.json()["id"] == "555001"
    # A refusal that explains itself is passed on in Garmin's words, and is final.
    garmin.upload_error = garmin_said(409, {"detailedImportResult": {"successes": [], "failures": [
        {"messages": [{"content": "The file is corrupt."}]}]}})
    refused = export(service, "garmin", workout={**WORKOUT, "id": "workout-2"})
    assert (refused.status_code, refused.json()["detail"]) == (422, "Garmin didn't take the workout (The file is corrupt.).")


def test_a_failed_title_does_not_undo_a_successful_upload(service, garmin, monkeypatch):
    connect_garmin(service)
    original = garmin.new_client

    def flaky(email=None, password=None):
        client = original(email, password)
        client.set_activity_name = lambda *_: (_ for _ in ()).throw(GarminConnectConnectionError("hiccup"))
        return client

    monkeypatch.setattr(connectors, "new_garmin", flaky)
    assert export(service, "garmin").json()["id"] == "555001"


# --- many requests at once, and requests that make no sense ----------------------

def test_requests_arriving_together_lose_nothing_from_the_store():
    problems: list[Exception] = []

    def remember(worker: int) -> None:
        try:
            for number in range(25):
                connectors.remember_sent(f"workout-{worker}-{number}", "strava", {"id": str(number)})
        except Exception as problem:  # whatever goes wrong here is what the test is about
            problems.append(problem)

    workers = [threading.Thread(target=remember, args=(worker,)) for worker in range(8)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()

    assert problems == []
    assert len(connectors.load_store()["exports"]) == 8 * 25
    assert [path.name for path in connectors.STORE.parent.iterdir()] == ["connections.json"]  # no half-written files left
    assert stat.S_IMODE(connectors.STORE.stat().st_mode) == 0o600


def test_the_same_workout_asked_for_twice_at_once_is_posted_once(service, strava):
    connect_strava(service)
    strava_may_answer = threading.Event()
    arrived = [threading.Event(), threading.Event()]  # the first post to reach Strava, and a second one
    answer = strava.handle

    def slow(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/v3/activities":
            arrived[1 if arrived[0].is_set() else 0].set()
            assert strava_may_answer.wait(5)
        return answer(request)

    strava.handle = slow  # the stand-in looks its handler up for every request
    answers: list[dict] = []
    # The app's retry after its own timeout, while the first request is still with Strava.
    requests = [threading.Thread(target=lambda: answers.append(export(service).json())) for _ in range(2)]
    requests[0].start()
    assert arrived[0].wait(5)
    requests[1].start()
    # Given every chance to, the second request does not reach Strava while the first is there.
    assert not arrived[1].wait(0.5)
    strava_may_answer.set()
    for request in requests:
        request.join()

    assert strava.paths().count("/api/v3/activities") == 1
    assert sorted(answer["already"] for answer in answers) == [False, True]
    assert {answer["id"] for answer in answers} == {"987654321"}


@pytest.mark.parametrize("change", [
    {"started_at": 10 ** 18}, {"ended_at": 10 ** 18}, {"started_at": 0}, {"started_at": -5},
    {"utc_offset_minutes": 10 ** 9}, {"utc_offset_minutes": -900},
    {"exercises": [{"name": "Bench Press (Barbell)", "sets": [{"weight": -40, "reps": 5}]}]},
    {"exercises": [{"name": "Bench Press (Barbell)", "sets": [{"weight": 40, "reps": -5}]}]},
    {"exercises": [{"name": "Bench Press (Barbell)", "sets": [{"weight": 1e9, "reps": 5}]}]},
    {"exercises": [{"name": "Bench Press (Barbell)", "sets": [{"weight": 40, "reps": 5, "rpe": 11}]}]},
])
def test_a_workout_with_impossible_numbers_is_refused_for_good_not_retried_for_ever(service, strava, garmin, change):
    connect_strava(service)
    connect_garmin(service)
    for target in ("strava", "garmin"):
        # 422 is "this will never go through"; a 500 would have the app try again on every visit.
        assert export(service, target, workout={**WORKOUT, **change}).status_code == 422
    assert "/api/v3/activities" not in strava.paths()
    assert garmin.uploads == []


def test_a_damaged_store_file_reads_as_nothing_connected(service):
    connectors.STORE.write_text("{not json")
    assert service.get("/connections").json()["strava"]["connected"] is False
    connectors.STORE.write_text("[1, 2]")
    assert connectors.load_store() == {}


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
