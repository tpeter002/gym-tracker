# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic", "fastapi", "httpx", "uvicorn", "yt-dlp", "pytest"]
# ///
"""Tests for analyzer.py.

    uv run server/test_analyzer.py            # all of them
    uv run server/test_analyzer.py -k zai     # the ones with "zai" in their name

Nothing here downloads a video, calls a model or looks a host name up: the
download and frame steps are replaced, Claude's SDK client is a stand-in, the
requests to the chat APIs (Z.ai, OpenRouter, Gemini) go to an in-process
transport that records them, and every host name resolves to a made-up
public address.
"""

from __future__ import annotations

import base64
import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx
import pytest
import yt_dlp
from fastapi import FastAPI
from fastapi.testclient import TestClient

import analyzer
import inbox

KNOWN = ["Face Pull (Cable)", "Pull Up"]
INFO = {"title": "3 cable moves", "description": "Save this for pull day"}
ANSWER = json.dumps({"exercises": [
    {"name": "Cable Face Pull", "library_match": "Face Pull (Cable)", "muscle_group": "shoulders",
     "equipment": "cable", "notes": "Rope at eye level.", "sets_reps": "3 x 15"},
    {"name": "Half-Kneeling Cable Y Raise", "library_match": "", "muscle_group": "shoulders",
     "equipment": "cable", "notes": "", "sets_reps": ""},
]})
# What /analyze has always returned for ANSWER.
EXERCISES = [
    {"name": "Cable Face Pull", "library_match": "Face Pull (Cable)", "muscle_group": "shoulders",
     "equipment": "cable", "notes": "Rope at eye level.", "sets_reps": "3 x 15"},
    {"name": "Half-Kneeling Cable Y Raise", "library_match": None, "muscle_group": "shoulders",
     "equipment": "cable", "notes": None, "sets_reps": None},
]
SETTINGS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ZAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY",
            "ANALYZER_PROVIDER", "ANALYZER_MODEL", "ZAI_BASE_URL", "OPENROUTER_BASE_URL", "GEMINI_BASE_URL",
            "ALLOWED_HOSTS", "ALLOWED_ORIGINS", "ALLOW_LOCAL_VIDEO_LINKS", "YTDLP_COOKIES_FROM_BROWSER"]
PUBLIC_ADDRESS = "8.8.8.8"  # only ever compared, never contacted; the ranges reserved for examples count as non-public
# How the Claude client is built whoever's key it uses: no more patient than the apps are.
PATIENCE = {"timeout": analyzer.MODEL_TIMEOUT, "max_retries": 1}


def b64(data: bytes) -> str:
    return base64.standard_b64encode(data).decode("ascii")


@pytest.fixture(autouse=True)
def clean_settings(monkeypatch):
    """Each test starts as a machine with nothing in server/.env."""
    for name in SETTINGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(analyzer, "_openrouter_models", None)
    # Every host is "somewhere on the internet" unless a test says otherwise; no test asks a real name server.
    monkeypatch.setattr(analyzer, "addresses_of", lambda host: {PUBLIC_ADDRESS})


@pytest.fixture
def frames(tmp_path) -> list[tuple[float, Path]]:
    found = []
    for index, seconds in enumerate([1.0, 62.5]):
        path = tmp_path / f"{index}.jpg"
        path.write_bytes(f"frame-{index}".encode())
        found.append((seconds, path))
    return found


class FakeClaude:
    """Stands in for anthropic.Anthropic: records how it was built and what it was asked."""

    def __init__(self, answer: str | None = ANSWER, error: Exception | None = None, stop_reason: str = "end_turn",
                 model: str | None = None) -> None:
        self.answer, self.error, self.stop_reason, self.model = answer, error, stop_reason, model
        self.built_with: dict | None = None
        self.request: dict | None = None
        self.beta = self.messages = self

    def __call__(self, **kwargs):
        self.built_with = kwargs
        return self

    def create(self, **request):
        self.request = request
        if self.error:
            raise self.error
        content = [SimpleNamespace(type="thinking")]
        if self.answer is not None:  # None: an answer with no text in it at all
            content.append(SimpleNamespace(type="text", text=self.answer))
        return SimpleNamespace(stop_reason=self.stop_reason, model=self.model or request["model"], content=content)


@pytest.fixture
def claude(monkeypatch) -> FakeClaude:
    fake = FakeClaude()
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", fake)
    return fake


class ChatAPI:
    """Stands in for Z.ai / OpenRouter: answers every request with `reply` and keeps the requests."""

    def __init__(self, monkeypatch) -> None:
        self.requests: list[httpx.Request] = []
        self.status = 200
        self.reply: object = self.completion(ANSWER)
        self.failure: Exception | None = None
        self.queue: list[tuple[int, object]] = []  # answers to give first, one per request
        self.by_model: dict[str, tuple[int, object]] = {}  # answers that depend on the model asked
        monkeypatch.setattr(analyzer, "http_client", lambda: httpx.Client(transport=httpx.MockTransport(self.handle)))

    @staticmethod
    def completion(content: object, finish_reason: str = "stop", **extra) -> dict:
        return {"choices": [{"finish_reason": finish_reason, "message": {"role": "assistant", "content": content}}], **extra}

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.failure:
            raise self.failure
        asked = json.loads(request.content).get("model") if request.method == "POST" else None
        if self.queue:
            status, reply = self.queue.pop(0)
        else:
            status, reply = self.by_model.get(asked, (self.status, self.reply))
        if isinstance(reply, str):
            return httpx.Response(status, text=reply)
        return httpx.Response(status, json=reply)

    @property
    def body(self) -> dict:
        return json.loads(self.requests[-1].content)

    @property
    def models_asked(self) -> list[str]:
        return [json.loads(request.content)["model"] for request in self.requests]


@pytest.fixture
def chat(monkeypatch) -> ChatAPI:
    return ChatAPI(monkeypatch)


@pytest.fixture(autouse=True)
def waits(monkeypatch) -> list[float]:
    """No test really waits; the pauses the analyzer asked for are recorded instead."""
    asked: list[float] = []
    monkeypatch.setattr(analyzer.time, "sleep", asked.append)
    return asked


@pytest.fixture
def service(monkeypatch, frames) -> TestClient:
    """The HTTP service with the download and frame steps replaced."""
    monkeypatch.setattr(analyzer, "download", lambda url, workdir: (workdir / "video.mp4", dict(INFO)))
    monkeypatch.setattr(analyzer, "extract_frames", lambda video, workdir: frames)
    monkeypatch.setattr(analyzer, "thumbnail", lambda found, workdir: "data:image/jpeg;base64,AAAA")
    # Under the name the owner uses; anything else is turned away (see the host tests).
    return TestClient(analyzer.app, base_url="http://localhost:8787")


def post(service: TestClient, **extra) -> httpx.Response:
    return service.post("/analyze", json={"url": "https://youtube.com/shorts/abc", "known_exercises": KNOWN, **extra})


# --- reading a model's answer ---------------------------------------------------

def test_a_well_formed_answer_reads_as_it_always_has():
    assert analyzer.parse_exercises(ANSWER, KNOWN) == EXERCISES


def test_a_library_match_must_be_one_of_the_trackers_names():
    answer = json.dumps({"exercises": [
        {"name": "A", "library_match": "pull up", "muscle_group": "back", "equipment": "bodyweight", "notes": "", "sets_reps": ""},
        {"name": "B", "library_match": "Chin Up", "muscle_group": "back", "equipment": "bodyweight", "notes": "", "sets_reps": ""},
    ]})
    assert [item["library_match"] for item in analyzer.parse_exercises(answer, KNOWN)] == ["Pull Up", None]


def test_the_same_exercise_is_listed_once_and_nameless_ones_are_dropped():
    answer = json.dumps({"exercises": [{"name": "Pull Up"}, {"name": "pull up "}, {"name": "  "}, {"notes": "no name"}, "junk"]})
    assert [item["name"] for item in analyzer.parse_exercises(answer, KNOWN)] == ["Pull Up"]


@pytest.mark.parametrize("wrapped", [
    "```json\n{ANSWER}\n```",
    "Here is what I found:\n\n{ANSWER}\n\nLet me know if you need more.",
    "<think>The first frame {shows} a cable [station].</think>\n{ANSWER}",
    "```\n{ANSWER}\n```",
])
def test_an_answer_wrapped_in_a_fence_prose_or_thinking_is_still_read(wrapped):
    assert analyzer.parse_exercises(wrapped.replace("{ANSWER}", ANSWER), KNOWN) == EXERCISES


