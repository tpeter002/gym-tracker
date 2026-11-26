# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic", "fastapi", "fit-tool", "garminconnect", "httpx", "uvicorn", "yt-dlp"]
# ///
"""Names the exercises in a saved workout video.

POST /analyze {"url": ..., "known_exercises": [...]} downloads the clip with
yt-dlp, samples frames with ffmpeg and asks a vision model which exercises are
shown. The Gym Tracker app calls this from Saved Videos. If the web version has
been built (web/dist), it is served from the same address, so it needs no setup.

The model is Claude unless something else is chosen: in server/.env
(ANALYZER_PROVIDER, ANALYZER_MODEL and that service's API key), or per request
with "provider", "model" and "api_key" — see PROVIDERS below.

    uv run server/analyzer.py                 # start the service on port 8787
    uv run server/analyzer.py --check <url>   # download + frames only, no AI call
    uv run server/test_analyzer.py            # the tests; they call no outside service
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

import anthropic
import httpx
import uvicorn
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

import connectors

PORT = int(os.environ.get("PORT", "8787"))
MODEL_TIMEOUT = 200  # seconds for the model's answer; the apps give a whole analysis 240
# Seconds before a busy model is asked one more time, when there is no other model to ask.
RETRY_WAIT = 5
MAX_VIDEO_SECONDS = 10 * 60  # this is for reels and shorts, not full workout vlogs
MAX_FRAMES = 24
MIN_FRAME_INTERVAL = 1.5  # seconds; denser sampling adds cost without adding exercises
WEB_APP = Path(__file__).resolve().parent.parent / "web" / "dist"

# Must stay in step with MuscleGroup / Equipment in GymTracker/Models/Models.swift
# and MUSCLE_GROUPS / EQUIPMENT in web/src/lib/types.ts.
MUSCLE_GROUPS = ["chest", "back", "shoulders", "biceps", "triceps", "forearms", "core", "quads",
                 "hamstrings", "glutes", "calves", "fullBody", "cardio", "other"]
EQUIPMENT = ["barbell", "dumbbell", "machine", "cable", "bodyweight", "kettlebell", "band", "other"]

# Empty strings stand in for "none" so the schema needs no nullable types.
RESULT_SCHEMA = {
    "type": "object",
    "properties": {
        "exercises": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "library_match": {"type": "string"},
                    "muscle_group": {"type": "string", "enum": MUSCLE_GROUPS},
                    "equipment": {"type": "string", "enum": EQUIPMENT},
                    "notes": {"type": "string"},
                    "sets_reps": {"type": "string"},
                },
                "required": ["name", "library_match", "muscle_group", "equipment", "notes", "sets_reps"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["exercises"],
    "additionalProperties": False,
}



@dataclass(frozen=True)
class Provider:
    """A service whose models can look at the frames."""
    id: str
    label: str  # the company, as it is named in messages
    key_env: str  # the line in server/.env that holds its API key
    default_model: str
    models: tuple[tuple[str, str], ...]  # (id, name) offered in the app's model field
    base_url: str | None = None  # an OpenAI-style chat API; None means the Anthropic SDK
    json_schema: bool = False  # whether that chat API takes response_format: json_schema
    # Models to ask instead, in this order, while the chosen one is too busy or out of
    # quota. Only ever models of the same price class: a free choice must stay free.
    fallbacks: tuple[str, ...] = ()


# In this order: when server/.env names no service, the first one it has a key for is used.
PROVIDERS = {provider.id: provider for provider in (
    Provider("anthropic", "Anthropic", "ANTHROPIC_API_KEY", "claude-opus-5-5", (
        ("claude-opus-5-5", "Claude Opus 5.5"),
        ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
        ("claude-haiku-5-5", "Claude Haiku 5.5"),
    )),
    # Vision models from docs.z.ai (pricing page, November 2026); the Flash one costs nothing.
    Provider("zai", "Z.ai", "ZAI_API_KEY", "glm-4.6v-flash", (
        ("glm-4.6v-flash", "GLM-4.6V Flash — free"),
        ("glm-4.6v-flashx", "GLM-4.6V FlashX"),
        ("glm-4.6v", "GLM-4.6V"),
        ("glm-5.3-flash", "GLM-5.3 Flash"),
        ("glm-5.3-flashx", "GLM-5.3 FlashX"),
    ), base_url="https://api.z.ai/api/paas/v4"),
    # Its model list changes monthly, so /models asks OpenRouter itself; this is the fallback.
    # openrouter/free routes to whichever free model can read images.
    Provider("openrouter", "OpenRouter", "OPENROUTER_API_KEY", "openrouter/free", (
        ("openrouter/free", "Free Models Router — picks a free model that reads images"),
    ), base_url="https://openrouter.ai/api/v1", json_schema=True),
    # Google's OpenAI-style endpoint. These models have a free tier (ai.google.dev pricing,
    # November 2026). No response_format: Gemini's schema dialect differs from RESULT_SCHEMA's.
    Provider("gemini", "Google", "GEMINI_API_KEY", "gemini-3.8-flash", (
        ("gemini-3.8-flash", "Gemini 3.8 Flash — free tier"),
        ("gemini-3-flash-preview", "Gemini 3 Flash Preview — free tier"),
        ("gemini-4-hydrogen", "Gemini 4 Hydrogen — free tier"),
        ("gemini-3.6-flash", "Gemini 3.6 Flash — free tier"),
        ("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite — free tier, less accurate"),
    ), base_url="https://generativelanguage.googleapis.com/v1beta/openai",
        # The free tier's models take turns being "in high demand". The Flash-Lite ones are
        # left out: on a test reel they named the exercise wrongly. 3.6 Flash comes last
        # because it took minutes to answer when the others took well under one.
        fallbacks=("gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash")),
)}

# Server-side fallback after a refusal exists on these only (Haiku 5.5 has none).
CLAUDE_SERVER_FALLBACK = ("claude-opus-5-5", "claude-sonnet-5-5")

MODEL_NAME = re.compile(r"[\w.:/@~+-]{1,200}")

SYSTEM_PROMPT = """\
You identify the exercises in short workout videos that someone saved from Instagram, TikTok or \
YouTube. They want to try these exercises at the gym and log them in a workout tracker, so what \
they need from you is each exercise's standard English name — the one they could search for.

