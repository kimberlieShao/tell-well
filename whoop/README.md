# WHOOP connector

A small Python server that connects one WHOOP account and returns only **sleep, heart rate
(resting HR, HRV, average/max), SpO2 and skin temperature**. No workouts or strain.

## Run it

```sh
cd whoop
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # then paste your WHOOP client ID and secret into .env
python whoop_connect.py     # open http://localhost:8000 and click "Connect WHOOP"
```

Get the client ID and secret by creating an app at https://developer-dashboard.whoop.com with
redirect URL `http://localhost:8000/callback` and scopes `offline read:profile read:sleep
read:recovery read:cycles`. The full setup notes (including HTTPS if WHOOP rejects an http
redirect) are at the top of `whoop_connect.py`.

## Endpoints

| Route | Returns |
| --- | --- |
| `GET /status` | Connected or not, and which WHOOP account |
| `GET /daily?days=30` | One row per night: `sleep`, `heart_rate`, `spo2`, `skin_temp` |
| `GET /sleep`, `/heart-rate`, `/spo2`, `/skin-temp` | One metric group each (`?days=7` default) |
| `POST /webhook` | WHOOP webhooks (signature checked); latest ones at `GET /events` |
| `POST /disconnect` | Revoke access and delete the saved tokens |

Example `/daily` row:

```json
{"date": "2026-09-18",
 "sleep": {"hours_asleep": 5.0, "hours_in_bed": 8.5, "efficiency_pct": 91.5, "...": "..."},
 "heart_rate": {"resting_heart_rate": 63, "hrv_rmssd_ms": 38.2, "average_heart_rate": 74, "max_heart_rate": 151},
 "spo2": {"spo2_percentage": 95.8},
 "skin_temp": {"skin_temp_celsius": 33.9}}
```

Browser pages may call it from the origins in `WHOOP_CORS_ORIGINS` (defaults: Live Server on
port 5500, Expo web on 8081, and the Pulsewise backend on 3001).

## Tests

```sh
pip install pytest && pytest
```

`whoop_tokens.json` holds your WHOOP login and `.env` holds the secret. Both are in `.gitignore`;
never commit them.