def test_a_bare_list_or_a_single_object_counts_as_the_list():
    items = json.loads(ANSWER)["exercises"]
    assert analyzer.parse_exercises(json.dumps(items), KNOWN) == EXERCISES
    assert analyzer.parse_exercises("Sure! " + json.dumps(items[0]), KNOWN) == EXERCISES[:1]


def test_values_outside_the_trackers_lists_become_other():
    answer = json.dumps({"exercises": [
        {"name": "A", "muscle_group": "Full Body", "equipment": "Kettlebell"},
        {"name": "B", "muscle_group": "full_body", "equipment": "trx straps"},
        {"name": "C", "muscle_group": "lats", "equipment": None, "notes": 7, "sets_reps": ["3x10"], "library_match": None},
    ]})
    assert analyzer.parse_exercises(answer, KNOWN) == [
        {"name": "A", "library_match": None, "muscle_group": "fullBody", "equipment": "kettlebell", "notes": None, "sets_reps": None},
        {"name": "B", "library_match": None, "muscle_group": "fullBody", "equipment": "other", "notes": None, "sets_reps": None},
        {"name": "C", "library_match": None, "muscle_group": "other", "equipment": "other", "notes": None, "sets_reps": None},
    ]


def test_an_empty_list_is_an_answer_not_an_error():
    assert analyzer.parse_exercises('{"exercises": []}', KNOWN) == []


@pytest.mark.parametrize("answer", ["I can't tell what this is.", '{"exercises": "none"}', '{"result": []}', "42", ""])
def test_an_answer_that_is_not_the_expected_json_is_reported(answer):
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.parse_exercises(answer, KNOWN)
    assert failure.value.status == 502
    assert failure.value.message == analyzer.UNREADABLE_ANSWER


# --- which model answers --------------------------------------------------------

def test_with_nothing_configured_it_is_claude_opus():
    choice = analyzer.choose_model()
    assert (choice.provider.id, choice.model, choice.api_key, choice.own_key, choice.asked) == \
        ("anthropic", "claude-opus-5-5", None, False, False)


def test_the_env_file_can_name_the_service_and_the_model(monkeypatch):
    monkeypatch.setenv("ANALYZER_PROVIDER", "OpenRouter")
    monkeypatch.setenv("ANALYZER_MODEL", "qwen/qwen3.8-flash")
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-server")
    choice = analyzer.choose_model()
    assert (choice.provider.id, choice.model, choice.api_key, choice.own_key) == \
        ("openrouter", "qwen/qwen3.8-flash", "sk-or-server", False)


def test_a_lone_key_in_the_env_file_selects_its_service(monkeypatch):
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    assert analyzer.choose_model().provider.id == "zai"
    assert analyzer.choose_model().model == "glm-4.6v-flash"
    # Claude keeps priority when its key is there too, as before other services existed.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-server")
    assert analyzer.choose_model().provider.id == "anthropic"


def test_the_request_wins_over_the_env_file(monkeypatch):
    monkeypatch.setenv("ANALYZER_PROVIDER", "anthropic")
    monkeypatch.setenv("ANALYZER_MODEL", "claude-haiku-5-5")
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    choice = analyzer.choose_model(" ZAI ", " glm-5.3-flash ", " zai-mine ")
    assert (choice.provider.id, choice.model, choice.api_key, choice.own_key, choice.asked) == \
        ("zai", "glm-5.3-flash", "zai-mine", True, True)
    # ANALYZER_MODEL belongs to the env file's service, not to whichever one a request names.
    assert analyzer.choose_model("zai").model == "glm-4.6v-flash"
    assert analyzer.choose_model("zai").api_key == "zai-server"
    assert analyzer.choose_model("anthropic").model == "claude-haiku-5-5"


def test_an_unknown_service_or_a_malformed_model_name_is_refused(monkeypatch):
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.choose_model("openai")
    assert failure.value.status == 422 and "openai" in failure.value.message
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.choose_model("zai", "glm 4.6v; rm -rf")
    assert failure.value.status == 422
    monkeypatch.setenv("ANALYZER_PROVIDER", "mistral")
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.choose_model()
    assert failure.value.status == 500 and "ANALYZER_PROVIDER" in failure.value.message


def test_every_service_offers_its_default_model():
    for provider in analyzer.PROVIDERS.values():
        assert provider.default_model in [model_id for model_id, _ in provider.models]
        assert analyzer.MODEL_NAME.fullmatch(provider.default_model)


# --- Claude ---------------------------------------------------------------------

def test_the_request_to_claude_is_what_it_was_before_models_were_selectable(claude, frames):
    exercises, answered_by = analyzer.identify_exercises(analyzer.choose_model(), frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert answered_by == "claude-opus-5-5"
    assert claude.built_with == PATIENCE  # no key: the SDK finds it in the environment itself
    assert claude.request == {
        "model": "claude-opus-5-5",
        "max_tokens": 16000,
        "betas": ["server-side-fallback-2026-07-01"],
        "fallbacks": "default",
        "system": analyzer.SYSTEM_PROMPT,
        "output_config": {"effort": "medium", "format": {"type": "json_schema", "schema": analyzer.RESULT_SCHEMA}},
        "messages": [{"role": "user", "content": [
            {"type": "text", "text": "Frame at 0:01"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(b"frame-0")}},
            {"type": "text", "text": "Frame at 1:02"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64(b"frame-1")}},
            {"type": "text", "text": "Video title: 3 cable moves\n\nCaption:\nSave this for pull day\n\n"
                                     "Exercises already in the tracker:\nFace Pull (Cable)\nPull Up"},
        ]}],
    }


def test_another_claude_model_and_your_own_key(claude, frames):
    choice = analyzer.choose_model("anthropic", "claude-haiku-5-5", "sk-ant-mine")
    _, answered_by = analyzer.identify_exercises(choice, frames, INFO, KNOWN)
    assert answered_by == "claude-haiku-5-5"
    assert claude.built_with == {"api_key": "sk-ant-mine", **PATIENCE}
    assert claude.request["model"] == "claude-haiku-5-5"
    # Haiku has no server-side fallback, so the request must not ask for one.
    assert "betas" not in claude.request and "fallbacks" not in claude.request
    assert claude.request["output_config"]["format"]["schema"] == analyzer.RESULT_SCHEMA


def test_sonnet_keeps_the_server_side_fallback(claude, frames):
    analyzer.identify_exercises(analyzer.choose_model("anthropic", "claude-sonnet-5-5"), frames, INFO, KNOWN)
    assert claude.request["fallbacks"] == "default"


def test_the_model_that_actually_answered_is_reported(monkeypatch, frames):
    fake = FakeClaude(model="claude-opus-5")  # what a server-side fallback looks like
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", fake)
    assert analyzer.identify_exercises(analyzer.choose_model(), frames, INFO, KNOWN)[1] == "claude-opus-5"


def claude_error(kind, status: int) -> Exception:
    request = httpx.Request("POST", "https://api.anthropic.com/v1/messages")
    return kind("upstream said no", response=httpx.Response(status, request=request), body=None)


@pytest.mark.parametrize("error, status, message", [
    (TypeError('"Could not resolve authentication method. Expected one of api_key…"'), 500,
     "The analyzer has no Anthropic API key. Put ANTHROPIC_API_KEY=… in server/.env on the Mac and restart it."),
    (claude_error(anthropic.AuthenticationError, 401), 500,
     "Anthropic rejected the analyzer's API key — check server/.env on the Mac."),
    (claude_error(anthropic.RateLimitError, 429), 429, "Anthropic's rate limit was hit; try again in a minute."),
    (claude_error(anthropic.BadRequestError, 400), 502, "The AI request failed (400): upstream said no"),
    (anthropic.APIConnectionError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages")), 502,
     "The analyzer couldn't reach Anthropic's API."),
    # A timeout is a kind of connection error to the SDK; it must not be reported as "couldn't reach".
    (anthropic.APITimeoutError(request=httpx.Request("POST", "https://api.anthropic.com/v1/messages")), 504,
     "Anthropic took too long to answer; try again, or pick a faster model."),
])
def test_claude_failures_keep_their_messages(monkeypatch, service, error, status, message):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(error=error))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (status, message)


