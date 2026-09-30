# PYROSENSE — Deployment Guide

Production layout:

| Piece | Platform | URL |
|---|---|---|
| `backend/` (Express + SQLite) | Render web service **`pyrosense-2aif`** (Docker, Singapore, free plan) | https://pyrosense-2aif.onrender.com |
| `pyrosense_ml/` (FastAPI) | Render web service **`pyrosense-ml`** (Docker, Singapore, free plan) | https://pyrosense-ml.onrender.com |
| `pyrosense-db` (PostgreSQL) | Render managed Postgres (free) | internal — used by pyrosense_ml only |
| `frontend/` (Next.js) | Vercel project | https://pyro-sense.vercel.app |

> ⚠️ **Blueprint name match (was a live hazard, now fixed in `render.yaml`):**
> the live backend Render service is named `pyrosense-2aif` (created outside
> the Blueprint); `render.yaml` now uses that exact `name:` for all three
> services, so a Blueprint sync UPDATES the live services instead of creating
> duplicates. Never rename a service in either place without checking the
> other — and note Render's rename behavior can change the `*.onrender.com`
> subdomain, which `NEXT_PUBLIC_API_BASE_URL`, `CORS_ORIGIN` and
> `keep-warm.yml` all depend on. Verify the URL survives before renaming.
>
> ⚠️ **Auto-deploy reliability (2026-09-30 incident):** pushes to `main` twice
> failed to trigger Render redeploys — Render's auto-deploy webhook for
> `pyrosense-2aif` was dead (commit `14963ff` documents the probe). Prod was
> 3 commits behind `main` for ~20 hours. After every manual deploy: check
> Render → service → Settings → Build & Deploy → Auto-Deploy (enabled,
> `main` branch), and GitHub → repo → Settings → Webhooks → the Render
> webhook → Recent Deliveries (non-2xx deliveries = silent deploy loss).
> Mitigate the free-tier spin-down with an external pinger (UptimeRobot,
> 5-min interval) — see `.github/workflows/keep-warm.yml`.

The browser talks to **one origin only**: the Render backend. It proxies
`/api/predict` and `/api/ml/*` to the ML service, so `CORS_ORIGIN` matters on
the backend only.

---

## 1. Render — manual secrets (`sync: false` in render.yaml)

These are NOT auto-populated by the Blueprint; each one must exist in the
service's **Environment** settings (or be applied via the Render API):

| Service | Variable | Required? | What breaks if missing/invalid |
|---|---|---|---|
| `pyrosense-2aif` (backend) | `FIRMS_MAP_KEY` | **required** (min 16 chars) | missing → process refuses to start (loud). **invalid/expired → ingest silently returns 0 detections forever; the dashboard shows all zeroes** (only a log warn). Verify with the curl in `backend/.env.example`. |
| `pyrosense-2aif` (backend) | `OPENROUTER_API_KEY` | optional | AI summaries/chat degrade to templated text (silent). |
| `pyrosense-2aif` (backend) | `CORS_ORIGIN` | **required in prod** | missing → zod default allows only localhost/LAN → every browser request from the frontend fails CORS preflight (silent — nothing in Render logs). |
| `pyrosense-ml` | `OPENROUTER_API_KEY` | optional | ML GenAI explanations degrade (silent). |
| `pyrosense-ml` | `FIRMS_MAP_KEY` | optional (live-ingest scheduler is off) | only matters if `ENABLE_LIVE_INGEST_SCHEDULER=true`. |

Recommended production values:

```
# pyrosense-2aif (backend)
CORS_ORIGIN=https://pyro-sense.vercel.app,https://pyro-sense-*.vercel.app
DATABASE_URL=/var/data/pyrosense.db        # a PATH, not a postgres:// URL — see §3
```

`ML_API_BASE_URL` is wired automatically by render.yaml via
`fromService: { name: pyrosense-ml, envVarKey: RENDER_EXTERNAL_URL }` — verify
it resolved to `https://pyrosense-ml.onrender.com` (not the `localhost:5000`
default) after the first deploy.

**Changing env vars does NOT redeploy the service.** After editing, trigger a
deploy (dashboard → Manual Deploy, or `POST /v1/services/{id}/deploys`).

## 2. Vercel — build-time env var

| Variable | Value | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | `https://pyrosense-2aif.onrender.com` | Set for **Production** (and Preview). `NEXT_PUBLIC_*` is inlined at **build time** — you must **redeploy after changing it**, the new value does nothing on its own. |

