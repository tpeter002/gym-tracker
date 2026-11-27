# /// script
# requires-python = ">=3.11"
# dependencies = ["fastapi", "httpx", "pytest"]
# ///
"""Tests for inbox.py: links shared from other apps, waiting for the web app.

    uv run server/test_inbox.py
"""

from __future__ import annotations

import json
import stat
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import inbox

MINE = "a1b2c3d4e5f6a7b8"
THEIRS = "ffffeeeeddddcccc"
REEL = "https://www.instagram.com/reel/Cxyz123/?igsh=abc123"
SHORT = "https://youtube.com/shorts/abc123XYZ_-"
START = 1_795_712_400.0  # 2026-11-26 17:00:00 UTC, in seconds


class Clock:
    def __init__(self) -> None:
        self.time = START

    def __call__(self) -> float:
        return self.time

    def pass_days(self, days: float) -> None:
        self.time += days * 24 * 3600


@pytest.fixture(autouse=True)
def clock(monkeypatch, tmp_path) -> Clock:
    """Each test starts with empty inboxes and a clock it can move."""
    monkeypatch.setattr(inbox, "STORE", tmp_path / "inbox.json")
    clock = Clock()
    monkeypatch.setattr(inbox, "now", clock)
    return clock


@pytest.fixture
def service() -> TestClient:
    app = FastAPI()
    app.include_router(inbox.router)
    return TestClient(app)


def urls(service: TestClient, code: str = MINE) -> list[str]:
    return [link["url"] for link in service.get(f"/inbox/{code}").json()["links"]]


# --- what counts as a shared link ----------------------------------------------

def test_the_link_is_found_in_the_text_around_it():
    assert inbox.first_link(f"Check this out! {REEL} #legs") == REEL
    assert inbox.first_link(f"({SHORT}).") == SHORT
    assert inbox.first_link(f"first {SHORT} then {REEL}") == SHORT


def test_text_without_a_web_address_has_no_link():
    for text in ("", "leg day", "ftp://example.com/file", "javascript:alert(1)", "http://", "https:// nothing"):
        assert inbox.first_link(text) is None


def test_an_overlong_address_is_passed_over_for_the_next_one():
    long = "https://example.com/" + "a" * inbox.MAX_LINK
    assert inbox.first_link(f"{long} {REEL}") == REEL


@pytest.mark.parametrize("body, content_type", [
    (json.dumps({"url": REEL}), "application/json"),
    (json.dumps({"text": f"Look: {REEL}"}), "application/json"),
    (json.dumps({"title": "Leg day", "text": "Look", "url": REEL}), "application/json"),
    (json.dumps(REEL), "application/json"),
    (REEL, "text/plain"),
    (f"Check this out! {REEL}", ""),
    ("url=https%3A%2F%2Fwww.instagram.com%2Freel%2FCxyz123%2F%3Figsh%3Dabc123", "application/x-www-form-urlencoded"),
    (f'--b\r\nContent-Disposition: form-data; name="url"\r\n\r\n{REEL}\r\n--b--\r\n', "multipart/form-data; boundary=b"),
])
def test_a_shortcut_can_send_the_link_as_json_a_form_or_plain_text(service, body, content_type):
    headers = {"Content-Type": content_type} if content_type else {}
    answer = service.post(f"/inbox/{MINE}", content=body, headers=headers)
    assert answer.status_code == 200, answer.text
    assert answer.json() == {"saved": True, "url": REEL, "waiting": 1}
    assert urls(service) == [REEL]


def test_json_that_names_the_link_in_another_field_is_still_searched(service):
    assert service.post(f"/inbox/{MINE}", json={"link": REEL}).json()["url"] == REEL


# --- leaving and collecting links ----------------------------------------------

def test_shared_links_wait_oldest_first_with_an_id_and_a_time(service, clock):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    clock.pass_days(1)
    service.post(f"/inbox/{MINE}", json={"url": SHORT})
    links = service.get(f"/inbox/{MINE}").json()["links"]
    assert [link["url"] for link in links] == [REEL, SHORT]
    assert links[0]["added_at"] == int(START * 1000)
    assert links[1]["added_at"] == int((START + 24 * 3600) * 1000)
    assert links[0]["id"] and links[1]["id"] and links[0]["id"] != links[1]["id"]


def test_the_same_link_shared_twice_waits_once(service):
    assert service.post(f"/inbox/{MINE}", json={"url": REEL}).json()["waiting"] == 1
    assert service.post(f"/inbox/{MINE}", json={"url": REEL}).json() == {"saved": True, "url": REEL, "waiting": 1}
    assert urls(service) == [REEL]


def test_each_code_is_an_inbox_of_its_own(service):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    service.post(f"/inbox/{THEIRS}", json={"url": SHORT})
    assert urls(service, MINE) == [REEL]
    assert urls(service, THEIRS) == [SHORT]