@pytest.mark.parametrize("answer", [None, "", "  \n"])
def test_a_claude_answer_with_no_text_in_it_is_an_empty_answer_not_a_crash(monkeypatch, service, answer):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(answer=answer))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (
        502, "The model returned an empty answer; try again, or pick another model.")


@pytest.mark.parametrize("stop_reason, message", [
    ("refusal", "The model declined to analyze this video."),
    ("max_tokens", "The model's answer was cut off; try again."),
])
def test_claude_stop_reasons_keep_their_messages(monkeypatch, service, stop_reason, message):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(stop_reason=stop_reason))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (502, message)


def test_a_rejected_key_of_your_own_says_so(monkeypatch, service):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(error=claude_error(anthropic.AuthenticationError, 401)))
    response = post(service, provider="anthropic", api_key="sk-ant-mine")
    assert response.status_code == 401
    assert response.json()["detail"] == "Anthropic rejected your API key — check it in the app under Settings → Video model."


def test_an_unrelated_type_error_is_not_mistaken_for_a_missing_key(monkeypatch, frames):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(error=TypeError("unexpected keyword")))
    with pytest.raises(TypeError):
        analyzer.identify_exercises(analyzer.choose_model(), frames, INFO, KNOWN)


# --- Z.ai and OpenRouter --------------------------------------------------------

def test_the_request_to_zai(chat, frames):
    choice = analyzer.choose_model("zai", api_key="zai-mine")
    exercises, answered_by = analyzer.identify_exercises(choice, frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert answered_by == "glm-4.6v-flash"

    request = chat.requests[-1]
    assert str(request.url) == "https://api.z.ai/api/paas/v4/chat/completions"
    assert request.headers["authorization"] == "Bearer zai-mine"
    assert chat.body["model"] == "glm-4.6v-flash"
    assert set(chat.body) == {"model", "messages"}  # its vision models document no response_format
    system, user = chat.body["messages"]
    assert system == {"role": "system", "content": analyzer.SYSTEM_PROMPT + "\n\n" + analyzer.JSON_INSTRUCTIONS}
    assert user["role"] == "user"
    assert user["content"] == [
        {"type": "text", "text": "Video title: 3 cable moves\n\nCaption:\nSave this for pull day\n\n"
                                 "Exercises already in the tracker:\nFace Pull (Cable)\nPull Up"},
        {"type": "text", "text": "Frame at 0:01"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64(b"frame-0")}},
        {"type": "text", "text": "Frame at 1:02"},
        {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b64(b"frame-1")}},
        {"type": "text", "text": "Now answer with the JSON object and nothing else."},
    ]


def test_the_instructions_spell_out_the_shape_and_the_allowed_values():
    for word in ["exercises", "library_match", "sets_reps", *analyzer.MUSCLE_GROUPS, *analyzer.EQUIPMENT]:
        assert word in analyzer.JSON_INSTRUCTIONS


def test_the_request_to_openrouter(chat, frames):
    chat.reply = chat.completion(ANSWER, model="google/gemma-4-31b-it:free")
    choice = analyzer.choose_model("openrouter", api_key="sk-or-mine")
    exercises, answered_by = analyzer.identify_exercises(choice, frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert answered_by == "google/gemma-4-31b-it:free"  # the free router says which model it picked

    request = chat.requests[-1]
    assert str(request.url) == "https://openrouter.ai/api/v1/chat/completions"
    assert request.headers["authorization"] == "Bearer sk-or-mine"
    # Nothing that identifies the app or its user goes along.
    assert "http-referer" not in request.headers and "x-title" not in request.headers
    assert chat.body["model"] == "openrouter/free"
    assert chat.body["response_format"] == {
        "type": "json_schema",
        "json_schema": {"name": "exercises", "strict": True, "schema": analyzer.RESULT_SCHEMA},
    }
    assert [part["type"] for part in chat.body["messages"][1]["content"]] == \
        ["text", "text", "image_url", "text", "image_url", "text"]


def test_the_request_to_gemini(chat, frames):
    chat.reply = chat.completion(ANSWER, model="gemini-3.8-flash")
    choice = analyzer.choose_model("gemini", api_key="AIza-mine")
    exercises, answered_by = analyzer.identify_exercises(choice, frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert answered_by == "gemini-3.8-flash"

    request = chat.requests[-1]
    assert str(request.url) == "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
    assert request.headers["authorization"] == "Bearer AIza-mine"
    assert set(chat.body) == {"model", "messages"}  # its schema dialect isn't RESULT_SCHEMA's, so none is sent
    assert chat.body["model"] == "gemini-3.8-flash"
    assert chat.body["messages"][0]["content"].endswith(analyzer.JSON_INSTRUCTIONS)
    assert [part["type"] for part in chat.body["messages"][1]["content"]] == \
        ["text", "text", "image_url", "text", "image_url", "text"]


# Google wraps errors in a list and answers a bad key with a 400 (seen from the live service).
@pytest.mark.parametrize("status, reply, expected_status, expected", [
    (400, [{"error": {"code": 400, "message": "Please pass a valid API key", "status": "INVALID_ARGUMENT"}}], 401,
     "Google rejected your API key — check it in the app under Settings → Video model."),
    (400, [{"error": {"code": 400, "message": "Missing or invalid Authorization header.", "status": "INVALID_ARGUMENT"}}], 401,
     "Google rejected your API key — check it in the app under Settings → Video model."),
    (400, [{"error": {"code": 400, "message": "API key not valid. Please pass a valid API key.", "status": "INVALID_ARGUMENT"}}], 401,
     "Google rejected your API key — check it in the app under Settings → Video model."),
    (400, [{"error": {"code": 400, "message": "Unable to process input image.", "status": "INVALID_ARGUMENT"}}], 502,
     "The AI request failed (400): Unable to process input image."),
    (429, [{"error": {"code": 429, "message": "You exceeded your current quota.", "status": "RESOURCE_EXHAUSTED"}}], 429,
     # Every model answers the same here, so the fallbacks were out of quota as well.
     "Google's rate limit was hit; try again later. (You exceeded your current quota.) "
     "The models tried in its place didn't answer either."),
    (404, [{"error": {"code": 404, "message": "models/gemini-9 is not found", "status": "NOT_FOUND"}}], 422,
     "Google has no model called “gemini-3.8-flash” — check the name in the app under Settings → Video model. "
     "(models/gemini-9 is not found)"),
])
def test_gemini_errors_become_instructions(chat, frames, status, reply, expected_status, expected):
    chat.status, chat.reply = status, reply
    failure = chat_failure(chat, frames, "gemini")
    assert (failure.status, failure.message) == (expected_status, expected)


def test_an_answer_at_the_first_try_costs_one_request(chat, frames, waits):
    for provider in analyzer.PROVIDERS.values():
        if not provider.base_url:
            continue
        chat.requests.clear()
        analyzer.identify_exercises(analyzer.choose_model(provider.id, api_key="k"), frames, INFO, KNOWN)
        assert len(chat.requests) == 1, provider.id
    assert waits == []


GEMINI_BUSY = (503, [{"error": {"code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE"}}])
GEMINI_QUOTA = (429, [{"error": {"code": 429, "message": "You exceeded your current quota.", "status": "RESOURCE_EXHAUSTED"}}])
GEMINI_GONE = (404, [{"error": {"code": 404, "message": "This model is no longer available to new users.", "status": "NOT_FOUND"}}])
GEMINI_FLASH = ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash"]


def gemini(frames, model=None):
    return analyzer.identify_exercises(analyzer.choose_model("gemini", model, "k"), frames, INFO, KNOWN)


def test_when_a_model_is_busy_the_next_free_one_is_asked_straight_away(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY}
    exercises, answered_by = gemini(frames)
    assert exercises == EXERCISES
    assert answered_by == "gemini-3-flash-preview"  # and the app shows that name
    # Gemini's free tier allows 20 requests a day per model: the busy one is not asked twice.
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3-flash-preview"]
    assert waits == []


def test_a_model_out_of_quota_is_not_asked_again_but_the_others_are(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_QUOTA, "gemini-3-flash-preview": GEMINI_BUSY}
    assert gemini(frames)[1] == "gemini-4-hydrogen"
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen"]


def test_a_fallback_that_fails_for_its_own_reasons_is_skipped_quietly(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY, "gemini-3-flash-preview": GEMINI_GONE, "gemini-4-hydrogen": GEMINI_BUSY}
    assert gemini(frames)[1] == "gemini-3.6-flash"
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash"]


def test_when_every_model_is_busy_the_chosen_ones_failure_is_reported(chat, frames, waits):
    chat.status, chat.reply = GEMINI_BUSY
    failure = chat_failure(chat, frames, "gemini")
    assert (failure.status, failure.message) == (
        503, "Google says gemini-3.8-flash is overloaded right now; try again later, or pick another model. "
             "(This model is currently experiencing high demand.) The models tried in its place didn't answer either.")
    assert chat.models_asked == GEMINI_FLASH  # one request per model, and no more
    assert waits == []


@pytest.mark.parametrize("stand_in_answer", [
    (200, ChatAPI.completion("")),                              # answers, but with nothing in it
    (200, ChatAPI.completion("half an ans", "length")),         # cut off
    (200, ChatAPI.completion("no", "content_filter")),          # declines
])
def test_a_stand_in_that_answers_badly_is_passed_over_like_one_that_says_no(chat, frames, stand_in_answer):
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY, "gemini-3-flash-preview": stand_in_answer}
    exercises, answered_by = gemini(frames)
    assert (exercises, answered_by) == (EXERCISES, "gemini-4-hydrogen")
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen"]


def test_when_the_stand_ins_only_fail_in_their_own_ways_the_chosen_models_failure_is_reported(chat, frames):
    empty = (200, ChatAPI.completion(""))
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY, "gemini-3-flash-preview": empty,
                     "gemini-4-hydrogen": empty, "gemini-3.6-flash": empty}
    failure = chat_failure(chat, frames, "gemini")
    assert failure.status == 503
    assert failure.message.startswith("Google says gemini-3.8-flash is overloaded right now")
    assert chat.models_asked == GEMINI_FLASH