## 3. Free-plan gotchas (verified in this repo's audit)

- **No persistent disks.** The backend's SQLite file lives on ephemeral
  storage: every deploy/spin-down wipes facilities + detections. Two
  counter-measures ship in the repo:
  1. **Boot-time backfill** (`backend/src/jobs/bootstrapOnce.ts`): when
     detections are below `ARCHIVE_BACKFILL_MIN_ROWS` (default 50k) OR the
     stored date span is shallower than `ARCHIVE_BACKFILL_DAYS` (default 10;
     two live global days already exceed 90k rows, so the span check is what
     catches a wiped disk), the startup job re-hydrates the FIRMS archive +
     runs matching — a fresh boot serves fully classified data in ~2
     minutes. Set `ARCHIVE_BACKFILL_DAYS=0` to disable.
  2. **Keep-warm pinger** (`.github/workflows/keep-warm.yml`): pings both
     services' `/health` every 14 min (inside the ~15-min spin-down window)
     so the disk rarely gets wiped at all. Latency optimizer only — the app
     self-heals without it. PRIMARY warming is now an external pinger
     (UptimeRobot free tier, 5-min monitors on both `/health` URLs): GitHub
     Actions' scheduler ran this workflow only 3× in 14 hours on 2026-09-30
     (documented platform throttling on shared runners) — keep the Action as
     a backup, don't rely on it.
  On a paid plan, attach a Disk at `/var/data` and keep
  `DATABASE_URL=/var/data/pyrosense.db` to survive deploys outright.
- **`DATABASE_URL` on the backend is a file path** (better-sqlite3). Do not
  paste the `pyrosense-db` Postgres connection string there — better-sqlite3
  will silently create an empty SQLite file at that nonsense path and the
  server will "work" with zero rows. (This shipped to prod once — see
  `backend/.env.example`.) Only `pyrosense_ml` uses the Postgres URL.
- **Spin-down + cold starts.** Free instances sleep after ~15 min idle; the
  first request can take 30–60s, and short timeouts (Render's own LB or the
  backend's proxy) may surface as sporadic 502s on `/api/ml/*` right after
  wake-up. Retry once before treating it as broken.
- **pyrosense_ml needs a `SQLITE_PATH`** even though it can never read the
  backend's SQLite file cross-container. Its feature engineer treats missing
  detection history as zeros, but a missing FILE raises — set
  `SQLITE_PATH=/tmp/terra-watch.db` (any existing, readable path) to keep the
  predict path alive.

## 4. Smoke test (run after every re-link)

```bash
# 1. Backend alive + DB state (rows: 0 → ingest never ran / key invalid)
curl -s https://pyrosense-2aif.onrender.com/health

# 2. Backend → ML proxy chain (502 right after wake-up = retry once)
curl -s https://pyrosense-2aif.onrender.com/api/ml/health

# 3. CORS: MUST print access-control-allow-origin: https://pyro-sense.vercel.app
curl -s -o /dev/null -D - -H "Origin: https://pyro-sense.vercel.app" \
  https://pyrosense-2aif.onrender.com/health | grep -i access-control

# 4. Real data endpoint with the frontend origin
curl -s -H "Origin: https://pyro-sense.vercel.app" \
  https://pyrosense-2aif.onrender.com/api/command | head -c 300

# 5. FIRMS key validity (root cause of an all-zero dashboard)
curl -s "https://firms.modaps.eosdis.nasa.gov/api/area/csv/<KEY>/VIIRS_SNPP_NRT/68,6,97,37/1" | head -2
```

Expected: (1) `"rows">0` a few minutes after boot, (2) JSON with
`"model_loaded":true`, (3) the exact frontend origin echoed back,
(4) non-zero `facilitiesMonitored`, (5) a CSV header starting with `latitude`.

## 5. Adding a new env var the durable way

1. Add it to the zod schema (`backend/src/config/env.ts`) or pydantic settings
   (`pyrosense_ml/app/config.py`) — required vars must fail loudly at boot.
2. Add it to `render.yaml` (`sync: false` if secret) AND to
   `backend/.env.example` / `frontend/.env.example` with a one-line "what
   breaks if missing" note.
3. If the frontend reads it, prefix `NEXT_PUBLIC_` and remember: **build-time
   inlined → redeploy after changing.**
