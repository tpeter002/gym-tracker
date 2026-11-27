"""Small JSON files that several requests read and change.

Part of the analyzer service: connectors.py keeps its tokens and the list of
sent workouts in one, inbox.py the links waiting for the web app. Handlers run
on a thread pool, so "read, change, write back" has to happen as one step —
two requests doing it at once would each write back without the other's change.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from pathlib import Path

# One lock for every store: they are tiny and written rarely. Re-entrant, so a
# function that holds it can call another that takes it too.
lock = threading.RLock()


def read(path: Path) -> dict:
    """What the file holds; nothing when it is missing or damaged."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def write(path: Path, data: dict) -> None:
    """Replaces the file in one step. It is readable by its owner only, from its first byte on."""
    # mkstemp creates the file with mode 0600 and a name no other writer shares.
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f"{path.stem}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w") as file:
            json.dump(data, file, indent=2)
        os.replace(temporary, path)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