def test_the_chosen_models_own_bad_answer_is_still_reported_as_it_was(chat, frames):
    chat.by_model = {"gemini-3.8-flash": (200, ChatAPI.completion(""))}
    failure = chat_failure(chat, frames, "gemini")
    assert (failure.status, failure.message) == (502, "The model returned an empty answer; try again, or pick another model.")
    assert chat.models_asked == ["gemini-3.8-flash"]  # a model that answers is not second-guessed


def test_a_chosen_model_outside_the_fallback_list_is_still_asked_first(chat, frames, waits):
    chat.by_model = {"gemini-3.5-flash-lite": GEMINI_BUSY}
    assert gemini(frames, "gemini-3.5-flash-lite")[1] == "gemini-3.8-flash"
    assert chat.models_asked == ["gemini-3.5-flash-lite", "gemini-3.8-flash"]


def test_a_rejected_key_ends_it_at_once_fallbacks_or_not(chat, frames, waits):
    chat.status, chat.reply = 400, [{"error": {"code": 400, "message": "Please pass a valid API key", "status": "INVALID_ARGUMENT"}}]
    assert chat_failure(chat, frames, "gemini").status == 401
    assert len(chat.requests) == 1 and waits == []


def test_quota_errors_from_every_model_end_with_the_chosen_models(chat, frames, waits):
    chat.status, chat.reply = GEMINI_QUOTA
    failure = chat_failure(chat, frames, "gemini")
    assert failure.status == 429
    assert failure.message.startswith("Google's rate limit was hit; try again later. (You exceeded your current quota.)")
    assert chat.models_asked == GEMINI_FLASH  # each asked once, none twice


def test_only_gemini_has_fallbacks_and_they_are_all_on_its_free_tier():
    assert analyzer.PROVIDERS["gemini"].fallbacks == tuple(GEMINI_FLASH)
    offered = [model_id for model_id, _ in analyzer.PROVIDERS["gemini"].models]
    assert set(GEMINI_FLASH) <= set(offered)
    # Z.ai's other vision models and most of OpenRouter cost money; Claude has its own fallback.
    for provider in ("anthropic", "zai", "openrouter"):
        assert analyzer.PROVIDERS[provider].fallbacks == ()


def test_it_gives_up_before_the_apps_stop_waiting(monkeypatch, chat, frames, waits):
    clock = iter(range(0, 100_000, 60))  # every look at the clock is a minute later
    monkeypatch.setattr(analyzer, "now", lambda: next(clock))
    chat.status, chat.reply = GEMINI_BUSY
    failure = chat_failure(chat, frames, "gemini")
    assert failure.status == 503
    assert len(chat.requests) < len(GEMINI_FLASH)


def test_the_address_of_a_chat_api_can_be_changed_in_the_env_file(monkeypatch, chat, frames):
    monkeypatch.setenv("ZAI_BASE_URL", "https://api.z.ai/api/coding/paas/v4/")
    analyzer.identify_exercises(analyzer.choose_model("zai", api_key="k"), frames, INFO, KNOWN)
    assert str(chat.requests[-1].url) == "https://api.z.ai/api/coding/paas/v4/chat/completions"


def test_an_answer_in_parts_and_with_separate_thinking_is_read(chat, frames):
    chat.reply = {"choices": [{"finish_reason": "stop", "message": {
        "role": "assistant", "reasoning_content": "They are at a cable station…",
        "content": [{"type": "text", "text": ANSWER[:40]}, {"type": "text", "text": ANSWER[40:]}],
    }}]}
    assert analyzer.identify_exercises(analyzer.choose_model("zai", api_key="k"), frames, INFO, KNOWN)[0] == EXERCISES


def chat_failure(chat, frames, provider="zai", key="my-key", **choice) -> analyzer.ModelError:
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.identify_exercises(analyzer.choose_model(provider, api_key=key, **choice), frames, INFO, KNOWN)
    return failure.value


@pytest.mark.parametrize("finish_reason, message", [
    ("length", "The model's answer was cut off; try again."),
    ("model_context_window_exceeded", "The model's answer was cut off; try again."),
    ("sensitive", "The model declined to analyze this video."),
    ("content_filter", "The model declined to analyze this video."),
])
def test_an_answer_that_stopped_early_is_reported(chat, frames, finish_reason, message):
    chat.reply = chat.completion(ANSWER[:30], finish_reason=finish_reason)
    failure = chat_failure(chat, frames)
    assert (failure.status, failure.message) == (502, message)


@pytest.mark.parametrize("reply", [ChatAPI.completion(""), ChatAPI.completion(None), {"choices": []}, {}])
def test_an_empty_answer_is_reported(chat, frames, reply):
    chat.reply = reply
    failure = chat_failure(chat, frames)
    assert (failure.status, failure.message) == (502, "The model returned an empty answer; try again, or pick another model.")


# Error bodies as the two services send them (docs.z.ai "Errors"; OpenRouter "Errors and Debugging").
@pytest.mark.parametrize("provider, status, error, expected_status, expected", [
    ("zai", 401, {"code": "401", "message": "token expired or incorrect"}, 401,
     "Z.ai rejected your API key — check it in the app under Settings → Video model."),
    ("zai", 401, {"code": "1001", "message": "Authentication parameter not received in Header"}, 401,
     "Z.ai rejected your API key — check it in the app under Settings → Video model."),
    ("zai", 429, {"code": "1113", "message": "Insufficient balance or no resource package. Please recharge."}, 402,
     "The Z.ai account has no credit left. (Insufficient balance or no resource package. Please recharge.)"),
    ("zai", 429, {"code": "1302", "message": "Rate limit reached for requests"}, 429,
     "Z.ai's rate limit was hit; try again later. (Rate limit reached for requests)"),
    ("zai", 400, {"code": "1211", "message": "Unknown Model, please check the model code."}, 422,
     "Z.ai has no model called “glm-4.6v-flash” — check the name in the app under Settings → Video model. "
     "(Unknown Model, please check the model code.)"),
    ("zai", 400, {"code": "1301", "message": "System detected potentially unsafe or sensitive content"}, 502,
     "The model declined to analyze this video."),
    ("zai", 400, {"code": "1210", "message": "Invalid API parameter"}, 502, "The AI request failed (400): Invalid API parameter"),
    ("zai", 500, None, 502, "The AI request failed (500): no details given"),
    ("openrouter", 401, {"code": 401, "message": "User not found."}, 401,
     "OpenRouter rejected your API key — check it in the app under Settings → Video model."),
    ("openrouter", 402, {"code": 402, "message": "Insufficient credits"}, 402,
     "The OpenRouter account has no credit left. (Insufficient credits)"),
    ("openrouter", 429, {"code": 429, "message": "Rate limit exceeded: free-models-per-day"}, 429,
     "OpenRouter's rate limit was hit; try again later. (Rate limit exceeded: free-models-per-day)"),
    ("openrouter", 404, {"code": 404, "message": "No endpoints found for nope/nope."}, 422,
     "OpenRouter has no model called “openrouter/free” — check the name in the app under Settings → Video model. "
     "(No endpoints found for nope/nope.)"),
    ("openrouter", 403, {"code": 403, "message": "Your input was flagged"}, 502, "The AI request failed (403): Your input was flagged"),
])
def test_chat_api_errors_become_instructions(chat, frames, provider, status, error, expected_status, expected):
    chat.status, chat.reply = status, ({"error": error} if error else "<html>Bad gateway</html>")
    failure = chat_failure(chat, frames, provider)
    assert (failure.status, failure.message) == (expected_status, expected)