You get frames sampled from the video in chronological order, each preceded by its timestamp, \
plus the video's title and caption, and the list of exercise names already in their tracker.

For each distinct exercise that is demonstrated or listed:
- name: the common gym name, written like the tracker's own entries — "Movement (Equipment)" \
when equipment matters, e.g. "Incline Bench Press (Dumbbell)", otherwise just the movement, \
e.g. "Pull Up". Name the specific variation shown (incline, single-arm, close-grip…), since the \
variation is usually the reason the video was saved.
- library_match: if the exercise is the same movement with the same equipment as an entry in the \
tracker's list, copy that entry exactly; otherwise an empty string. A different variation is not \
a match.
- muscle_group and equipment: the primary muscle worked and the main equipment used.
- notes: one or two short cues on how it is performed in this video — setup, grip, angle, tempo, \
what the creator emphasises. This is what the user will read at the gym.
- sets_reps: the prescription if the caption or on-screen text gives one (e.g. "3 x 10-12"), \
otherwise an empty string.

On-screen text and the caption often name the exercises outright; when they do, prefer them over \
your own reading of the movement. List each exercise once even if it appears in several frames, in \
the order it appears. If the video isn't a workout, or you can't tell what is being performed, \
return an empty list rather than guessing — a wrong name is worse than none."""

# Claude is held to RESULT_SCHEMA by the API. The other services get the same shape
# in words, since not every model behind them enforces a schema.
JSON_INSTRUCTIONS = f"""\
Answer with a single JSON object and nothing else — no explanation, no Markdown fence:
{{"exercises": [{{"name": "…", "library_match": "…", "muscle_group": "…", "equipment": "…", \
"notes": "…", "sets_reps": "…"}}]}}
muscle_group is one of: {", ".join(MUSCLE_GROUPS)}.
equipment is one of: {", ".join(EQUIPMENT)}.
Use an empty string where a field has nothing to say, and {{"exercises": []}} when there is \
nothing to list."""

UNREADABLE_ANSWER = "The model's answer wasn't in the expected format; try again, or pick another model."


class ModelError(Exception):
    """A failure to report to the person using the app; `status` is what /analyze answers with."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


@dataclass(frozen=True)
class ModelChoice:
    provider: Provider
    model: str
    api_key: str | None  # None: none was found (the Anthropic SDK may still find a login of its own)
    own_key: bool  # the key came with the request rather than from server/.env
    asked: bool  # the request named the provider, so it came from the app's model settings


