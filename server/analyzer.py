# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic", "fastapi", "uvicorn", "yt-dlp"]
# ///
"""Names the exercises in a saved workout video.

POST /analyze {"url": ..., "known_exercises": [...]} downloads the clip with
yt-dlp, samples frames with ffmpeg and asks Claude which exercises are shown.
The Gym Tracker app calls this from Saved Videos. If the web version has been
built (web/dist), it is served from the same address, so it needs no setup.

    uv run server/analyzer.py                 # start the service on port 8787
    uv run server/analyzer.py --check <url>   # download + frames only, no AI call
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

import anthropic
import uvicorn
import yt_dlp
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

PORT = int(os.environ.get("PORT", "8787"))
MODEL = "claude-opus-5-5"
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


class MissingCredentials(Exception):
    """No Anthropic API key or login could be found."""


class AnalyzeRequest(BaseModel):
    url: str
    known_exercises: list[str] = []


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


def identify_exercises(frames: list[tuple[float, Path]], info: dict, known: list[str]) -> list[dict]:
    content: list[dict] = []
    for seconds, path in frames:
        content.append({"type": "text", "text": f"Frame at {timestamp(seconds)}"})
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/jpeg",
                "data": base64.standard_b64encode(path.read_bytes()).decode("utf-8"),
            },
        })
    content.append({"type": "text", "text": "\n\n".join([
        f"Video title: {info.get('title') or '(none)'}",
        f"Caption:\n{info.get('description') or '(none)'}",
        "Exercises already in the tracker:\n" + "\n".join(known),
    ])})

    # A refusal is not expected for gym footage, but if the model's safety
    # classifiers ever misfire the API retries on a fallback model in the same call.
    try:
        response = anthropic.Anthropic().beta.messages.create(
            model=MODEL,
            max_tokens=16000,
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=SYSTEM_PROMPT,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": RESULT_SCHEMA}},
            messages=[{"role": "user", "content": content}],
        )
    except TypeError as error:
        # With no credentials at all the SDK raises a bare TypeError while building the request.
        if "authentication" in str(error).lower():
            raise MissingCredentials() from error
        raise
    if response.stop_reason == "refusal":
        raise RuntimeError("The model declined to analyze this video.")
    if response.stop_reason == "max_tokens":
        raise RuntimeError("The model's answer was cut off; try again.")
    text = next(block.text for block in response.content if block.type == "text")

    known_by_key = {name.casefold(): name for name in known}
    exercises, seen = [], set()
    for item in json.loads(text)["exercises"]:
        name = item["name"].strip()
        if not name or name.casefold() in seen:
            continue
        seen.add(name.casefold())
        exercises.append({
            "name": name,
            # Only accept a match that really is one of the tracker's names.
            "library_match": known_by_key.get(item["library_match"].strip().casefold()),
            "muscle_group": item["muscle_group"],
            "equipment": item["equipment"],
            "notes": item["notes"].strip() or None,
            "sets_reps": item["sets_reps"].strip() or None,
        })
    return exercises


app = FastAPI(title="Gym Tracker video analyzer")


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/analyze")
def analyze(request: AnalyzeRequest) -> dict:
    if not request.url.lower().startswith(("http://", "https://")):
        raise HTTPException(422, "That isn't a web link.")
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
            exercises = identify_exercises(frames, info, request.known_exercises)
        except MissingCredentials:
            raise HTTPException(500, "The analyzer has no Anthropic API key. Put ANTHROPIC_API_KEY=… in server/.env on the Mac and restart it.")
        except anthropic.AuthenticationError:
            raise HTTPException(500, "Anthropic rejected the analyzer's API key — check server/.env on the Mac.")
        except anthropic.RateLimitError:
            raise HTTPException(429, "Anthropic's rate limit was hit; try again in a minute.")
        except anthropic.APIStatusError as error:
            raise HTTPException(502, f"The AI request failed ({error.status_code}): {error.message[:200]}")
        except anthropic.APIConnectionError:
            raise HTTPException(502, "The analyzer couldn't reach Anthropic's API.")
        except RuntimeError as error:
            raise HTTPException(502, str(error))

        return {
            "title": info.get("title"),
            "caption": (info.get("description") or "")[:2000],
            "thumbnail": thumbnail(frames, workdir),
            "exercises": exercises,
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
        if serve_web_app():
            print(f"Web version: http://localhost:{PORT} on this Mac, or the address above from another device")
        else:
            print("Web version: not built yet — run `npm install && npm run build` in web/, then restart")
        uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")