def test_openrouter_errors_inside_a_successful_answer_are_noticed(chat, frames):
    chat.reply = {"error": {"code": 429, "message": "Provider returned error"}}
    assert chat_failure(chat, frames, "openrouter").status == 429
    chat.reply = {"choices": [{"error": {"code": 502, "message": "Upstream timed out"}, "message": {"content": "{\"exer"}}]}
    failure = chat_failure(chat, frames, "openrouter")
    assert (failure.status, failure.message) == (502, "The AI request failed (502): Upstream timed out")


ZAI_OVERLOADED = (429, {"error": {"code": "1305", "message": "The service may be temporarily overloaded, please try again later"}})


def test_an_overloaded_model_is_asked_once_more(chat, frames, waits):
    chat.queue = [ZAI_OVERLOADED]
    exercises, _ = analyzer.identify_exercises(analyzer.choose_model("zai", api_key="k"), frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert len(chat.requests) == 2
    assert waits == [5]
    assert chat.requests[0].content == chat.requests[1].content  # the same question both times


def test_a_model_that_stays_overloaded_is_reported_as_that(chat, frames, waits):
    chat.status, chat.reply = ZAI_OVERLOADED
    failure = chat_failure(chat, frames)
    assert (failure.status, failure.message) == (
        503, "Z.ai says glm-4.6v-flash is overloaded right now; try again later, or pick another model. "
             "(The service may be temporarily overloaded, please try again later)")
    assert len(chat.requests) == 2  # every request counts against a free tier's daily allowance
    assert waits == [5]


@pytest.mark.parametrize("status, reply", [
    (503, {"error": {"code": 503, "message": "No available provider"}}),
    (502, "<html>Bad gateway</html>"),
    (200, {"error": {"code": 529, "message": "Provider overloaded"}}),
])
def test_openrouter_being_busy_is_also_retried(chat, frames, waits, status, reply):
    chat.queue = [(status, reply)]
    assert analyzer.identify_exercises(analyzer.choose_model("openrouter", api_key="k"), frames, INFO, KNOWN)[0] == EXERCISES
    assert waits == [5]


def test_other_failures_are_not_retried(chat, frames, waits):
    for status, error in [(401, {"code": "401", "message": "token expired or incorrect"}),
                          (429, {"code": "1302", "message": "Rate limit reached for requests"}),
                          (429, {"code": "1113", "message": "Insufficient balance"}),
                          (500, {"code": "1200", "message": "API Call Error"})]:
        chat.requests.clear()
        chat.status, chat.reply = status, {"error": error}
        chat_failure(chat, frames)
        assert len(chat.requests) == 1
    assert waits == []


def test_a_rejected_key_from_the_env_file_points_at_the_env_file(monkeypatch, chat, frames):
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    chat.status, chat.reply = 401, {"error": {"code": "401", "message": "token expired or incorrect"}}
    failure = chat_failure(chat, frames, key=None)
    assert (failure.status, failure.message) == (500, "Z.ai rejected the analyzer's API key — check server/.env on the Mac.")


def test_an_unknown_model_from_the_env_file_points_at_the_env_file(monkeypatch, chat, frames):
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    monkeypatch.setenv("ANALYZER_MODEL", "glm-9")
    chat.status, chat.reply = 400, {"error": {"code": "1211", "message": "Unknown Model"}}
    with pytest.raises(analyzer.ModelError) as failure:
        analyzer.identify_exercises(analyzer.choose_model(), frames, INFO, KNOWN)
    assert failure.value.message == "Z.ai has no model called “glm-9” — check the name (ANALYZER_MODEL) in server/.env. (Unknown Model)"


def test_an_api_key_is_never_repeated_in_a_message(chat, frames):
    chat.status, chat.reply = 400, {"error": {"code": 400, "message": "Bad header: Bearer my-secret-key is malformed"}}
    failure = chat_failure(chat, frames, "openrouter", key="my-secret-key")
    assert "my-secret-key" not in failure.message
    assert failure.message == "The AI request failed (400): Bad header: Bearer … is malformed"


def test_a_long_error_is_cut_short(chat, frames):
    chat.status, chat.reply = 500, {"error": {"code": 500, "message": "x" * 5000}}
    assert len(chat_failure(chat, frames).message) < 260


@pytest.mark.parametrize("failure, status, message", [
    (httpx.ReadTimeout("slow"), 504, "Z.ai took too long to answer; try again, or pick a faster model."),
    (httpx.ConnectError("no route"), 502, "The analyzer couldn't reach Z.ai's API."),
])
def test_a_chat_api_that_cannot_be_reached(chat, frames, failure, status, message):
    chat.failure = failure
    found = chat_failure(chat, frames)
    assert (found.status, found.message) == (status, message)


# --- the HTTP service -----------------------------------------------------------

def test_analyze_without_a_model_choice_answers_as_before(service, claude):
    response = post(service)
    assert response.status_code == 200
    body = response.json()
    assert {key: body[key] for key in ("title", "caption", "thumbnail", "exercises")} == {
        "title": "3 cable moves",
        "caption": "Save this for pull day",
        "thumbnail": "data:image/jpeg;base64,AAAA",
        "exercises": EXERCISES,
    }
    assert (body["provider"], body["model"]) == ("anthropic", "claude-opus-5-5")
    assert claude.request["model"] == "claude-opus-5-5"


def test_analyze_with_a_service_model_and_key_of_your_own(service, chat, claude):
    response = post(service, provider="zai", model="glm-5.3-flash", api_key="zai-mine")
    assert response.status_code == 200
    body = response.json()
    assert body["exercises"] == EXERCISES
    assert (body["provider"], body["model"]) == ("zai", "glm-5.3-flash")
    assert chat.requests[-1].headers["authorization"] == "Bearer zai-mine"
    assert chat.body["model"] == "glm-5.3-flash"
    assert claude.request is None  # Claude was not asked


def test_analyze_follows_the_env_file_when_the_app_does_not_choose(monkeypatch, service, chat, claude):
    monkeypatch.setenv("OPENROUTER_API_KEY", "sk-or-server")
    response = post(service)
    assert response.status_code == 200
    assert (response.json()["provider"], response.json()["model"]) == ("openrouter", "openrouter/free")
    assert chat.requests[-1].headers["authorization"] == "Bearer sk-or-server"
    assert claude.request is None


def test_a_service_without_a_key_is_refused_before_the_download(monkeypatch, service, chat):
    monkeypatch.setattr(analyzer, "download", lambda url, workdir: pytest.fail("downloaded anyway"))
    response = post(service, provider="zai")
    assert response.status_code == 500
    assert response.json()["detail"] == ("The analyzer has no Z.ai API key. Put ZAI_API_KEY=… in server/.env on the Mac "
                                         "and restart it, or enter your own key in the app under Settings → Video model.")
    assert chat.requests == []


def test_a_bad_choice_is_refused_before_the_download(monkeypatch, service):
    monkeypatch.setattr(analyzer, "download", lambda url, workdir: pytest.fail("downloaded anyway"))
    assert post(service, provider="openai").status_code == 422
    assert post(service, provider="zai", model="two words", api_key="k").status_code == 422


def test_the_older_refusals_are_unchanged(service, claude):
    response = service.post("/analyze", json={"url": "ftp://example.org/clip"})
    assert (response.status_code, response.json()["detail"]) == (422, "That isn't a web link.")
    assert service.post("/analyze", json={}).status_code == 422


def test_a_model_error_still_cleans_up_and_reports(monkeypatch, tmp_path, service, chat):
    workdir = tmp_path / "work"
    monkeypatch.setattr(analyzer.tempfile, "mkdtemp", lambda prefix="": (workdir.mkdir(), str(workdir))[1])
    chat.reply = chat.completion("no idea, sorry")
    response = post(service, provider="openrouter", api_key="k")
    assert (response.status_code, response.json()["detail"]) == (502, analyzer.UNREADABLE_ANSWER)
    assert not workdir.exists()  # the downloaded video and its frames are gone


def test_health_still_says_ok_and_now_lists_the_services(monkeypatch, service):
    body = service.get("/health").json()
    assert body["ok"] is True
    assert body["default_provider"] == "anthropic"
    assert body["providers"] == [
        {"id": "anthropic", "label": "Anthropic", "default_model": "claude-opus-5-5", "has_key": False},
        {"id": "zai", "label": "Z.ai", "default_model": "glm-4.6v-flash", "has_key": False},
        {"id": "openrouter", "label": "OpenRouter", "default_model": "openrouter/free", "has_key": False},
        {"id": "gemini", "label": "Google", "default_model": "gemini-3.8-flash", "has_key": False},
    ]

    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    monkeypatch.setenv("ANALYZER_MODEL", "glm-5.3-flash")
    body = service.get("/health").json()
    assert body["default_provider"] == "zai"
    assert body["providers"][1] == {"id": "zai", "label": "Z.ai", "default_model": "glm-5.3-flash", "has_key": True}
    assert "zai-server" not in json.dumps(body)

    monkeypatch.setenv("ANALYZER_PROVIDER", "nonsense")  # a typo in the env file must not take /health down
    body = service.get("/health").json()
    assert body["ok"] is True and body["default_provider"] is None


def test_models_for_the_services_with_a_fixed_list(service):
    body = service.get("/models", params={"provider": "zai"}).json()
    assert (body["provider"], body["default_model"]) == ("zai", "glm-4.6v-flash")
    assert body["models"][0] == {"id": "glm-4.6v-flash", "label": "GLM-4.6V Flash — free"}
    assert "glm-5.3-flash" in [model["id"] for model in body["models"]]
    assert [model["id"] for model in service.get("/models", params={"provider": "anthropic"}).json()["models"]] == \
        ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]
    assert [model["id"] for model in service.get("/models", params={"provider": "gemini"}).json()["models"]] == \
        ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash", "gemini-3.5-flash-lite"]
    assert service.get("/models", params={"provider": "openai"}).status_code == 422
    assert service.get("/models").status_code == 422


