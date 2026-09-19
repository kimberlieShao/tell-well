"""The standalone WHOOP connector (whoop_connect.py), against a fake WHOOP API."""

import base64
import hashlib
import hmac
import json
import os
import time
from urllib.parse import parse_qs

import httpx
from fastapi.testclient import TestClient

from whoop_connect import TOKEN_URL, Config, create_app

SLEEP = {
    "id": "s1", "cycle_id": 7, "user_id": 4242, "start": "2026-09-18T03:00:00.000Z",
    "end": "2026-09-18T11:30:00.000Z", "timezone_offset": "-04:00", "nap": False, "score_state": "SCORED",
    "score": {"sleep_performance_percentage": 84, "sleep_efficiency_percentage": 91.5,
              "sleep_consistency_percentage": 77, "respiratory_rate": 15.1,
              "stage_summary": {"total_in_bed_time_milli": 30_600_000, "total_awake_time_milli": 1_800_000,
                                "total_light_sleep_time_milli": 10_800_000,
                                "total_slow_wave_sleep_time_milli": 3_600_000,
                                "total_rem_sleep_time_milli": 3_600_000, "disturbance_count": 6}},
}
NAP = {**SLEEP, "id": "nap1", "nap": True, "start": "2026-09-18T19:00:00.000Z", "end": "2026-09-18T19:40:00.000Z"}
RECOVERY = {"cycle_id": 7, "sleep_id": "s1", "user_id": 4242, "score_state": "SCORED",
            "score": {"recovery_score": 41, "resting_heart_rate": 63, "hrv_rmssd_milli": 38.2,
                      "spo2_percentage": 95.8, "skin_temp_celsius": 33.9, "user_calibrating": False}}
CYCLE = {"id": 7, "user_id": 4242, "start": "2026-09-18T03:00:00.000Z", "timezone_offset": "-04:00",
         "score_state": "SCORED", "score": {"strain": 11.2, "kilojoule": 8000, "average_heart_rate": 74,
                                             "max_heart_rate": 151}}


class FakeWhoop:
    def __init__(self):
        self.refresh_count = 0
        self.revoked = False
        self.tokens_seen: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if str(request.url) == TOKEN_URL:
            form = parse_qs(request.content.decode())
            assert form["client_secret"] == ["secret"]
            if form["grant_type"] == ["authorization_code"]:
                return httpx.Response(200, json={"access_token": "at1", "refresh_token": "rt1", "expires_in": 3600,
                                                 "scope": "offline read:sleep"})
            assert form["refresh_token"] == [f"rt{self.refresh_count + 1}"]  # rotated token is used
            self.refresh_count += 1
            n = self.refresh_count + 1
            return httpx.Response(200, json={"access_token": f"at{n}", "refresh_token": f"rt{n}", "expires_in": 3600})
        self.tokens_seen.append(request.headers["authorization"])
        path = request.url.path.removeprefix("/developer")
        if request.method == "DELETE" and path == "/v2/user/access":
            self.revoked = True
            return httpx.Response(204)
        routes = {
            "/v2/user/profile/basic": {"user_id": 4242, "first_name": "Sam", "last_name": "Lee",
                                       "email": "sam@example.com"},
            "/v2/recovery": {"records": [RECOVERY], "next_token": None},
            "/v2/cycle": {"records": [CYCLE], "next_token": None},
            "/v2/activity/sleep/s1": SLEEP,
            "/v2/cycle/7/recovery": RECOVERY,
        }
        if path == "/v2/activity/sleep":  # two pages, to exercise pagination
            if request.url.params.get("nextToken") == "p2":
                return httpx.Response(200, json={"records": [NAP], "next_token": None})
            assert request.url.params["limit"] == "25"
            return httpx.Response(200, json={"records": [SLEEP], "next_token": "p2"})
        if path in routes:
            return httpx.Response(200, json=routes[path])
        return httpx.Response(404)


def _signed(body: dict) -> tuple[bytes, dict]:
    raw = json.dumps(body).encode()
    ts = str(int(time.time() * 1000))
    sig = base64.b64encode(hmac.new(b"secret", ts.encode() + raw, hashlib.sha256).digest()).decode()
    return raw, {"X-WHOOP-Signature": sig, "X-WHOOP-Signature-Timestamp": ts, "Content-Type": "application/json"}


