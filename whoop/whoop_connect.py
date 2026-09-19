"""WHOOP connector: sleep, heart rate (pulse), SpO2 and skin temperature from a WHOOP account, in one file.

Connects a WHOOP account with OAuth, keeps the tokens fresh, and pulls only:
  - sleep:       hours asleep, time in bed, light / deep / REM / awake, efficiency,
                 performance, consistency, disturbances, respiratory rate
  - heart rate:  resting heart rate, HRV (RMSSD), the day's average and max heart rate
  - SpO2:        blood oxygen during sleep (WHOOP 4.0 and newer)
  - skin temp:   skin temperature during sleep, in °C (WHOOP 4.0 and newer)
It can also receive WHOOP webhooks, so a new night shows up as soon as WHOOP has
scored it.

Setup
  1. Create an app at https://developer-dashboard.whoop.com
       Redirect URL:  http://localhost:8000/callback
       Scopes:        offline, read:profile, read:sleep, read:recovery, read:cycles
                      (resting HR, HRV, SpO2 and skin temp live in WHOOP's "recovery" data, and the
                      day's average/max heart rate in its "cycle" data)
       Webhooks (optional): https://<your public url>/webhook, model version v2
  2. pip install -r requirements.txt
  3. cp .env.example .env   and paste WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET into .env
  4. python whoop_connect.py        then open http://localhost:8000 and click Connect WHOOP

  If the dashboard won't accept an http:// redirect URL, use HTTPS locally instead:
       brew install mkcert && mkcert -install && mkcert localhost
       export WHOOP_REDIRECT_URI=https://localhost:8000/callback   (and register that URL)
       python whoop_connect.py --cert localhost.pem --key localhost-key.pem
       then open https://localhost:8000

Needs: fastapi, uvicorn, httpx (python-dotenv optional); see requirements.txt.

Web pages on other origins (the Pulsewise frontend, e.g. VS Code Live Server on
http://127.0.0.1:5500) may call the data endpoints if their origin is listed in
WHOOP_CORS_ORIGINS (comma-separated). The defaults cover the usual local dev servers.

Endpoints
  GET  /                     page with Connect / data links
  GET  /login                start WHOOP sign-in
  GET  /callback             WHOOP redirects here after sign-in; saves tokens
  GET  /status               connected? which account? when the token expires
  GET  /daily?days=30        one row per night/day: sleep + heart rate + SpO2 + skin temp
  GET  /sleep?days=7         sleep only (naps included, flagged)
  GET  /heart-rate?days=7    resting HR, HRV, average and max heart rate
  GET  /spo2?days=7          blood oxygen
  GET  /skin-temp?days=7     skin temperature
  POST /webhook              WHOOP webhook receiver (signature checked)
  GET  /events               latest updates received by webhook
  POST /disconnect           revoke access and delete the saved tokens
  Any data endpoint also takes ?start=2026-09-01&end=2026-09-15 instead of ?days=.

Command line
  python whoop_connect.py                          run the server (--port to change)
  python whoop_connect.py daily --days 7           print data as JSON (after connecting once);
                                                   also: sleep | heart-rate | spo2 | skin-temp
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import hashlib
import hmac
import html
import json
import os
import re
import secrets
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

try:
    from dotenv import load_dotenv

    load_dotenv()
except ImportError:
    pass

API_BASE = "https://api.prod.whoop.com/developer"
AUTH_URL = "https://api.prod.whoop.com/oauth/oauth2/auth"
TOKEN_URL = "https://api.prod.whoop.com/oauth/oauth2/token"
SCOPES = "offline read:profile read:sleep read:recovery read:cycles"
SLEEP_PATH, RECOVERY_PATH, CYCLE_PATH = "/v2/activity/sleep", "/v2/recovery", "/v2/cycle"
PAGE_LIMIT = 25  # WHOOP's maximum page size
STATE_TTL_S = 600
VIEWS = ("daily", "sleep", "heart-rate", "spo2", "skin-temp")
# Local dev servers the frontend is usually served from: VS Code Live Server, Expo web,
# and the Pulsewise backend. Any other origin must be added via WHOOP_CORS_ORIGINS.
DEFAULT_CORS_ORIGINS = (
    "http://localhost:5500", "http://127.0.0.1:5500",
    "http://localhost:8081",
    "http://localhost:3001", "http://127.0.0.1:3001",
)


# =========================================================================== config & token storage


@dataclass
class Config:
    client_id: str | None
    client_secret: str | None
    redirect_uri: str = "http://localhost:8000/callback"
    token_file: Path = Path("whoop_tokens.json")
    webhook_tolerance_s: int = 300
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS

    @classmethod
    def from_env(cls) -> Config:
        origins = os.environ.get("WHOOP_CORS_ORIGINS")
        return cls(
            client_id=os.environ.get("WHOOP_CLIENT_ID"),
            client_secret=os.environ.get("WHOOP_CLIENT_SECRET"),
            redirect_uri=os.environ.get("WHOOP_REDIRECT_URI", "http://localhost:8000/callback"),
            token_file=Path(os.environ.get("WHOOP_TOKEN_FILE", "whoop_tokens.json")),
            cors_origins=(tuple(o.strip() for o in origins.split(",") if o.strip())
                          if origins is not None else DEFAULT_CORS_ORIGINS),
        )


class WhoopError(Exception):
    """WHOOP returned an error or couldn't be reached."""