class AnalyzeRequest(BaseModel):
    url: str
    known_exercises: list[str] = []
    # All three are optional: without them the analyzer uses what server/.env says.
    provider: str | None = None
    model: str | None = None
    api_key: str | None = Field(default=None, repr=False)


def load_env_file() -> None:
    """Reads KEY=value lines from server/.env so the API key doesn't have to be exported."""
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        key, separator, value = line.strip().partition("=")
        if separator and key and not key.startswith("#"):
            os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


def download(url: str, workdir: Path) -> tuple[Path, dict]:
    """Fetches the clip (≤720p is plenty for recognising a movement) and its metadata."""
    options = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "outtmpl": str(workdir / "video.%(ext)s"),
        "format": "bv*[height<=720]/b[height<=720]/bv*/b",
    }
    # Instagram usually refuses anonymous downloads; borrowing the login from a
    # browser you're signed in with (safari, chrome, firefox…) gets around that.
    browser = os.environ.get("YTDLP_COOKIES_FROM_BROWSER")
    if browser:
        options["cookiesfrombrowser"] = (browser,)

    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=False)
        duration = info.get("duration")
        if duration and duration > MAX_VIDEO_SECONDS:
            length = f"{int(duration // 60)}:{int(duration % 60):02d}"
            raise ValueError(f"That video is {length} long; this works on short clips "
                             f"(up to {MAX_VIDEO_SECONDS // 60} minutes).")
        ydl.download([url])

    files = [path for path in workdir.glob("video.*") if path.suffix != ".part"]
    if not files:
        raise RuntimeError("The download finished but produced no video file.")
    return files[0], info


def probe_duration(video: Path) -> float:
    output = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(video)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(output)


def extract_frames(video: Path, workdir: Path) -> list[tuple[float, Path]]:
    """Evenly spaced frames as (timestamp, jpeg path), longest edge capped at 768px."""
    duration = probe_duration(video)
    interval = max(MIN_FRAME_INTERVAL, duration / MAX_FRAMES)
    frames_dir = workdir / "frames"
    frames_dir.mkdir()
    scale = "scale=w='if(gt(iw,ih),min(768,iw),-2)':h='if(gt(iw,ih),-2,min(768,ih))'"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(video), "-vf", f"fps=1/{interval:.3f},{scale}",
         "-q:v", "4", "-frames:v", str(MAX_FRAMES), str(frames_dir / "%03d.jpg")],
        capture_output=True, text=True, check=True,
    )
    frames = sorted(frames_dir.glob("*.jpg"))
    # The fps filter emits one frame per interval, taken near the interval's midpoint.
    return [((index + 0.5) * interval, path) for index, path in enumerate(frames)]


def timestamp(seconds: float) -> str:
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"


