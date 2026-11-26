"""Stand-in for analyzer.py: same endpoints and response shape, canned answer.

Lets the app's half be tested without downloading a video or calling Claude:

    python3 server/stub_analyzer.py 8799
    TEST_RUNNER_ANALYZER_URL=http://localhost:8799 xcodebuild … -scheme GymTrackerUITests test

A link containing "fail" gets the error response instead.
"""
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

CANNED = {
    "title": "3 cable moves for rear delts",
    "caption": "Save this for your next pull day",
    "exercises": [
        {"name": "Cable Face Pull", "library_match": "Face Pull (Cable)", "muscle_group": "shoulders",
         "equipment": "cable", "notes": "Rope at eye level, pull to the forehead, elbows high.", "sets_reps": "3 x 15"},
        {"name": "Half-Kneeling Cable Y Raise", "library_match": None, "muscle_group": "shoulders",
         "equipment": "cable", "notes": "One knee down, raise the arm up and out in a Y.", "sets_reps": None},
    ],
}

class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send(200, {"status": "ok"}) if self.path == "/health" else self._send(404, {"detail": "Not Found"})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        print("ANALYZE", body.get("url"), "known:", len(body.get("known_exercises", [])), flush=True)
        if "fail" in body.get("url", ""):
            self._send(422, {"detail": "Could not download that video (stub)."})
        else:
            self._send(200, CANNED)

HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