def test_connect_pull_refresh_webhook_disconnect(tmp_path):
    fake = FakeWhoop()
    token_file = tmp_path / "whoop_tokens.json"
    app = create_app(Config(client_id="cid", client_secret="secret", token_file=token_file),
                     transport=httpx.MockTransport(fake))
    with TestClient(app) as client:
        assert client.get("/status").json() == {"connected": False}
        assert client.get("/daily").status_code == 409

        # 1. Sign in
        login = client.get("/login", follow_redirects=False)
        location = httpx.URL(login.headers["location"])
        scopes = location.params["scope"].split()
        assert set(scopes) == {"offline", "read:profile", "read:sleep", "read:recovery", "read:cycles"}
        state = location.params["state"]
        assert len(state) == 8
        page = client.get("/callback", params={"state": state, "code": "abc"})
        assert "Connected as Sam" in page.text
        assert oct(os.stat(token_file).st_mode)[-3:] == "600"
        assert client.get("/callback", params={"state": state, "code": "abc"}).status_code == 400  # single use
        assert client.get("/status").json()["user"]["user_id"] == 4242

        # 2. Pull data: only sleep, heart rate, SpO2, skin temperature
        daily = client.get("/daily", params={"days": 7}).json()
        assert daily["count"] == 1  # the nap is not a "day"
        row = daily["rows"][0]
        assert row["date"] == "2026-09-18"
        assert set(row) == {"date", "sleep", "heart_rate", "spo2", "skin_temp"}
        assert row["sleep"]["hours_asleep"] == 5.0 and row["sleep"]["hours_in_bed"] == 8.5
        assert row["heart_rate"] == {"resting_heart_rate": 63, "hrv_rmssd_ms": 38.2,
                                     "average_heart_rate": 74, "max_heart_rate": 151}
        assert row["spo2"] == {"spo2_percentage": 95.8}
        assert row["skin_temp"] == {"skin_temp_celsius": 33.9}
        text = json.dumps(daily)
        assert "strain" not in text and "kilojoule" not in text and "recovery_score" not in text

        sleep = client.get("/sleep").json()["rows"]
        assert [s["nap"] for s in sleep] == [False, True]
        assert client.get("/heart-rate").json()["rows"][0]["resting_heart_rate"] == 63
        assert client.get("/spo2").json()["rows"] == [{"date": "2026-09-18", "spo2_percentage": 95.8}]
        assert client.get("/skin-temp").json()["rows"] == [{"date": "2026-09-18", "skin_temp_celsius": 33.9}]
        assert client.get("/workouts").status_code == 404

        # 3. Expired access token -> refreshed, and the rotated refresh token is saved
        saved = json.loads(token_file.read_text())
        token_file.write_text(json.dumps({**saved, "expires_at": 0}))
        client.get("/spo2")
        assert fake.refresh_count == 1 and fake.tokens_seen[-1] == "Bearer at2"
        assert json.loads(token_file.read_text())["refresh_token"] == "rt2"

        # 4. Webhooks
        raw, headers = _signed({"user_id": 4242, "id": "s1", "type": "recovery.updated", "trace_id": "t"})
        assert client.post("/webhook", content=raw, headers={**headers, "X-WHOOP-Signature": "bad"}).status_code == 401
        assert client.post("/webhook", content=raw, headers=headers).status_code == 204
        for ignored in ({"user_id": 4242, "id": "w1", "type": "workout.updated"},
                        {"user_id": 999, "id": "s1", "type": "sleep.updated"}):
            raw_i, headers_i = _signed(ignored)
            assert client.post("/webhook", content=raw_i, headers=headers_i).status_code == 204
        events = client.get("/events").json()
        assert len(events) == 1 and events[0]["type"] == "recovery.updated"
        assert events[0]["data"] == {"date": "2026-09-18",
                                     "heart_rate": {"resting_heart_rate": 63, "hrv_rmssd_ms": 38.2,
                                                    "average_heart_rate": None, "max_heart_rate": None},
                                     "spo2": {"spo2_percentage": 95.8}, "skin_temp": {"skin_temp_celsius": 33.9}}

        # 5. Disconnect
        assert client.post("/disconnect").json() == {"connected": False}
        assert fake.revoked and not token_file.exists()


def test_cors_allows_only_listed_origins(tmp_path):
    config = Config(client_id="cid", client_secret="secret", token_file=tmp_path / "t.json",
                    cors_origins=("http://127.0.0.1:5500",))
    with TestClient(create_app(config, transport=httpx.MockTransport(FakeWhoop()))) as client:
        ok = client.get("/status", headers={"Origin": "http://127.0.0.1:5500"})
        assert ok.headers["access-control-allow-origin"] == "http://127.0.0.1:5500"
        other = client.get("/status", headers={"Origin": "https://evil.example"})
        assert "access-control-allow-origin" not in other.headers
        preflight = client.options("/daily", headers={"Origin": "http://127.0.0.1:5500",
                                                      "Access-Control-Request-Method": "GET"})
        assert preflight.status_code == 200


def test_cors_origins_from_env(monkeypatch):
    monkeypatch.setenv("WHOOP_CORS_ORIGINS", "http://a.test, http://b.test")
    assert Config.from_env().cors_origins == ("http://a.test", "http://b.test")
    monkeypatch.delenv("WHOOP_CORS_ORIGINS")
    assert "http://127.0.0.1:5500" in Config.from_env().cors_origins