def openrouter_model(model_id, name, prompt, completion, inputs=("text", "image"), outputs=("text",)):
    return {"id": model_id, "name": name, "pricing": {"prompt": prompt, "completion": completion},
            "architecture": {"input_modalities": list(inputs), "output_modalities": list(outputs)}}


def test_models_for_openrouter_come_from_openrouter(service, chat):
    chat.reply = {"data": [
        openrouter_model("qwen/qwen3.8-flash", "Qwen: Qwen3.8 Flash", "0.00000015", "0.00000047"),
        openrouter_model("anthropic/claude-opus-5.5", "Anthropic: Claude Opus 5.5", "0.000004", "0.00002"),
        openrouter_model("google/gemma-4-31b-it:free", "Google: Gemma 4 31B (free)", "0", "0"),
        openrouter_model("openrouter/free", "Free Models Router", "0", "0"),
        openrouter_model("text/only", "Text Only", "0", "0", inputs=("text",)),
        openrouter_model("google/lyria-3", "Music maker", "0", "0", outputs=("text", "audio")),
        openrouter_model("google/flash-image", "Image maker", "0", "0", outputs=("image", "text")),
        openrouter_model("openrouter/auto", "Auto Router", "-1", "-1"),
        {"id": "broken/entry"},
    ]}
    body = service.get("/models", params={"provider": "openrouter"}).json()
    assert body["default_model"] == "openrouter/free"
    assert body["models"] == [
        {"id": "openrouter/free", "label": "Free Models Router — free"},
        {"id": "google/gemma-4-31b-it:free", "label": "Google: Gemma 4 31B (free) — free"},
        {"id": "qwen/qwen3.8-flash", "label": "Qwen: Qwen3.8 Flash — $0.15 in / $0.47 out per 1M tokens"},
        {"id": "anthropic/claude-opus-5.5", "label": "Anthropic: Claude Opus 5.5 — $4 in / $20 out per 1M tokens"},
    ]
    request = chat.requests[-1]
    assert str(request.url) == "https://openrouter.ai/api/v1/models?input_modalities=image"
    assert "authorization" not in request.headers  # the list is public; no key is sent for it

    service.get("/models", params={"provider": "openrouter"})
    assert len(chat.requests) == 1  # asked once, then remembered


@pytest.mark.parametrize("status, reply", [(500, "<html>down</html>"), (200, {"unexpected": True}), (200, {"data": []})])
def test_models_for_openrouter_fall_back_to_the_built_in_list(service, chat, status, reply):
    chat.status, chat.reply = status, reply
    body = service.get("/models", params={"provider": "openrouter"}).json()
    assert [model["id"] for model in body["models"]] == ["openrouter/free"]


def test_models_for_openrouter_when_it_cannot_be_reached(service, chat):
    chat.failure = httpx.ConnectError("offline")
    assert service.get("/models", params={"provider": "openrouter"}).status_code == 200


def test_the_service_also_answers_for_the_strava_and_garmin_connections(monkeypatch, service, tmp_path):
    monkeypatch.setattr(analyzer.connectors, "STORE", tmp_path / "connections.json")
    monkeypatch.setattr(analyzer.connectors, "GARMIN_TOKENS", tmp_path / "garmin-tokens")
    monkeypatch.delenv("STRAVA_CLIENT_ID", raising=False)
    body = service.get("/connections").json()
    assert sorted(body) == ["garmin", "strava"]
    assert body["strava"]["connected"] is False
    # Not connected: the request is understood and refused, rather than unknown.
    response = service.post("/exports/strava", json={"workout": {"id": "w", "started_at": 1_795_712_400_000, "ended_at": 1_795_712_460_000}})
    assert response.status_code == 409


def test_the_start_up_line_names_the_model(monkeypatch):
    assert analyzer.describe_model() == "claude-opus-5-5 from Anthropic — but there is no ANTHROPIC_API_KEY in server/.env yet"
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    assert analyzer.describe_model() == "glm-4.6v-flash from Z.ai"
    monkeypatch.setenv("ANALYZER_PROVIDER", "nonsense")
    assert "ANALYZER_PROVIDER" in analyzer.describe_model()


def read_env_file(monkeypatch, tmp_path, text: str, already: dict | None = None) -> dict:
    """What load_env_file makes of a server/.env holding `text`, in an environment of its own."""
    (tmp_path / ".env").write_text(text)
    monkeypatch.setattr(analyzer, "__file__", str(tmp_path / "analyzer.py"))
    environ = dict(already or {})
    analyzer.load_env_file(environ)
    return environ


def test_the_env_file_is_read_without_overriding_what_is_already_set(monkeypatch, tmp_path):
    text = "# keys\nZAI_API_KEY='from-file'\nANALYZER_MODEL = glm-5.3-flash \nnot a setting\n"
    assert read_env_file(monkeypatch, tmp_path, text, {"ANALYZER_MODEL": "already-set"}) == {
        "ZAI_API_KEY": "from-file", "ANALYZER_MODEL": "already-set"}
    assert read_env_file(monkeypatch, tmp_path, text)["ANALYZER_MODEL"] == "glm-5.3-flash"
    assert "ZAI_API_KEY" not in analyzer.os.environ  # reading into a dict of its own left the real environment alone


def test_a_note_after_a_value_in_the_env_file_is_not_part_of_the_value(monkeypatch, tmp_path):
    text = (
        "ANALYZER_PROVIDER=zai           # anthropic, zai, openrouter or gemini\n"
        "ZAI_API_KEY=abc123\t# from z.ai\n"
        "ANALYZER_MODEL='glm # five'   \n"       # quoted: the hash is part of the value
        "OPENROUTER_API_KEY=sk#or-1\n"            # no space before the hash: part of the value
        'GEMINI_API_KEY="AIza-x" # the free tier\n'
        "PORT=\n"
    )
    assert read_env_file(monkeypatch, tmp_path, text) == {
        "ANALYZER_PROVIDER": "zai", "ZAI_API_KEY": "abc123", "ANALYZER_MODEL": "glm # five",
        "OPENROUTER_API_KEY": "sk#or-1", "GEMINI_API_KEY": "AIza-x", "PORT": "",
    }