def thumbnail(frames: list[tuple[float, Path]], workdir: Path) -> str | None:
    """A small still as a data: URL. The web app can't fetch a preview image
    itself (browsers don't let a page read other sites), so it gets one from here.
    """
    # A quarter of the way in: past the title card, usually mid-movement.
    source = frames[len(frames) // 4][1]
    target = workdir / "thumbnail.jpg"
    try:
        subprocess.run(
            ["ffmpeg", "-v", "error", "-i", str(source), "-vf", "scale=w='min(320,iw)':h=-2", "-q:v", "6", str(target)],
            capture_output=True, text=True, check=True,
        )
    except subprocess.CalledProcessError:
        return None
    return "data:image/jpeg;base64," + base64.standard_b64encode(target.read_bytes()).decode("ascii")


def default_provider() -> Provider:
    """What server/.env asks for; otherwise the first service it has a key for; otherwise Claude."""
    named = os.environ.get("ANALYZER_PROVIDER", "").strip().lower()
    if named:
        if named not in PROVIDERS:
            raise ModelError(500, f"ANALYZER_PROVIDER in server/.env is “{named}”; "
                                  f"it has to be one of: {', '.join(PROVIDERS)}.")
        return PROVIDERS[named]
    for provider in PROVIDERS.values():
        if os.environ.get(provider.key_env, "").strip():
            return provider
    return PROVIDERS["anthropic"]


def choose_model(provider_id: str | None = None, model: str | None = None, api_key: str | None = None) -> ModelChoice:
    """Settles which model answers: what the request asks for wins over server/.env."""
    provider_id = (provider_id or "").strip().lower()
    if provider_id and provider_id not in PROVIDERS:
        raise ModelError(422, f"“{provider_id}” isn't a model service this analyzer knows "
                              f"(it knows: {', '.join(PROVIDERS)}).")
    fallback = default_provider()
    provider = PROVIDERS[provider_id] if provider_id else fallback
    model = (model or "").strip()
    if model and not MODEL_NAME.fullmatch(model):
        raise ModelError(422, "That model name has characters a model name can't have.")
    if not model and provider is fallback:
        model = os.environ.get("ANALYZER_MODEL", "").strip()
    own_key = (api_key or "").strip()
    return ModelChoice(
        provider=provider,
        model=model or provider.default_model,
        api_key=own_key or os.environ.get(provider.key_env, "").strip() or None,
        own_key=bool(own_key),
        asked=bool(provider_id),
    )


def base_url(provider: Provider) -> str:
    """The chat API's address; ZAI_BASE_URL / OPENROUTER_BASE_URL in server/.env override it."""
    return (os.environ.get(f"{provider.id.upper()}_BASE_URL", "").strip() or provider.base_url or "").rstrip("/")


def http_client() -> httpx.Client:
    return httpx.Client(timeout=MODEL_TIMEOUT)


def missing_key(choice: ModelChoice) -> ModelError:
    provider = choice.provider
    message = (f"The analyzer has no {provider.label} API key. "
               f"Put {provider.key_env}=… in server/.env on the Mac and restart it")
    if choice.asked:
        message += ", or enter your own key in the app under Settings → Video model"
    return ModelError(500, message + ".")


def rejected_key(choice: ModelChoice) -> ModelError:
    if choice.own_key:
        return ModelError(401, f"{choice.provider.label} rejected your API key — "
                               "check it in the app under Settings → Video model.")
    return ModelError(500, f"{choice.provider.label} rejected the analyzer's API key — check server/.env on the Mac.")


def frame_data(path: Path) -> str:
    return base64.standard_b64encode(path.read_bytes()).decode("ascii")


def describe_video(info: dict, known: list[str]) -> str:
    return "\n\n".join([
        f"Video title: {info.get('title') or '(none)'}",
        f"Caption:\n{info.get('description') or '(none)'}",
        "Exercises already in the tracker:\n" + "\n".join(known),
    ])


def ask_claude(choice: ModelChoice, frames: list[tuple[float, Path]], info: dict, known: list[str]) -> tuple[str, str]:
    """Returns the answer's text and the model that wrote it."""
    content: list[dict] = []
    for seconds, path in frames:
        content.append({"type": "text", "text": f"Frame at {timestamp(seconds)}"})
        content.append({
            "type": "image",
            "source": {"type": "base64", "media_type": "image/jpeg", "data": frame_data(path)},
        })
    content.append({"type": "text", "text": describe_video(info, known)})

    request: dict = {
        "model": choice.model,
        "max_tokens": 16000,
        "system": SYSTEM_PROMPT,
        "output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": RESULT_SCHEMA}},
        "messages": [{"role": "user", "content": content}],
    }
    if choice.model in CLAUDE_SERVER_FALLBACK:
        # A refusal is not expected for gym footage, but if the model's safety
        # classifiers ever misfire the API retries on a fallback model in the same call.
        request.update(betas=["server-side-fallback-2026-07-01"], fallbacks="default")

    label = choice.provider.label
    try:
        # With the analyzer's own key the SDK finds it (or another login) itself.
        client = anthropic.Anthropic(api_key=choice.api_key) if choice.own_key else anthropic.Anthropic()
        response = client.beta.messages.create(**request)
    except TypeError as error:
        # With no credentials at all the SDK raises a bare TypeError while building the request.
        if "authentication" in str(error).lower():
            raise missing_key(choice) from error
        raise
    except anthropic.AuthenticationError as error:
        raise rejected_key(choice) from error
    except anthropic.RateLimitError as error:
        raise ModelError(429, f"{label}'s rate limit was hit; try again in a minute.") from error
    except anthropic.APIStatusError as error:
        raise ModelError(502, f"The AI request failed ({error.status_code}): {error.message[:200]}") from error
    except anthropic.APIConnectionError as error:
        raise ModelError(502, f"The analyzer couldn't reach {label}'s API.") from error
    if response.stop_reason == "refusal":
        raise ModelError(502, "The model declined to analyze this video.")
    if response.stop_reason == "max_tokens":
        raise ModelError(502, "The model's answer was cut off; try again.")
    text = next(block.text for block in response.content if block.type == "text")
    return text, getattr(response, "model", None) or choice.model