class NotConfigured(WhoopError):
    """WHOOP_CLIENT_ID / WHOOP_CLIENT_SECRET aren't set."""


class NotConnected(WhoopError):
    """No WHOOP account has been connected yet."""


class ReconnectNeeded(WhoopError):
    """The refresh token was rejected (expired, or access was revoked)."""


class TokenStore:
    """Tokens for one WHOOP account, kept in a local JSON file only you can read.

    Keep this file out of git. Access tokens last about an hour, and every refresh
    also replaces the refresh token, so the file is rewritten on each refresh.
    """

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.path.read_text())
        except FileNotFoundError:
            return None

    def save(self, data: dict[str, Any]) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, indent=2))
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)  # atomic: a crash never leaves half a token file

    def clear(self) -> None:
        self.path.unlink(missing_ok=True)


# =========================================================================== WHOOP API client


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


class WhoopClient:
    def __init__(self, config: Config, http: httpx.AsyncClient, store: TokenStore):
        self.config = config
        self.http = http
        self.store = store
        self._refresh_lock = asyncio.Lock()

    # ----------------------------------------------------------------- OAuth

    def authorize_url(self, state: str) -> str:
        if not (self.config.client_id and self.config.client_secret):
            raise NotConfigured("Set WHOOP_CLIENT_ID and WHOOP_CLIENT_SECRET (from developer-dashboard.whoop.com) first")
        return AUTH_URL + "?" + urlencode({
            "client_id": self.config.client_id,
            "redirect_uri": self.config.redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
        })

    async def _token_request(self, form: dict[str, str]) -> dict[str, Any]:
        form = {**form, "client_id": self.config.client_id or "", "client_secret": self.config.client_secret or ""}
        resp = await self.http.post(TOKEN_URL, data=form)
        if resp.status_code in (400, 401):
            raise ReconnectNeeded(f"WHOOP rejected the token request ({resp.status_code})")
        if resp.status_code >= 400:
            raise WhoopError(f"Token request failed ({resp.status_code})")
        body = resp.json()
        return {
            "access_token": body["access_token"],
            "refresh_token": body.get("refresh_token"),
            "expires_at": time.time() + int(body.get("expires_in", 3600)),
            "scope": body.get("scope"),
        }

    async def connect(self, code: str) -> dict[str, Any]:
        """Swap the sign-in code for tokens and remember which account it is."""
        tokens = await self._token_request({
            "grant_type": "authorization_code", "code": code, "redirect_uri": self.config.redirect_uri})
        self.store.save(tokens)
        profile = await self.get("/v2/user/profile/basic")
        self.store.save({**self.store.load(), "user": profile, "connected_at": _iso(datetime.now(UTC))})
        return profile

    async def access_token(self) -> str:
        saved = self.store.load()
        if not saved:
            raise NotConnected("No WHOOP account connected. Open /login first.")
        if saved["expires_at"] - 60 > time.time():
            return saved["access_token"]
        async with self._refresh_lock:  # refresh tokens rotate: never refresh twice at once
            saved = self.store.load() or {}
            if saved.get("expires_at", 0) - 60 > time.time():
                return saved["access_token"]
            if not saved.get("refresh_token"):
                raise ReconnectNeeded("No refresh token saved (was the 'offline' scope granted?)")
            fresh = await self._token_request({
                "grant_type": "refresh_token", "refresh_token": saved["refresh_token"], "scope": "offline"})
            fresh["refresh_token"] = fresh["refresh_token"] or saved["refresh_token"]
            self.store.save({**saved, **fresh})
            return fresh["access_token"]

    async def disconnect(self) -> None:
        if self.store.load():
            try:
                token = await self.access_token()
                await self.http.delete(API_BASE + "/v2/user/access", headers={"Authorization": f"Bearer {token}"})
            except WhoopError:
                pass  # forget the tokens locally even if WHOOP can't be reached
        self.store.clear()

    # ----------------------------------------------------------------- data

    async def get(self, path: str, params: dict[str, Any] | None = None, *, _retried: bool = False) -> dict[str, Any]:
        token = await self.access_token()
        resp = await self.http.get(API_BASE + path, params=params, headers={"Authorization": f"Bearer {token}"})
        if resp.status_code == 401 and not _retried:
            # Token revoked or replaced early: force one refresh and retry.
            self.store.save({**(self.store.load() or {}), "expires_at": 0})
            return await self.get(path, params, _retried=True)
        if resp.status_code == 429:
            raise WhoopError("WHOOP rate limit reached; try again in a minute")
        if resp.status_code >= 400:
            raise WhoopError(f"GET {path} failed ({resp.status_code})")
        return resp.json()

    async def _all(self, path: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        """Every record in [start, end), following WHOOP's pagination."""
        params: dict[str, Any] = {"limit": PAGE_LIMIT, "start": _iso(start), "end": _iso(end)}
        records: list[dict[str, Any]] = []
        while True:
            page = await self.get(path, params)
            records += page.get("records", [])
            # Note the casing: the response says next_token, the query param is nextToken.
            if not page.get("next_token"):
                return records
            params["nextToken"] = page["next_token"]

    async def fetch(self, start: datetime, end: datetime) -> tuple[list[dict], list[dict], list[dict]]:
        """Raw sleep, recovery and cycle records. Recovery and cycles are fetched
        from a day earlier so each night's numbers are complete."""
        return await asyncio.gather(
            self._all(SLEEP_PATH, start, end),
            self._all(RECOVERY_PATH, start - timedelta(days=1), end),
            self._all(CYCLE_PATH, start - timedelta(days=1), end),
        )

    async def view(self, name: str, start: datetime, end: datetime) -> list[dict[str, Any]]:
        sleeps, recoveries, cycles = await self.fetch(start, end)
        if name == "sleep":
            return [{"date": wake_date(s), "nap": bool(s.get("nap")), **sleep_fields(s)} for s in sleeps]
        rows = daily_rows(sleeps, recoveries, cycles)
        if name == "heart-rate":
            return [{"date": r["date"], **r["heart_rate"]} for r in rows]
        if name == "spo2":
            return [{"date": r["date"], **r["spo2"]} for r in rows]
        if name == "skin-temp":
            return [{"date": r["date"], **r["skin_temp"]} for r in rows]
        return rows

    async def record_for_event(self, event_type: str, record_id: str) -> dict[str, Any] | None:
        """What a webhook is about, trimmed to sleep / heart rate / SpO2 / skin temp. v2 webhooks
        send the sleep's id for both sleep and recovery events."""
        if event_type == "sleep.updated":
            sleep = await self.get(f"{SLEEP_PATH}/{record_id}")
            return {"date": wake_date(sleep), "nap": bool(sleep.get("nap")), "sleep": sleep_fields(sleep)}
        if event_type == "recovery.updated":
            sleep = await self.get(f"{SLEEP_PATH}/{record_id}")
            recovery = await self.get(f"{CYCLE_PATH}/{sleep['cycle_id']}/recovery")
            return {"date": wake_date(sleep), "heart_rate": heart_rate_fields(recovery, None),
                    "spo2": spo2_fields(recovery), "skin_temp": skin_temp_fields(recovery)}
        return None  # other event types (e.g. workouts) aren't used


# =========================================================================== shaping the data


_OFFSET = re.compile(r"^([+-])(\d{2}):?(\d{2})$")


def local_date(timestamp: str, offset: str | None) -> date:
    """WHOOP timestamps are UTC; timezone_offset (e.g. "-05:00") gives local time."""
    moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    match = _OFFSET.match(offset or "")
    if not match:
        return moment.date()
    sign = 1 if match.group(1) == "+" else -1
    tz = timezone(sign * timedelta(hours=int(match.group(2)), minutes=int(match.group(3))))
    return moment.astimezone(tz).date()


def wake_date(sleep: dict[str, Any]) -> str:
    return local_date(sleep["end"], sleep.get("timezone_offset")).isoformat()


def _hours(ms: float | None) -> float | None:
    return round(ms / 3_600_000, 2) if ms else None


def sleep_fields(sleep: dict[str, Any]) -> dict[str, Any]:
    score = sleep.get("score") or {}
    stages = score.get("stage_summary") or {}
    asleep_ms = sum(stages.get(k) or 0 for k in (
        "total_light_sleep_time_milli", "total_slow_wave_sleep_time_milli", "total_rem_sleep_time_milli"))
    return {
        "start": sleep.get("start"),
        "end": sleep.get("end"),
        "hours_asleep": _hours(asleep_ms),
        "hours_in_bed": _hours(stages.get("total_in_bed_time_milli")),
        "light_hours": _hours(stages.get("total_light_sleep_time_milli")),
        "deep_hours": _hours(stages.get("total_slow_wave_sleep_time_milli")),
        "rem_hours": _hours(stages.get("total_rem_sleep_time_milli")),
        "awake_hours": _hours(stages.get("total_awake_time_milli")),
        "efficiency_pct": score.get("sleep_efficiency_percentage"),
        "performance_pct": score.get("sleep_performance_percentage"),
        "consistency_pct": score.get("sleep_consistency_percentage"),
        "disturbances": stages.get("disturbance_count"),
        "respiratory_rate": score.get("respiratory_rate"),
        "scored": sleep.get("score_state") == "SCORED",
    }


def heart_rate_fields(recovery: dict[str, Any] | None, cycle: dict[str, Any] | None) -> dict[str, Any]:
    rs = (recovery or {}).get("score") or {}
    cs = (cycle or {}).get("score") or {}
    return {
        "resting_heart_rate": rs.get("resting_heart_rate"),  # bpm, measured during sleep
        "hrv_rmssd_ms": rs.get("hrv_rmssd_milli"),
        "average_heart_rate": cs.get("average_heart_rate"),  # bpm across the whole WHOOP day
        "max_heart_rate": cs.get("max_heart_rate"),
    }


def spo2_fields(recovery: dict[str, Any] | None) -> dict[str, Any]:
    rs = (recovery or {}).get("score") or {}
    return {"spo2_percentage": rs.get("spo2_percentage")}  # WHOOP 4.0+ only


def skin_temp_fields(recovery: dict[str, Any] | None) -> dict[str, Any]:
    rs = (recovery or {}).get("score") or {}
    return {"skin_temp_celsius": rs.get("skin_temp_celsius")}  # WHOOP 4.0+ only


def daily_rows(sleeps: list[dict], recoveries: list[dict], cycles: list[dict]) -> list[dict[str, Any]]:
    """One row per main (non-nap) sleep, labelled with the local date you woke up,
    with the heart rate, SpO2 and skin temperature WHOOP measured for that night and day."""
    recovery_by_sleep = {r.get("sleep_id"): r for r in recoveries}
    cycle_by_id = {c["id"]: c for c in cycles}
    rows = []
    for s in sleeps:
        if s.get("nap"):
            continue
        recovery = recovery_by_sleep.get(s["id"])
        rows.append({
            "date": wake_date(s),
            "sleep": sleep_fields(s),
            "heart_rate": heart_rate_fields(recovery, cycle_by_id.get(s.get("cycle_id"))),
            "spo2": spo2_fields(recovery),
            "skin_temp": skin_temp_fields(recovery),
        })
    return sorted(rows, key=lambda row: row["date"])


def verify_signature(*, secret: str, body: bytes, signature: str | None, timestamp: str | None,
                     tolerance_s: int, now_ms: int | None = None) -> bool:
    """WHOOP signs webhooks as base64(HMAC-SHA256(timestamp + raw body, client secret))."""
    if not signature or not timestamp or not timestamp.isdigit():
        return False
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    if abs(now_ms - int(timestamp)) > tolerance_s * 1000:
        return False  # too old: a replayed request
    digest = hmac.new(secret.encode(), timestamp.encode() + body, hashlib.sha256).digest()
    return hmac.compare_digest(base64.b64encode(digest).decode(), signature)


# =========================================================================== web server


def _window(days: int | None, start: date | None, end: date | None) -> tuple[datetime, datetime]:
    if start:
        s = datetime.combine(start, datetime.min.time(), UTC)
        e = datetime.combine(end, datetime.min.time(), UTC) + timedelta(days=1) if end else datetime.now(UTC)
        if e <= s:
            raise HTTPException(422, "end must be after start")
        return s, e
    now = datetime.now(UTC)
    return now - timedelta(days=days or 7), now


def create_app(config: Config | None = None, *, transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    config = config or Config.from_env()
    store = TokenStore(config.token_file)
    pending_states: dict[str, float] = {}
    events: deque[dict[str, Any]] = deque(maxlen=50)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with httpx.AsyncClient(timeout=30, transport=transport) as http:
            app.state.whoop = WhoopClient(config, http, store)
            yield

    app = FastAPI(title="WHOOP connector: sleep, heart rate, SpO2, skin temperature", lifespan=lifespan)
    # Health data: only listed origins may read it from a browser (never "*").
    app.add_middleware(CORSMiddleware, allow_origins=list(config.cors_origins),
                       allow_methods=["GET", "POST"], allow_headers=["Content-Type"])

    def whoop(request: Request) -> WhoopClient:
        return request.app.state.whoop

    @app.exception_handler(WhoopError)
    async def _whoop_error(_: Request, exc: WhoopError) -> JSONResponse:
        if isinstance(exc, NotConfigured):
            return JSONResponse({"detail": str(exc)}, status_code=503)
        if isinstance(exc, NotConnected):
            return JSONResponse({"detail": str(exc)}, status_code=409)
        if isinstance(exc, ReconnectNeeded):
            return JSONResponse({"detail": f"{exc}. Open /login to reconnect WHOOP."}, status_code=401)
        return JSONResponse({"detail": str(exc)}, status_code=502)

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    async def home() -> str:
        who = ((store.load() or {}).get("user")) or {}
        status = (f"Connected as {html.escape(who.get('first_name', ''))} {html.escape(who.get('last_name', ''))}"
                  if who else "Not connected")
        links = "".join(f'<li><a href="/{p}">/{p}</a></li>' for p in
                        ("status", "daily?days=30", "sleep", "heart-rate", "spo2", "skin-temp", "events"))
        return (f"<!doctype html><meta name=viewport content='width=device-width'><title>WHOOP connector</title>"
                f"<body style='font-family:system-ui;max-width:640px;margin:32px auto;padding:0 16px'>"
                f"<h1>WHOOP connector</h1><p>{status}</p><p><a href='/login'>Connect WHOOP</a></p><ul>{links}</ul>")

    @app.get("/login")
    async def login(request: Request) -> RedirectResponse:
        now = time.time()
        for s, t in list(pending_states.items()):
            if now - t > STATE_TTL_S:
                pending_states.pop(s)
        state = secrets.token_urlsafe(6)[:8]  # WHOOP wants an 8-character state
        pending_states[state] = now
        return RedirectResponse(whoop(request).authorize_url(state))

    @app.get("/callback", response_class=HTMLResponse)
    async def callback(request: Request, state: str = "", code: str | None = None, error: str | None = None) -> str:
        created = pending_states.pop(state, None)
        if created is None or time.time() - created > STATE_TTL_S:
            raise HTTPException(400, "Sign-in link expired or invalid. Start again at /login.")
        if error or not code:
            return f"<p>WHOOP wasn't connected ({html.escape(error or 'no code')}). <a href='/login'>Try again</a></p>"
        profile = await whoop(request).connect(code)
        return (f"<p>Connected as {html.escape(profile.get('first_name', ''))} "
                f"(WHOOP user {profile.get('user_id')}).</p><p><a href='/daily?days=30'>See the last 30 days</a></p>")

    @app.get("/status")
    async def status() -> dict[str, Any]:
        saved = store.load()
        if not saved:
            return {"connected": False}
        return {
            "connected": True,
            "user": saved.get("user"),
            "connected_at": saved.get("connected_at"),
            "scopes": saved.get("scope"),
            "access_token_expires_at": _iso(datetime.fromtimestamp(saved["expires_at"], UTC)),
        }

    def add_view_route(name: str) -> None:
        @app.get(f"/{name}", name=name)
        async def view(request: Request, days: int | None = Query(None, ge=1, le=365),
                       start: date | None = None, end: date | None = None) -> dict[str, Any]:
            s, e = _window(days or (30 if name == "daily" else None), start, end)
            rows = await whoop(request).view(name, s, e)
            return {"start": _iso(s), "end": _iso(e), "count": len(rows), "rows": rows}

    for view_name in VIEWS:
        add_view_route(view_name)

    async def fetch_for_event(client: WhoopClient, event: dict[str, Any]) -> None:
        try:
            event["data"] = await client.record_for_event(event["type"], event["id"])
        except WhoopError as exc:
            event["error"] = str(exc)

    @app.post("/webhook", status_code=204)
    async def webhook(request: Request, background: BackgroundTasks) -> Response:
        body = await request.body()
        if not config.client_secret or not verify_signature(
            secret=config.client_secret, body=body, signature=request.headers.get("x-whoop-signature"),
            timestamp=request.headers.get("x-whoop-signature-timestamp"), tolerance_s=config.webhook_tolerance_s,
        ):
            raise HTTPException(401, "Bad signature")
        payload = json.loads(body)
        event_type = str(payload.get("type"))
        connected = ((store.load() or {}).get("user") or {}).get("user_id")
        if not event_type.startswith(("sleep.", "recovery.")) or (
                connected is not None and payload.get("user_id") != connected):
            return Response(status_code=204)  # not data we use; acknowledge so WHOOP stops retrying
        event = {"received_at": _iso(datetime.now(UTC)), "type": event_type, "id": str(payload.get("id"))}
        events.appendleft(event)
        if event_type.endswith(".updated"):
            # WHOOP wants a 2xx within about a second, so fetch the data afterwards.
            background.add_task(fetch_for_event, whoop(request), event)
        return Response(status_code=204)

    @app.get("/events")
    async def recent_events() -> list[dict[str, Any]]:
        return list(events)

    @app.post("/disconnect")
    async def disconnect(request: Request) -> dict[str, bool]:
        await whoop(request).disconnect()
        return {"connected": False}

    return app


app = create_app()


# =========================================================================== command line


async def _print_view(name: str, days: int) -> None:
    config = Config.from_env()
    async with httpx.AsyncClient(timeout=30) as http:
        client = WhoopClient(config, http, TokenStore(config.token_file))
        now = datetime.now(UTC)
        print(json.dumps(await client.view(name, now - timedelta(days=days), now), indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description="WHOOP connector: sleep, heart rate, SpO2, skin temperature")
    parser.add_argument("what", nargs="?", default="serve", choices=["serve", *VIEWS])
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--cert", help="TLS certificate (e.g. from mkcert) to serve over https")
    parser.add_argument("--key", help="TLS private key for --cert")
    args = parser.parse_args()
    if args.what == "serve":
        import uvicorn

        if bool(args.cert) != bool(args.key):
            raise SystemExit("error: --cert and --key go together")
        scheme = "https" if args.cert else "http"
        redirect = Config.from_env().redirect_uri
        if not redirect.startswith(f"{scheme}://localhost:{args.port}/"):
            print(f"note: WHOOP_REDIRECT_URI is {redirect}; it must match the server address and the dashboard")
        print(f"Open {scheme}://localhost:{args.port} and click Connect WHOOP")
        uvicorn.run(app, host=args.host, port=args.port, ssl_certfile=args.cert, ssl_keyfile=args.key)
        return
    try:
        asyncio.run(_print_view(args.what, args.days))
    except WhoopError as exc:
        raise SystemExit(f"error: {exc}") from exc


if __name__ == "__main__":
    main()