def test_a_missing_env_file_changes_nothing(monkeypatch, tmp_path):
    monkeypatch.setattr(analyzer, "__file__", str(tmp_path / "analyzer.py"))
    environ: dict = {}
    analyzer.load_env_file(environ)
    assert environ == {}


def test_a_model_name_from_the_env_file_is_checked_like_one_from_the_app(monkeypatch):
    monkeypatch.setenv("ANALYZER_MODEL", "two words")
    with pytest.raises(analyzer.ModelError) as refused:
        analyzer.choose_model()
    assert (refused.value.status, refused.value.message) == (
        500, "ANALYZER_MODEL in server/.env has characters a model name can't have.")
    # It only matters for the service it is meant for.
    assert analyzer.choose_model("zai", "glm-5.3-flash", "k").model == "glm-5.3-flash"


# --- turning a link into frames ---------------------------------------------------

class Downloader:
    """Stands in for yt_dlp.YoutubeDL: says what `info` says about the link and writes `files` when asked to download."""

    def __init__(self, info: dict | None, files: tuple[str, ...] = ("video.mp4",)) -> None:
        self.info, self.files = info, files
        self.options: dict = {}
        self.downloaded: list[str] = []

    def __call__(self, options: dict) -> "Downloader":
        self.options = options
        return self

    def __enter__(self) -> "Downloader":
        return self

    def __exit__(self, *problem) -> bool:
        return False

    def extract_info(self, url: str, download: bool = True) -> dict | None:
        assert download is False
        return self.info

    def download(self, urls: list[str]) -> None:
        self.downloaded += urls
        for name in self.files:
            (Path(self.options["outtmpl"]).parent / name).write_bytes(b"video")


def test_a_clip_is_downloaded_with_limits_on_time_and_size(monkeypatch, tmp_path):
    downloader = Downloader({"title": "Leg day", "duration": 45})
    monkeypatch.setattr(analyzer.yt_dlp, "YoutubeDL", downloader)
    video, info = analyzer.download("https://youtube.com/shorts/abc", tmp_path)
    assert (video, info["title"]) == (tmp_path / "video.mp4", "Leg day")
    assert downloader.downloaded == ["https://youtube.com/shorts/abc"]
    assert downloader.options["max_filesize"] == analyzer.MAX_VIDEO_BYTES
    assert downloader.options["socket_timeout"] == 30
    assert downloader.options["noplaylist"] is True
    assert downloader.options["color"] == "no_color"  # its messages are shown in the app
    assert "cookiesfrombrowser" not in downloader.options


def test_the_browser_login_is_borrowed_only_when_asked_for(monkeypatch, tmp_path):
    downloader = Downloader({"duration": 45})
    monkeypatch.setattr(analyzer.yt_dlp, "YoutubeDL", downloader)
    monkeypatch.setenv("YTDLP_COOKIES_FROM_BROWSER", "safari")
    analyzer.download("https://www.instagram.com/reel/Cxyz123/", tmp_path)
    assert downloader.options["cookiesfrombrowser"] == ("safari",)


@pytest.mark.parametrize("info, message", [
    ({"duration": 601}, "That video is 10:01 long; this works on short clips (up to 10 minutes)."),
    ({"duration": 3725.4}, "That video is 62:05 long; this works on short clips (up to 10 minutes)."),
    ({"is_live": True}, "That is a live stream; this works on clips that have ended."),
    ({"_type": "playlist", "entries": []}, "That link is a playlist or a profile; this needs the link of one video."),
    ({"entries": [{"id": "a"}, {"id": "b"}]}, "That link is a playlist or a profile; this needs the link of one video."),
])
def test_what_is_not_one_short_clip_is_refused_before_anything_is_downloaded(monkeypatch, tmp_path, info, message):
    downloader = Downloader(info)
    monkeypatch.setattr(analyzer.yt_dlp, "YoutubeDL", downloader)
    with pytest.raises(analyzer.VideoError) as refused:
        analyzer.download("https://youtube.com/watch?v=abc", tmp_path)
    assert (refused.value.status, refused.value.message) == (422, message)
    assert downloader.downloaded == []


def test_a_clip_of_exactly_ten_minutes_or_of_unknown_length_is_taken(monkeypatch, tmp_path):
    for info in ({"duration": 600}, {}, None):
        downloader = Downloader(info)
        monkeypatch.setattr(analyzer.yt_dlp, "YoutubeDL", downloader)
        analyzer.download("https://example.org/clip.mp4", tmp_path)
        assert len(downloader.downloaded) == 1


def test_a_download_that_leaves_no_file_says_so(monkeypatch, tmp_path):
    for files in ((), ("video.mp4.part",)):  # nothing at all, or only a part cut off by the size limit
        monkeypatch.setattr(analyzer.yt_dlp, "YoutubeDL", Downloader({"duration": 30}, files=files))
        with pytest.raises(analyzer.VideoError) as failed:
            analyzer.download("https://example.org/huge.mp4", tmp_path)
        assert (failed.value.status, failed.value.message) == (
            502, "The download produced no video file — the clip may be larger than 300 MB.")


def test_a_video_whose_length_cannot_be_read_is_an_error_in_words(monkeypatch, tmp_path):
    ran: list[dict] = []

    def ffprobe(command, **options):
        ran.append(options)
        return SimpleNamespace(stdout="N/A\n")

    monkeypatch.setattr(analyzer.subprocess, "run", ffprobe)
    with pytest.raises(analyzer.VideoError) as failed:
        analyzer.probe_duration(tmp_path / "video.mp4")
    assert (failed.value.status, failed.value.message) == (502, "Couldn't tell how long the video is.")
    assert ran[0]["timeout"] == 60  # and it is never waited on for ever


def test_the_frame_step_cannot_hang_or_wait_for_the_keyboard(monkeypatch, tmp_path):
    commands: list[tuple[list[str], dict]] = []

    def run(command, **options):
        commands.append((command, options))
        return SimpleNamespace(stdout="12.0\n")

    monkeypatch.setattr(analyzer.subprocess, "run", run)
    analyzer.extract_frames(tmp_path / "video.mp4", tmp_path)
    ffmpeg, options = commands[-1]
    assert ffmpeg[:2] == ["ffmpeg", "-nostdin"]
    assert options["timeout"] == 180


def test_messages_from_the_downloader_are_made_fit_to_show():
    assert analyzer.plain("\x1b[0;31mERROR:\x1b[0m [Instagram] Cxyz: login required") == "[Instagram] Cxyz: login required"
    assert analyzer.plain("ERROR: Unsupported URL") == "Unsupported URL"
    assert analyzer.plain("  plain words  ") == "plain words"
    assert len(analyzer.plain("x" * 500)) == 200


def failing_download(monkeypatch, error: Exception) -> None:
    def download(url, workdir):
        raise error
    monkeypatch.setattr(analyzer, "download", download)


def test_a_refused_clip_is_reported_in_the_services_own_words(monkeypatch, service):
    failing_download(monkeypatch, analyzer.VideoError(422, "That is a live stream; this works on clips that have ended."))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (422, "That is a live stream; this works on clips that have ended.")


def test_a_failed_download_is_reported_without_terminal_colours(monkeypatch, service):
    failing_download(monkeypatch, yt_dlp.utils.DownloadError("\x1b[0;31mERROR:\x1b[0m [youtube] abc: Video unavailable"))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (
        502, "Couldn't download the video. ([youtube] abc: Video unavailable)")


def test_an_instagram_failure_without_a_login_says_how_to_lend_one(monkeypatch, service):
    failing_download(monkeypatch, yt_dlp.utils.DownloadError("ERROR: [Instagram] Cxyz123: login required"))
    link = "https://www.instagram.com/reel/Cxyz123/"
    detail = post(service, url=link).json()["detail"]
    assert "start the analyzer with YTDLP_COOKIES_FROM_BROWSER=safari (or chrome)" in detail
    monkeypatch.setenv("YTDLP_COOKIES_FROM_BROWSER", "safari")
    assert "YTDLP_COOKIES_FROM_BROWSER" not in post(service, url=link).json()["detail"]