def chat_request(choice: ModelChoice, frames: list[tuple[float, Path]], info: dict, known: list[str]) -> dict:
    """The same question in the OpenAI chat format that Z.ai and OpenRouter both speak."""
    # Text first, then the images: OpenRouter's advice for how providers parse the parts.
    content: list[dict] = [{"type": "text", "text": describe_video(info, known)}]
    for seconds, path in frames:
        content.append({"type": "text", "text": f"Frame at {timestamp(seconds)}"})
        content.append({"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + frame_data(path)}})
    content.append({"type": "text", "text": "Now answer with the JSON object and nothing else."})
    body: dict = {
        "model": choice.model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT + "\n\n" + JSON_INSTRUCTIONS},
            {"role": "user", "content": content},
        ],
    }
    if choice.provider.json_schema:
        # Enforced by the models that can; OpenRouter drops it for the ones that can't.
        body["response_format"] = {
            "type": "json_schema",
            "json_schema": {"name": "exercises", "strict": True, "schema": RESULT_SCHEMA},
        }
    return body


def error_code(error: object) -> str:
    return str(error.get("code") or "") if isinstance(error, dict) else ""


def is_overloaded(status: int, error: object) -> bool:
    """Whether a chat API said "too busy right now". 1305 is how Z.ai says it, inside a 429."""
    return error_code(error) in ("1305", "503", "529") or status in (503, 529)


def is_worth_retrying(status: int, error: object) -> bool:
    """Busy, or a bad gateway between OpenRouter and the model: the failures that pass on their own."""
    return is_overloaded(status, error) or error_code(error) == "502" or status == 502


def chat_error(choice: ModelChoice, status: int, error: object) -> ModelError:
    """Turns an error from a chat API into a sentence about what to do."""
    label = choice.provider.label
    code, detail = "", ""
    if isinstance(error, dict):
        code = str(error.get("code") or "")
        detail = error.get("message") if isinstance(error.get("message"), str) else ""
    elif isinstance(error, str):
        detail = error
    if choice.api_key:
        detail = detail.replace(choice.api_key, "…")  # never echo a key back
    detail = " ".join(detail.split())[:200]
    if status < 400 and code.isdigit() and 400 <= int(code) < 600:
        status = int(code)  # OpenRouter reports failures during generation inside a 200 answer
    note = f" ({detail})" if detail else ""
    where = "in the app under Settings → Video model" if choice.asked else "(ANALYZER_MODEL) in server/.env"

    if code == "1113" or status == 402:  # Z.ai sends "insufficient balance" as a 429
        return ModelError(402, f"The {label} account has no credit left.{note}")
    if code == "1301":
        return ModelError(502, "The model declined to analyze this video.")
    # Google answers a bad key with a 400 ("Please pass a valid API key"), not a 401.
    if status == 401 or (status in (400, 403) and re.search(r"api key|authorization header", detail, re.IGNORECASE)):
        return rejected_key(choice)
    if code == "1211" or status == 404:
        return ModelError(422, f"{label} has no model called “{choice.model}” — check the name {where}.{note}")
    if is_overloaded(status, error):
        return ModelError(503, f"{label} says {choice.model} is overloaded right now; "
                               f"try again later, or pick another model.{note}")
    if status == 429:
        return ModelError(429, f"{label}'s rate limit was hit; try again later.{note}")
    return ModelError(502, f"The AI request failed ({status}): {detail or 'no details given'}")


def now() -> float:
    return time.monotonic()