def test_an_inbox_nothing_was_shared_to_is_empty(service):
    assert service.get(f"/inbox/{MINE}").json() == {"links": []}
    assert not inbox.STORE.exists()


def test_taken_links_stop_waiting_and_the_rest_stay(service):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    service.post(f"/inbox/{MINE}", json={"url": SHORT})
    service.post(f"/inbox/{THEIRS}", json={"url": REEL})
    first = service.get(f"/inbox/{MINE}").json()["links"][0]["id"]

    answer = service.post(f"/inbox/{MINE}/taken", json={"ids": [first, "not-an-id"]})

    assert [link["url"] for link in answer.json()["links"]] == [SHORT]
    assert urls(service, MINE) == [SHORT]
    assert urls(service, THEIRS) == [REEL]


def test_taking_from_one_inbox_cannot_empty_another(service):
    service.post(f"/inbox/{THEIRS}", json={"url": REEL})
    theirs = service.get(f"/inbox/{THEIRS}").json()["links"][0]["id"]
    service.post(f"/inbox/{MINE}/taken", json={"ids": [theirs]})
    assert urls(service, THEIRS) == [REEL]


def test_a_taken_link_can_be_shared_again(service):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    taken = [link["id"] for link in service.get(f"/inbox/{MINE}").json()["links"]]
    service.post(f"/inbox/{MINE}/taken", json={"ids": taken})
    assert urls(service) == []
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    assert urls(service) == [REEL]


# --- what is refused -------------------------------------------------------------

def test_sharing_something_without_a_link_is_refused_in_words(service):
    answer = service.post(f"/inbox/{MINE}", json={"text": "leg day tomorrow"})
    assert answer.status_code == 422
    assert answer.json()["detail"] == "There is no link in what was shared."
    assert urls(service) == []


def test_an_empty_post_is_refused(service):
    assert service.post(f"/inbox/{MINE}").status_code == 422


@pytest.mark.parametrize("code", ["short", "has space in it", "semi;colon;code", "x" * 65])
def test_a_malformed_code_is_not_an_inbox(service, code):
    for answer in (service.post(f"/inbox/{code}", json={"url": REEL}), service.get(f"/inbox/{code}"),
                   service.post(f"/inbox/{code}/taken", json={"ids": []})):
        assert answer.status_code == 404
        assert "Settings → Share from other apps" in answer.json()["detail"]
    assert not inbox.STORE.exists()


def test_an_oversized_post_is_refused(service):
    answer = service.post(f"/inbox/{MINE}", content=REEL + " " + "x" * inbox.MAX_BODY)
    assert answer.status_code == 413
    assert urls(service) == []


# --- the file stays small and private ------------------------------------------

def test_an_inbox_keeps_only_its_newest_links(service, monkeypatch):
    monkeypatch.setattr(inbox, "MAX_WAITING", 3)
    for number in range(5):
        service.post(f"/inbox/{MINE}", json={"url": f"https://example.com/clip/{number}"})
    assert urls(service) == [f"https://example.com/clip/{number}" for number in (2, 3, 4)]


def test_links_nobody_collected_are_dropped_after_two_months(service, clock):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    clock.pass_days(59)
    service.post(f"/inbox/{MINE}", json={"url": SHORT})
    assert urls(service) == [REEL, SHORT]
    clock.pass_days(2)
    assert urls(service) == [SHORT]


def test_only_the_most_recently_used_inboxes_are_kept(service, clock, monkeypatch):
    monkeypatch.setattr(inbox, "MAX_INBOXES", 2)
    for code in ("inbox-number-1", "inbox-number-2", "inbox-number-3"):
        service.post(f"/inbox/{code}", json={"url": REEL})
        clock.pass_days(1)
    assert urls(service, "inbox-number-1") == []
    assert urls(service, "inbox-number-2") == [REEL]
    assert urls(service, "inbox-number-3") == [REEL]


def test_the_file_is_readable_by_its_owner_only(service):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    assert stat.S_IMODE(inbox.STORE.stat().st_mode) == 0o600


def test_emptied_inboxes_leave_nothing_behind_in_the_file(service):
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    taken = [link["id"] for link in service.get(f"/inbox/{MINE}").json()["links"]]
    service.post(f"/inbox/{MINE}/taken", json={"ids": taken})
    assert json.loads(inbox.STORE.read_text()) == {}


@pytest.mark.parametrize("content", ["{not json", "[1, 2]", '{"a1b2c3d4e5f6a7b8": "oops"}', '{"a1b2c3d4e5f6a7b8": [1, null, "x"]}'])
def test_a_damaged_file_reads_as_empty_inboxes_and_is_usable_again(service, content):
    inbox.STORE.write_text(content)
    assert urls(service) == []
    service.post(f"/inbox/{MINE}", json={"url": REEL})
    assert urls(service) == [REEL]


def test_the_analyzer_service_offers_the_inbox():
    analyzer = Path(inbox.__file__).with_name("analyzer.py").read_text()
    assert "app.include_router(inbox.router)" in analyzer


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
