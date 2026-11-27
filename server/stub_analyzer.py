"""Stand-in for the video part of analyzer.py, with a canned answer.

Lets an app's half be tested without downloading a video or calling a model:

    python3 server/stub_analyzer.py 8799
    TEST_RUNNER_ANALYZER_URL=http://localhost:8799 xcodebuild … -scheme GymTrackerUITests test

It answers GET /health and POST /analyze with the same fields as the real
service. Nothing else the real one offers is here: no list of models, no inbox
for shared links, no Strava or Garmin. A link containing "fail" gets an error.
"""

import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CANNED = {
    "title": "3 cable moves for rear delts",
    "caption": "Save this for your next pull day",
    "thumbnail": None,
    "exercises": [
        {"name": "Cable Face Pull", "library_match": "Face Pull (Cable)", "muscle_group": "shoulders",
         "equipment": "cable", "notes": "Rope at eye level, pull to the forehead, elbows high.", "sets_reps": "3 x 15"},
        {"name": "Half-Kneeling Cable Y Raise", "library_match": None, "muscle_group": "shoulders",
         "equipment": "cable", "notes": "One knee down, raise the arm up and out in a Y.", "sets_reps": None},
    ],
    "provider": "stub",
    "model": "canned-answer",
}


class Handler(BaseHTTPRequestHandler):
    def answer(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            self.answer(200, {"ok": True, "default_provider": None, "providers": []})
        else:
            self.answer(404, {"detail": "Not Found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self.answer(404, {"detail": "Not Found"})
            return
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        print("ANALYZE", body.get("url"), "known:", len(body.get("known_exercises", [])), flush=True)
        if "fail" in body.get("url", ""):
            self.answer(422, {"detail": "Could not download that video (stub)."})
        else:
            self.answer(200, CANNED)


if __name__ == "__main__":
    if len(sys.argv) != 2 or not sys.argv[1].isdigit():
        sys.exit("usage: python3 server/stub_analyzer.py <port>")
    HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