def chat_attempt(choice: ModelChoice, model: str, body: dict, deadline: float) -> tuple[int, dict, dict, object]:
    """One request to a chat API: the HTTP status, the answer, its first choice, and the error if it holds one."""
    label = choice.provider.label
    try:
        with http_client() as client:
            response = client.post(
                f"{base_url(choice.provider)}/chat/completions",
                headers={"Authorization": f"Bearer {choice.api_key}"},
                json={**body, "model": model},
                timeout=max(10.0, deadline - now()),
            )
    except httpx.TimeoutException as error:
        raise ModelError(504, f"{label} took too long to answer; try again, or pick a faster model.") from error
    except httpx.HTTPError as error:
        raise ModelError(502, f"The analyzer couldn't reach {label}'s API.") from error

    try:
        data = response.json()
    except ValueError:
        data = None
    if isinstance(data, list) and data and isinstance(data[0], dict):
        data = data[0]  # Google wraps its errors in a list
    if not isinstance(data, dict):
        data = {}
    choices = data.get("choices")
    first = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
    return response.status_code, data, first, data.get("error") or first.get("error")


def chat_text(model: str, data: dict, first: dict) -> tuple[str, str]:
    """The text of a successful chat answer, and the model that wrote it."""
    finish = first.get("finish_reason")
    if finish in ("length", "model_context_window_exceeded"):
        raise ModelError(502, "The model's answer was cut off; try again.")
    if finish in ("sensitive", "content_filter"):
        raise ModelError(502, "The model declined to analyze this video.")
    message = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, list):  # some providers answer in parts
        content = "".join(part.get("text", "") for part in content if isinstance(part, dict))
    if not isinstance(content, str) or not content.strip():
        raise ModelError(502, "The model returned an empty answer; try again, or pick another model.")
    answered_by = data.get("model")
    return content, answered_by if isinstance(answered_by, str) and answered_by else model


def ask_chat_api(choice: ModelChoice, frames: list[tuple[float, Path]], info: dict, known: list[str]) -> tuple[str, str]:
    """Returns the answer's text and the model that wrote it.

    Free tiers count every request, answered or not — Gemini allows 20 a day per
    model — so a busy model is not asked over and over. When the provider has
    fallback models, each model is asked once, in order, until one answers; when
    it has none, the chosen model gets one more try after a pause. If nobody
    answers, the failure reported is the chosen model's.
    """
    if not choice.api_key:
        raise missing_key(choice)
    body = chat_request(choice, frames, info, known)
    deadline = now() + MODEL_TIMEOUT
    spares = [model for model in choice.provider.fallbacks if model != choice.model]
    attempts = [choice.model, *spares] if spares else [choice.model, choice.model]
    failure: ModelError | None = None

    for index, model in enumerate(attempts):
        if index:
            if now() + 30 > deadline:
                break  # no time left for another answer within what the apps wait for
            if not spares:
                time.sleep(RETRY_WAIT)
        status, data, first, error = chat_attempt(choice, model, body, deadline)
        if status < 400 and not error:
            return chat_text(model, data, first)
        if model == choice.model:
            failure = chat_error(choice, status, error)
            out_of_quota = failure.status == 429
            if not is_worth_retrying(status, error) and not (out_of_quota and spares):
                raise failure  # nothing that another try or another model would fix
        # A fallback's own failure is not reported: it was only standing in.

    assert failure is not None  # the chosen model is always asked first
    if spares:
        failure = ModelError(failure.status, f"{failure.message} The models tried in its place didn't answer either.")
    raise failure


def extract_json(text: str) -> object:
    """The JSON in a model's answer, allowing for a fence, a preamble or visible thinking around it."""
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
    candidates = [text]
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, flags=re.DOTALL | re.IGNORECASE)
    if fence:
        candidates.append(fence.group(1))
    for opener, closer in ("{}", "[]"):
        start, end = text.find(opener), text.rfind(closer)
        if 0 <= start < end:
            candidates.append(text[start:end + 1])
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except ValueError:
            continue
    raise ModelError(502, UNREADABLE_ANSWER)


def parse_exercises(text: str, known: list[str]) -> list[dict]:
    """Reads a model's answer into the list /analyze returns, tolerating what a schema would have prevented."""
    payload = extract_json(text)
    if isinstance(payload, dict):
        # A lone exercise object stands for a list of one.
        payload = payload["exercises"] if "exercises" in payload else [payload] if "name" in payload else None
    if not isinstance(payload, list):
        raise ModelError(502, UNREADABLE_ANSWER)

    def words(value: object) -> str:
        return value.strip() if isinstance(value, str) else ""

    def one_of(options: list[str], value: object) -> str:
        key = re.sub(r"[^a-z]", "", words(value).casefold())  # "Full Body", "full_body" → fullBody
        return next((option for option in options if option.casefold() == key), "other")

    known_by_key = {name.casefold(): name for name in known}
    exercises, seen = [], set()
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = words(item.get("name"))
        if not name or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        exercises.append({
            "name": name,
            # Only accept a match that really is one of the tracker's names.
            "library_match": known_by_key.get(words(item.get("library_match")).casefold()),
            "muscle_group": one_of(MUSCLE_GROUPS, item.get("muscle_group")),
            "equipment": one_of(EQUIPMENT, item.get("equipment")),
            "notes": words(item.get("notes")) or None,
            "sets_reps": words(item.get("sets_reps")) or None,
        })
    return exercises


