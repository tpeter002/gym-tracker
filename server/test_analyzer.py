# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic", "fastapi", "httpx", "uvicorn", "yt-dlp", "pytest"]
# ///
"""Tests for analyzer.py.

    uv run server/test_analyzer.py            # all of them
    uv run server/test_analyzer.py -k zai     # the ones with "zai" in their name

Nothing here downloads a video or calls a model: the download and frame steps
are replaced, Claude's SDK client is a stand-in, and the Z.ai / OpenRouter
requests go to an in-process transport that records them.
"""

from __future__ import annotations

import base64
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx
import pytest
from fastapi.testclient import TestClient

import analyzer

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
            "ANALYZER_PROVIDER", "ANALYZER_MODEL", "ZAI_BASE_URL", "OPENROUTER_BASE_URL", "GEMINI_BASE_URL"]


def b64(data: bytes) -> str:
    return base64.standard_b64encode(data).decode("ascii")


@pytest.fixture(autouse=True)
def clean_settings(monkeypatch):
    """Each test starts as a machine with nothing in server/.env."""
    for name in SETTINGS:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(analyzer, "_openrouter_models", None)


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

    def __init__(self, answer: str = ANSWER, error: Exception | None = None, stop_reason: str = "end_turn",
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
        return SimpleNamespace(stop_reason=self.stop_reason, model=self.model or request["model"],
                               content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=self.answer)])


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
    return TestClient(analyzer.app)


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
    assert claude.built_with == {}  # the SDK finds the key in the environment itself
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
    assert claude.built_with == {"api_key": "sk-ant-mine"}
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
])
def test_claude_failures_keep_their_messages(monkeypatch, service, error, status, message):
    monkeypatch.setattr(analyzer.anthropic, "Anthropic", FakeClaude(error=error))
    response = post(service)
    assert (response.status_code, response.json()["detail"]) == (status, message)


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


def test_gemini_being_overloaded_is_retried(chat, frames, waits):
    chat.queue = [(503, [{"error": {"code": 503, "message": "The model is overloaded. Please try again later.", "status": "UNAVAILABLE"}}])]
    chat.reply = chat.completion(ANSWER)
    assert analyzer.identify_exercises(analyzer.choose_model("gemini", api_key="k"), frames, INFO, KNOWN)[0] == EXERCISES
    assert waits == [2]


GEMINI_BUSY = (503, [{"error": {"code": 503, "message": "This model is currently experiencing high demand.", "status": "UNAVAILABLE"}}])
GEMINI_QUOTA = (429, [{"error": {"code": 429, "message": "You exceeded your current quota.", "status": "RESOURCE_EXHAUSTED"}}])
GEMINI_GONE = (404, [{"error": {"code": 404, "message": "This model is no longer available to new users.", "status": "NOT_FOUND"}}])
GEMINI_FLASH = ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash"]


def gemini(frames, model=None):
    return analyzer.identify_exercises(analyzer.choose_model("gemini", model, "k"), frames, INFO, KNOWN)


def test_a_busy_model_gets_a_second_chance_before_others_are_asked(chat, frames, waits):
    chat.queue = [GEMINI_BUSY]
    assert gemini(frames) == (EXERCISES, "gemini-3.8-flash")
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3.8-flash"]
    assert waits == [2]


def test_while_a_model_stays_busy_the_next_free_one_answers(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY}
    exercises, answered_by = gemini(frames)
    assert exercises == EXERCISES
    assert answered_by == "gemini-3-flash-preview"  # and the app shows that name
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3-flash-preview"]
    assert waits == [2]


def test_a_model_out_of_quota_is_not_asked_again_but_the_others_are(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_QUOTA, "gemini-3-flash-preview": GEMINI_BUSY}
    assert gemini(frames)[1] == "gemini-4-hydrogen"
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen"]


def test_a_fallback_that_fails_for_its_own_reasons_is_skipped_quietly(chat, frames, waits):
    chat.by_model = {"gemini-3.8-flash": GEMINI_BUSY, "gemini-3-flash-preview": GEMINI_GONE, "gemini-4-hydrogen": GEMINI_BUSY}
    assert gemini(frames)[1] == "gemini-3.6-flash"
    assert chat.models_asked == ["gemini-3.8-flash", "gemini-3.8-flash", "gemini-3-flash-preview", "gemini-4-hydrogen", "gemini-3.6-flash"]