def test_cookies_that_cannot_be_read_are_a_502_with_the_way_out_not_a_bare_500(monkeypatch, service):
    class CookieLoadError(yt_dlp.utils.YoutubeDLError):  # what yt-dlp raises; not a DownloadError
        pass

    monkeypatch.setenv("YTDLP_COOKIES_FROM_BROWSER", "safari")
    failing_download(monkeypatch, CookieLoadError("failed to load cookies"))
    response = post(service, url="https://www.instagram.com/reel/Cxyz123/")
    assert response.status_code == 502
    assert "couldn't be borrowed from safari" in response.json()["detail"]
    assert "Full Disk Access" in response.json()["detail"]


@pytest.mark.parametrize("error, detail", [
    (subprocess.CalledProcessError(1, "ffmpeg", stderr="\x1b[31mmoov atom not found\x1b[0m"), "Couldn't read the video file. (moov atom not found)"),
    (subprocess.TimeoutExpired("ffmpeg", 180), "Reading the video file took too long."),
    (analyzer.VideoError(502, "Couldn't tell how long the video is."), "Couldn't tell how long the video is."),
])
def test_a_video_that_cannot_be_read_is_reported_and_cleaned_up(monkeypatch, tmp_path, service, error, detail):
    workdir = tmp_path / "work"
    monkeypatch.setattr(analyzer.tempfile, "mkdtemp", lambda prefix="": (workdir.mkdir(), str(workdir))[1])

    def extract_frames(video, folder):
        raise error
    monkeypatch.setattr(analyzer, "extract_frames", extract_frames)
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (502, detail)
    assert not workdir.exists()


# --- what a caller may point the service at ---------------------------------------

@pytest.mark.parametrize("addresses, inside", [
    ({"8.8.8.8"}, False), ({"2001:4860:4860::8888"}, False),
    ({"127.0.0.1"}, True), ({"::1"}, True), ({"192.168.1.1"}, True), ({"10.0.0.5"}, True), ({"172.20.3.4"}, True),
    ({"169.254.169.254"}, True),  # link-local, where cloud machines keep their credentials
    ({"100.100.20.3"}, True),     # carrier-grade NAT, which is also what Tailscale hands out
    ({"fe80::1"}, True), ({"fd12:3456::1"}, True),
    ({"8.8.8.8", "192.168.1.1"}, True),  # one inside address among them is enough
    (set(), False),  # a name that can't be looked up: the download will say so itself
])
def test_which_links_lead_into_the_local_network(monkeypatch, addresses, inside):
    monkeypatch.setattr(analyzer, "addresses_of", lambda host: addresses)
    assert analyzer.points_inside("https://videos.example.org/clip") is inside


def test_the_host_of_a_link_is_what_gets_looked_up(monkeypatch):
    asked: list[str] = []
    monkeypatch.setattr(analyzer, "addresses_of", lambda host: asked.append(host) or {PUBLIC_ADDRESS})
    analyzer.points_inside("https://user:secret@Videos.Example.org:8443/clip?x=http://192.168.1.1/")
    assert asked == ["videos.example.org"]


def test_literal_addresses_need_no_lookup(monkeypatch):
    monkeypatch.undo()  # the real resolver: literal addresses never leave the machine
    assert analyzer.addresses_of("127.0.0.1") == {"127.0.0.1"}
    assert analyzer.addresses_of("192.168.1.20") == {"192.168.1.20"}
    assert analyzer.points_inside("http://127.0.0.1:8080/admin") is True
    assert analyzer.points_inside("http://[::1]/admin") is True
    assert analyzer.points_inside("http://192.168.1.1/") is True
    assert analyzer.points_inside("http://8.8.8.8/clip.mp4") is False
    assert analyzer.points_inside("http://203.0.113.7/clip.mp4") is True  # a documentation range: not a place videos live


def test_a_link_into_the_local_network_is_refused_before_anything_is_fetched(monkeypatch, service):
    monkeypatch.setattr(analyzer, "addresses_of", lambda host: {"192.168.1.1"})
    monkeypatch.setattr(analyzer, "download", lambda url, workdir: pytest.fail("fetched anyway"))
    response = post(service, url="http://router.home/status")
    assert (response.status_code, response.json()["detail"]) == (
        422, "That link leads into the local network, not to a video site.")


def test_local_links_can_be_allowed_on_purpose(monkeypatch, service, claude):
    monkeypatch.setattr(analyzer, "addresses_of", lambda host: {"192.168.1.50"})
    monkeypatch.setenv("ALLOW_LOCAL_VIDEO_LINKS", "1")
    assert post(service, url="http://nas.home/clips/squat.mp4").status_code == 200


@pytest.mark.parametrize("host, allowed", [
    ("localhost", True), ("localhost:8787", True), ("LOCALHOST:8787", True),
    ("192.168.1.237:8787", True), ("127.0.0.1", True), ("[::1]:8787", True), ("[fe80::1]", True), ("100.100.20.3:8787", True),
    ("my-mac.local:8787", True), ("My-Mac.local.", True), ("app.localhost:8787", True),
    ("evil.example:8787", False), ("192.168.1.237.evil.example", False), ("localhost.evil.example", False),
    ("notlocal:8787", False), ("", False), ("mac.tailnet.ts.net", False),
])
def test_which_names_the_service_answers_to(host, allowed):
    assert analyzer.host_allowed(host) is allowed


def test_more_names_can_be_listed_for_a_tunnel_or_a_tailnet(monkeypatch):
    monkeypatch.setenv("ALLOWED_HOSTS", " mac.tailnet.ts.net , *.trycloudflare.com ")
    assert analyzer.host_allowed("mac.tailnet.ts.net:443") is True
    assert analyzer.host_allowed("quiet-river.trycloudflare.com") is True
    assert analyzer.host_allowed("trycloudflare.com") is False  # the wildcard is for names under it
    assert analyzer.host_allowed("other.tailnet.ts.net") is False
    assert analyzer.host_allowed("eviltrycloudflare.com") is False


def test_a_request_under_a_strangers_domain_is_turned_away_whatever_it_asks_for(monkeypatch, service):
    monkeypatch.setattr(analyzer, "download", lambda url, workdir: pytest.fail("served a stranger"))
    stranger = {"Host": "rebind.evil.example:8787"}
    for response in (service.get("/health", headers=stranger),
                     service.post("/analyze", json={"url": "https://youtube.com/shorts/abc"}, headers=stranger),
                     service.post("/strava/disconnect", headers=stranger),
                     service.get("/inbox/a1b2c3d4e5f6a7b8", headers=stranger)):
        assert response.status_code == 421
        assert "doesn't go by the name “rebind.evil.example:8787”" in response.json()["detail"]
        assert "ALLOWED_HOSTS" in response.json()["detail"]
    assert service.get("/health", headers={"Host": "my-mac.local:8787"}).status_code == 200
    assert service.get("/health", headers={"Host": "192.168.1.237:8787"}).status_code == 200


def test_a_web_app_hosted_elsewhere_can_read_the_garmin_code_header(monkeypatch, tmp_path):
    hosted = FastAPI()

    @hosted.post("/garmin/connect")
    def needs_code() -> dict:
        raise analyzer.HTTPException(409, "Enter the code.", headers={"X-Needs-Code": "1"})

    monkeypatch.setattr(analyzer, "app", hosted)
    monkeypatch.setattr(analyzer, "WEB_APP", tmp_path / "not-built")
    monkeypatch.setenv("ALLOWED_ORIGINS", "https://me.example, https://other.example")
    assert analyzer.serve_web_app() is False  # nothing built to serve; the cross-origin rules still apply

    response = TestClient(hosted).post("/garmin/connect", headers={"Origin": "https://me.example"})
    assert response.headers["x-needs-code"] == "1"
    assert response.headers["access-control-allow-origin"] == "https://me.example"
    assert response.headers["access-control-expose-headers"] == "X-Needs-Code"
    stranger = TestClient(hosted).post("/garmin/connect", headers={"Origin": "https://evil.example"})
    assert "access-control-allow-origin" not in stranger.headers


def test_the_service_also_takes_links_shared_from_other_apps(monkeypatch, tmp_path, service):
    monkeypatch.setattr(inbox, "STORE", tmp_path / "inbox.json")
    code = "a1b2c3d4e5f6a7b8"
    assert service.post(f"/inbox/{code}", json={"url": "https://www.instagram.com/reel/Cxyz123/"}).json()["saved"] is True
    assert [link["url"] for link in service.get(f"/inbox/{code}").json()["links"]] == ["https://www.instagram.com/reel/Cxyz123/"]


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