def identify_exercises(choice: ModelChoice, frames: list[tuple[float, Path]], info: dict,
                       known: list[str]) -> tuple[list[dict], str]:
    """The exercises in the frames, and the model that named them."""
    ask = ask_chat_api if choice.provider.base_url else ask_claude
    text, answered_by = ask(choice, frames, info, known)
    return parse_exercises(text, known), answered_by


app = FastAPI(title="Gym Tracker video analyzer")
# Sending finished workouts to Strava and Garmin Connect lives in connectors.py.
app.include_router(connectors.router)


@app.get("/health")
def health() -> dict:
    """`ok` is all the apps need; the rest tells the web version which models it can offer."""
    providers = []
    for provider in PROVIDERS.values():
        try:
            model = choose_model(provider.id).model
        except ModelError:
            model = provider.default_model
        providers.append({
            "id": provider.id,
            "label": provider.label,
            "default_model": model,
            "has_key": bool(os.environ.get(provider.key_env, "").strip()),
        })
    try:
        default = default_provider().id
    except ModelError:
        default = None
    return {"ok": True, "default_provider": default, "providers": providers}


_openrouter_models: tuple[float, list[dict]] | None = None  # (when fetched, what was fetched)


def price_per_million(value: object) -> float | None:
    try:
        return float(value) * 1_000_000  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


def openrouter_models() -> list[dict]:
    """OpenRouter's current models that take images and answer in text, free ones first."""
    global _openrouter_models
    if _openrouter_models and time.monotonic() - _openrouter_models[0] < 3600:
        return _openrouter_models[1]
    with http_client() as client:
        response = client.get(f"{base_url(PROVIDERS['openrouter'])}/models",
                              params={"input_modalities": "image"}, timeout=10)
    response.raise_for_status()
    found = []
    for item in response.json()["data"]:
        architecture = item.get("architecture") or {}
        # Text out and nothing else: image and music generators also list "text".
        if "image" not in architecture.get("input_modalities", []) or architecture.get("output_modalities") != ["text"]:
            continue
        pricing = item.get("pricing") or {}
        asked, answered = price_per_million(pricing.get("prompt")), price_per_million(pricing.get("completion"))
        if asked is None or answered is None or asked < 0 or answered < 0:
            continue  # routers that price per request, not something to pick blind
        name = item.get("name") or item["id"]
        cost = "free" if asked == 0 and answered == 0 else f"${asked:.3g} in / ${answered:.3g} out per 1M tokens"
        found.append((asked + answered, name.casefold(), {"id": item["id"], "label": f"{name} — {cost}"}))
    models = [option for _, _, option in sorted(found, key=lambda entry: entry[:2])]
    if models:
        _openrouter_models = (time.monotonic(), models)
    return models


