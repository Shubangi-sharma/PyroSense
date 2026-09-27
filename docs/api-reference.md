# API Reference

PyroSense exposes a Node.js backend for frontend data fetching and orchestration, and a FastAPI service strictly for ML processes.

## Node.js Backend (`/backend/src/routes/`)

The Node backend orchestrates data and proxies ML calls.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Service identity probe (`{ service, status }`). |
| `GET` | `/health` | Basic API uptime and health status. |
| `GET` | `/api/facilities` | Fetches the ingested OSM facility catalogue. |
| `GET` | `/api/facilities/analyses` | Fetches computed facility risk status and health scores. |
| `GET` | `/api/facilities/:id/analyses` | Specific facility "What Changed" diffs and timelines. |
| `GET` | `/api/facilities/:id/summary` | Grounded OpenRouter GenAI summary for a facility. |
| `GET` | `/api/firms` | Fetches stored NASA FIRMS CSV detections (10-day rolling). |
| `GET` | `/api/firms/coverage` | Reports the exact historical storage coverage held in SQLite. |
| `POST` | `/api/predict` | Proxies classification inference payload to the ML service. |
| `GET` | `/api/ml/health` | Proxies ML service and database health. |
| `GET` | `/api/ml/hotspots` | Proxies map-ready clusters from ML service. |
| `GET` | `/api/ml/observations` | Proxies live point environment derivations. |
| `GET` | `/api/v1/risk` | H3 Cell viewport 1/3/7-day risks. |
| `GET` | `/api/v1/hotspots` | Persistent/recent viewport hotspot clusters. |
| `GET` | `/api/v1/cells/:h3` | Click-panel payload containing cell risk and nearby clusters. |
| `POST`| `/api/v1/pipeline/run` | Triggers the ML pipeline (ingest → weather → aggregate). |
| `POST`| `/api/chat` | Chatbot prompt orchestration endpoint. |
| `GET` | `/api/command` | Command interface logic endpoint. |

## FastAPI ML Service (`/pyrosense_ml/app/api/`)

The FastAPI service owns the prediction pipelines, frozen schemas, and ML persistence. The Next.js frontend NEVER calls these directly; they are accessed via the Node.js proxies above.

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/` | Service identity probe (`{ service, status }`). |
| `POST` | `/predict` | Classifies a live hotspot using engineered features or expert-mode inputs. |
| `GET` | `/health` | Model versions, PostGIS connection status, and pipeline job status. |
| `GET` | `/hotspots` | Clusters filtered by source (live/historical) and bounding box. |
| `GET` | `/hotspots/{hotspot_uid}` | Full detail snapshot (36-feature vector) of a specific hotspot. |
| `GET` | `/hotspots/{hotspot_uid}/timeline` | Daily snapshots for the frontend map slider. |
| `GET` | `/observations` | On-demand computation of live per-point weather and OSM context. |
| `GET` | `/internal/risk/{h3_cell}` | Stored 1/3/7-day and overall risk for a single cell. |
| `POST` | `/internal/risk/batch` | Batch fetches risk for an array of H3 cells. |
| `GET` | `/internal/hotspots` | Internal cluster fetching by bounding box/type/persistence filters. |
| `GET` | `/internal/hotspots/{cluster_uid}` | Internal detailed fetch of a single cluster. |
| `POST` | `/internal/classify` | Live point evaluation for contextual type (handling Needs Review). |
| `POST` | `/internal/pipeline/run` | Executes ML pipeline stages manually (called by Node cron). |
| `GET` | `/internal/health` | Verbose internal health metrics. |