def test_when_every_model_is_busy_the_chosen_ones_failure_is_reported(chat, frames, waits):
    chat.status, chat.reply = GEMINI_BUSY
    failure = chat_failure(chat, frames, "gemini")
    assert (failure.status, failure.message) == (
        503, "Google says gemini-3.8-flash is overloaded right now; try again later, or pick another model. "
             "(This model is currently experiencing high demand.) The models tried in its place didn't answer either.")
    assert chat.models_asked == ["gemini-3.8-flash", *GEMINI_FLASH * 3]
    assert waits == [2, 5, 10]


def test_a_chosen_model_outside_the_fallback_list_is_still_asked_first(chat, frames, waits):
    chat.by_model = {"gemini-3.5-flash-lite": GEMINI_BUSY}
    assert gemini(frames, "gemini-3.5-flash-lite")[1] == "gemini-3.8-flash"
    assert chat.models_asked == ["gemini-3.5-flash-lite", "gemini-3.5-flash-lite", "gemini-3.8-flash"]


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
    assert len(chat.requests) < 8 and len(waits) < 3


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


def test_an_overloaded_model_is_asked_again(chat, frames, waits):
    chat.queue = [ZAI_OVERLOADED, ZAI_OVERLOADED]
    exercises, _ = analyzer.identify_exercises(analyzer.choose_model("zai", api_key="k"), frames, INFO, KNOWN)
    assert exercises == EXERCISES
    assert len(chat.requests) == 3
    assert waits == [2, 5]
    assert chat.requests[0].content == chat.requests[2].content  # the same question each time


def test_a_model_that_stays_overloaded_is_reported_as_that(chat, frames, waits):
    chat.status, chat.reply = ZAI_OVERLOADED
    failure = chat_failure(chat, frames)
    assert (failure.status, failure.message) == (
        503, "Z.ai says glm-4.6v-flash is overloaded right now; try again later, or pick another model. "
             "(The service may be temporarily overloaded, please try again later)")
    assert len(chat.requests) == 4
    assert waits == [2, 5, 10]


@pytest.mark.parametrize("status, reply", [
    (503, {"error": {"code": 503, "message": "No available provider"}}),
    (502, "<html>Bad gateway</html>"),
    (200, {"error": {"code": 529, "message": "Provider overloaded"}}),
])
def test_openrouter_being_busy_is_also_retried(chat, frames, waits, status, reply):
    chat.queue = [(status, reply)]
    assert analyzer.identify_exercises(analyzer.choose_model("openrouter", api_key="k"), frames, INFO, KNOWN)[0] == EXERCISES
    assert waits == [2]


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


def test_a_model_error_still_cleans_up_and_reports(service, chat):
    chat.reply = chat.completion("no idea, sorry")
    response = post(service, provider="openrouter", api_key="k")
    assert (response.status_code, response.json()["detail"]) == (502, analyzer.UNREADABLE_ANSWER)


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


def test_the_start_up_line_names_the_model(monkeypatch):
    assert analyzer.describe_model() == "claude-opus-5-5 from Anthropic — but there is no ANTHROPIC_API_KEY in server/.env yet"
    monkeypatch.setenv("ZAI_API_KEY", "zai-server")
    assert analyzer.describe_model() == "glm-4.6v-flash from Z.ai"
    monkeypatch.setenv("ANALYZER_PROVIDER", "nonsense")
    assert "ANALYZER_PROVIDER" in analyzer.describe_model()


def test_the_env_file_is_read_without_overriding_what_is_already_set(monkeypatch, tmp_path):
    (tmp_path / ".env").write_text("# keys\nZAI_API_KEY='from-file'\nANALYZER_MODEL = glm-5.3-flash \nnot a setting\n")
    monkeypatch.setattr(analyzer, "__file__", str(tmp_path / "analyzer.py"))
    monkeypatch.setenv("ANALYZER_MODEL", "already-set")
    analyzer.load_env_file()
    monkeypatch.setenv("ZAI_API_KEY", analyzer.os.environ["ZAI_API_KEY"])  # so the fixture removes it again
    assert analyzer.os.environ["ZAI_API_KEY"] == "from-file"
    assert analyzer.os.environ["ANALYZER_MODEL"] == "already-set"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q", "-p", "no:cacheprovider", "-W", "ignore::pytest.PytestAssertRewriteWarning", *sys.argv[1:]]))