@app.get("/models")
def models(provider: str) -> dict:
    """Model names to offer for a service — a starting point; the app accepts any name."""
    try:
        choice = choose_model(provider or "?")
    except ModelError as error:
        raise HTTPException(error.status, error.message)
    options = [{"id": model_id, "label": name} for model_id, name in choice.provider.models]
    if choice.provider.id == "openrouter":
        try:
            options = openrouter_models() or options
        except (httpx.HTTPError, ValueError, KeyError, TypeError, AttributeError):
            pass  # the short built-in list will do
    return {"provider": choice.provider.id, "default_model": choice.model, "models": options}


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if not request.url.lower().startswith(("http://", "https://")):
        raise HTTPException(422, "That isn't a web link.")
    try:
        choice = choose_model(request.provider, request.model, request.api_key)
        if choice.provider.base_url and not choice.api_key:
            raise missing_key(choice)  # before spending a minute on the download
    except ModelError as error:
        raise HTTPException(error.status, error.message)
    workdir = Path(tempfile.mkdtemp(prefix="gymtracker-"))
    try:
        try:
            video, info = download(request.url, workdir)
        except ValueError as error:
            raise HTTPException(422, str(error))
        except yt_dlp.utils.DownloadError as error:
            hint = ""
            if "instagram" in request.url and not os.environ.get("YTDLP_COOKIES_FROM_BROWSER"):
                hint = " Instagram usually needs a login: start the analyzer with YTDLP_COOKIES_FROM_BROWSER=safari (or chrome)."
            raise HTTPException(502, f"Couldn't download the video.{hint} ({str(error)[:200]})")

        try:
            frames = extract_frames(video, workdir)
        except subprocess.CalledProcessError as error:
            raise HTTPException(502, f"Couldn't read the video file. ({(error.stderr or '')[:200]})")
        if not frames:
            raise HTTPException(502, "The video had no frames to look at.")

        try:
            exercises, answered_by = identify_exercises(choice, frames, info, request.known_exercises)
        except ModelError as error:
            raise HTTPException(error.status, error.message)

        return {
            "title": info.get("title"),
            "caption": (info.get("description") or "")[:2000],
            "thumbnail": thumbnail(frames, workdir),
            "exercises": exercises,
            "provider": choice.provider.id,
            "model": answered_by,
        }
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def check(url: str) -> None:
    """Runs the download and frame steps only — the quickest way to see whether a site works."""
    workdir = Path(tempfile.mkdtemp(prefix="gymtracker-check-"))
    video, info = download(url, workdir)
    frames = extract_frames(video, workdir)
    print(f"title:    {info.get('title')}")
    print(f"duration: {info.get('duration')} s")
    print(f"caption:  {(info.get('description') or '')[:200]!r}")
    print(f"frames:   {len(frames)} in {workdir / 'frames'}")
    print(f"thumbnail: {len(thumbnail(frames, workdir) or '') // 1024} KB as text")


def bonjour_name() -> str:
    """The name the phone can find this Mac by on the local network.

    Not socket.gethostname(): on a home router that is often "Mac.home", which
    the phone may not resolve. The Bonjour name always ends in .local.
    """
    try:
        name = subprocess.run(["scutil", "--get", "LocalHostName"], capture_output=True, text=True).stdout.strip()
    except OSError:
        name = ""
    return f"{name or socket.gethostname().split('.')[0]}.local"


def lan_address() -> str | None:
    """This machine's address on the local network (no packet is sent)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("10.255.255.255", 1))
            return probe.getsockname()[0]
    except OSError:
        return None


def describe_model() -> str:
    """One line for the start-up banner: which model answers when the app doesn't choose."""
    try:
        choice = choose_model()
    except ModelError as error:
        return error.message
    line = f"{choice.model} from {choice.provider.label}"
    if not choice.api_key:
        line += f" — but there is no {choice.provider.key_env} in server/.env yet"
    return line


def serve_web_app() -> bool:
    """Adds the built web version at "/" (after the routes above, which keep priority)."""
    # Only needed when the web app is hosted somewhere else and calls in from
    # there: a comma-separated list such as https://me.github.io
    origins = [origin.strip() for origin in os.environ.get("ALLOWED_ORIGINS", "").split(",") if origin.strip()]
    if origins:
        app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET", "POST"],
                           allow_headers=["Content-Type"])
    if not WEB_APP.is_dir():
        return False
    app.mount("/", StaticFiles(directory=WEB_APP, html=True), name="web")
    return True


if __name__ == "__main__":
    load_env_file()
    for tool in ("ffmpeg", "ffprobe"):
        if shutil.which(tool) is None:
            sys.exit(f"{tool} not found — install it with: brew install ffmpeg")
    if len(sys.argv) == 3 and sys.argv[1] == "--check":
        check(sys.argv[2])
    else:
        print(f"Gym Tracker analyzer — in the app's Settings enter: http://{bonjour_name()}:{PORT}")
        address = lan_address()
        if address:
            print(f"(if the phone can't find that name, use http://{address}:{PORT} — it can change when the Mac reconnects)")
        print(f"Model: {describe_model()}")
        if serve_web_app():
            print(f"Web version: http://localhost:{PORT} on this Mac, or the address above from another device")
        else:
            print("Web version: not built yet — run `npm install && npm run build` in web/, then restart")
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
