"""Links shared to the web app from other apps on a phone.

Part of the analyzer service (analyzer.py mounts `router`). A web page can't be
listed in the iPhone share sheet, and a Shortcut can't hand a link to an app on
the Home Screen either: it can only open Safari, which keeps separate data.
What a Shortcut can do is post the link here. Every copy of the web app has an
inbox under a code of its own (its Settings show the address); a posted link
waits in inbox.json next to this file until that copy is open and collects it.

Like the rest of the service this has no login. The code only keeps the
inboxes of different browsers apart.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import threading
import time
import urllib.parse
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

STORE = Path(__file__).with_name("inbox.json")

CODE = re.compile(r"[A-Za-z0-9_-]{8,64}")
LINK = re.compile(r"https?://[^\s<>\"']+", re.IGNORECASE)
MAX_BODY = 20_000  # bytes; a shared link with its caption is a few hundred
MAX_LINK = 2_000  # characters
MAX_WAITING = 100  # links in one inbox; beyond that the oldest give way
MAX_INBOXES = 200
KEEP_SECONDS = 60 * 24 * 3600  # a link nobody collected in two months is dropped

router = APIRouter()
_lock = threading.Lock()  # one request at a time reads, changes and writes the file


class Taken(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=MAX_WAITING)


def now() -> float:
    return time.time()


def load_store() -> dict[str, list[dict]]:
    try:
        data = json.loads(STORE.read_text())
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {code: [item for item in items if isinstance(item, dict)]
            for code, items in data.items() if isinstance(items, list)}


def save_store(data: dict[str, list[dict]]) -> None:
    temporary = STORE.with_suffix(".tmp")
    temporary.write_text(json.dumps(data, indent=2))
    os.chmod(temporary, 0o600)
    temporary.replace(STORE)


def added_at(item: dict) -> float:
    value = item.get("added_at")
    return value if isinstance(value, (int, float)) else 0


def tidy(data: dict[str, list[dict]]) -> dict[str, list[dict]]:
    """Without links that waited too long, inboxes left empty, and — past the limit — the stalest inboxes."""
    oldest = (now() - KEEP_SECONDS) * 1000
    kept = {code: [item for item in items if added_at(item) >= oldest] for code, items in data.items()}
    kept = {code: items for code, items in kept.items() if items}
    freshest_first = sorted(kept, key=lambda code: max(added_at(item) for item in kept[code]), reverse=True)
    return {code: kept[code] for code in freshest_first[:MAX_INBOXES]}


def first_link(text: str) -> str | None:
    """The first web address in what was shared; apps like TikTok send "Check this out! https://…"."""
    for candidate in LINK.findall(text):
        link = candidate.rstrip(".,;:!?)]}")
        if len(link) > MAX_LINK:
            continue
        try:
            parts = urllib.parse.urlsplit(link)
        except ValueError:
            continue
        if parts.scheme.lower() in ("http", "https") and parts.hostname:
            return link
    return None


def shared_text(body: bytes, content_type: str) -> str:
    """
    What a Shortcut's "Get Contents of URL" sent, whichever way it was set up:
    JSON with a `url` (or `text`) field, a form with the same fields, or just text.
    """
    text = body.decode("utf-8", errors="replace")
    fields: dict[str, object] = {}
    if "form-urlencoded" in content_type.lower():
        fields = {name: " ".join(values) for name, values in urllib.parse.parse_qs(text).items()}
    else:
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, dict):
            fields = parsed
        elif isinstance(parsed, str):
            return parsed
    named = [value for value in (fields.get("url"), fields.get("text"), fields.get("title")) if isinstance(value, str)]
    return " ".join(named) if named else text


def check(code: str) -> str:
    if not CODE.fullmatch(code):
        raise HTTPException(404, "That isn't an inbox address. Copy it again from the app, under Settings → Share from other apps.")
    return code


def listing(items: list[dict]) -> dict:
    return {"links": [{"id": item.get("id"), "url": item.get("url"), "added_at": added_at(item)} for item in items]}


@router.post("/inbox/{code}")
async def add(code: str, request: Request) -> dict:
    """Leaves a link for the copy of the app that owns this inbox."""
    check(code)
    body = await request.body()
    if len(body) > MAX_BODY:
        raise HTTPException(413, "That is too much text for a shared link.")
    link = first_link(shared_text(body, request.headers.get("content-type", "")))
    if not link:
        raise HTTPException(422, "There is no link in what was shared.")
    with _lock:
        data = tidy(load_store())
        waiting = data.get(code, [])
        if not any(item.get("url") == link for item in waiting):
            waiting.append({"id": secrets.token_hex(8), "url": link, "added_at": int(now() * 1000)})
        data[code] = waiting[-MAX_WAITING:]
        save_store(tidy(data))
        return {"saved": True, "url": link, "waiting": len(data[code])}


@router.get("/inbox/{code}")
def waiting_links(code: str) -> dict:
    """The links waiting for this copy of the app, oldest first."""
    check(code)
    with _lock:
        return listing(tidy(load_store()).get(code, []))


@router.post("/inbox/{code}/taken")
def taken(code: str, request: Taken) -> dict:
    """The app has saved these links; they needn't be kept any longer."""
    check(code)
    gone = set(request.ids)
    with _lock:
        data = tidy(load_store())
        left = [item for item in data.get(code, []) if item.get("id") not in gone]
        data[code] = left
        save_store(tidy(data))
        return listing(left)
