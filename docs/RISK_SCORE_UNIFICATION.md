# Risk Score Unification — Design & Implementation Record

Status: **implemented**. Sections 1–6 below are the Step 2 design doc (checked
in before coding began, per the brief); §7 records how the open items were
resolved during implementation, and §8 is the final report the brief asked
for. Grounded in a direct read of the repo tree, not assumptions — file
paths, function names and line-level behavior were confirmed by reading the
actual source.

---

## 0. Pre-flight (Step 0)

```
git status                       # commit stray work as "WIP: snapshot before risk score unification"
git branch --show-current        # if main/master → git checkout -b unify-risk-score
git pull --ff-only                # STOP on failure, report exact error
```

No code changes happen before this succeeds.

Execution note: a stale `unify-risk-score` branch existed (1 unique commit,
"Use asyncio event loop for Render ML service", a 1-line Dockerfile CMD change
already contained in main). It was verified contained, deleted, and the branch
recreated from an up-to-date main. Working tree was clean at start; `main ==
origin/main` (14963ff) confirmed by fetch before branching.

---

## 1. Duplication confirmed (Step 1 findings)

This repo has **three** distinct score concepts, not two — the third was found by
reading `command.controller.ts`, not assumed from the brief. All three claim to
describe the same thing ("how dangerous is this facility right now") and they
disagree in direction and inputs.

### 1.1 `backend/src/services/scoringService.ts` — `computeHealthScore`
- Returns `100 - Math.max(discounted, 0)` (see the literal `return`
  statement) → **higher = healthier = LESS risk**.
- Signature: `computeHealthScore(input: HealthScoreInput): number`, where
  `HealthScoreInput` is exclusively FRP-derived: `liveCount, liveMeanFrp,
  livePeakFrp, cvFrp, spreadKm, newestAgeDays, liveUniqueDays,
  frpRatioVsBaseline, baselineWeightSum, lowConfidenceShare`.
- Traced the call chain: `classifyFromDetections()` (same file) builds every one
  of those inputs purely from `DetectionRow[]` (FIRMS detections) and calls
  `computeHealthScore`. `analysisService.ts` (`analyzeFacility`,
  `analyzeAllFacilities`) calls `classifyFromDetections` and exposes the result
  as `.score` / `facts.healthScore`. **Confirmed: zero weather, land-cover, OSM,
  or ML-classification input anywhere in this chain.**

### 1.2 `pyrosense_ml/app/api/predict.py` — `compute_classification_risk_score`
- Returns `round(min(score*100, 100), 2)` where `score = Σ prob(class) ×
  CATEGORY_RISK_WEIGHTS[class]` → **higher = more risk** (direct, not inverse).
- Domain weights: `Agricultural 0.30, Forest_Vegetation 0.55, Industrial 0.85,
  Infrastructure_Energy 0.70, Mining 0.65` (unknown class → 0.5 default).
- The classifier's input features (`engineer_features()` /
  `app/features/engineer.py`) already fold in weather, land cover and OSM
  distances — confirmed in `engineer.py`. This is the "ML-pipeline-informed"
  score the brief describes.
- **Important nuance not in the brief**: `predict.py`'s own docstring says the
  risk-prediction path (the GRU temporal model) is *not* reachable from this
  endpoint — `include_risk=True` returns HTTP 501
  (`RISK_NOT_IMPLEMENTED_DETAIL = "... Phase 2C ..."`). That gate is stale
  relative to the rest of the repo: the GRU pipeline **is** built and running
  elsewhere (see 1.3). `/predict` simply never got wired to it. This doesn't
  change the plan, but it means "call `/predict` for classification, call a
  different endpoint for temporal" is correct, not a workaround.

### 1.3 GRU temporal risk — a third, independent signal
- `pyrosense_ml/app/ml/risk_score.py` — `score_risk(sequence)` runs all three
  GRU horizon models on a `(30, 17)` H3-cell sequence and returns:
  ```
  {"1day": {"score": <prob 0-1>, "level": "HIGH"|"LOW"},
   "3day": {...}, "7day": {...},
   "overall": "HIGH"|"MODERATE"|"LOW"}   # 2+ HIGH → HIGH, 1 → MODERATE, 0 → LOW
  ```
  **The module docstring explicitly states this replaced a legacy
  weighted-probability-sum formula "intentionally not preserved anywhere, not
  even as a comment"** — i.e. this repo has already been through one score
  unification before; the pattern of removing the old thing cleanly is
  precedent we should follow again.
- **Raw scores are available, not just buckets.** `RiskHorizonEntry` in
  `frontend/lib/riskApi.ts` already carries `probability`, `level`, and
  `threshold` per horizon. Per the brief's own fallback clause ("if you find
  the underlying GRU scores are available as raw numbers... use the raw scores
  directly instead of the bucketed level"), **we use the raw per-horizon
  probabilities**, not the HIGH/MODERATE/LOW bucket mapping. See §2.2.
- Served via `pyrosense_ml/app/api/internal.py`: `GET /internal/risk/{h3_cell}`
  and `POST /internal/risk/batch` — explicitly **read-only against
  `risk_predictions`**, "the API never runs GRU inference per request." This is
  a pre-computed nightly signal, not live. Node exposes it at
  `GET /api/v1/risk` and `GET /api/v1/cells/:h3` (`backend/src/routes/v1.route.ts`).
- **Risk is keyed by H3 cell (res 7, from `h3_aggregate.py`), not by facility
  id.** Facility → cell mapping (`h3.latlng_to_cell(lat, lng, 7)`) is required
  wherever we join this signal onto a facility. This is a real integration
  detail the brief didn't specify and must be designed explicitly (§2.2, §2.3).

### 1.4 A **third** score system, found (not assumed): `command.controller.ts`
`GET /api/command` — the dashboard/chatbot's shared endpoint — computes its own
independent, fourth formula, `computeRiskScore(healthScore, classificationSeverity,
frpRatio, trend)`:
```ts
healthRisk = 100 - healthScore
classRisk  = CLASSIFICATION_SEVERITY[classifyRuleBased(signals)]   // a 4th classifier: rule-based, not the ML one
frpRisk    = clamp((frpRatio - 1) * 50, 0, 100)
trendRisk  = trend * 10                                            // trend is hardcoded to 0 at the only call site
raw = healthRisk*0.4 + classRisk*0.3 + frpRisk*0.2 + trendRisk*0.1
```
This is returned to the client as **both** `healthScore` (= `a.score`, the §1.1
number, unchanged) **and** `riskScore` (this new blend) on the same
`CommandFacility` object, then the priority list is sorted by this `riskScore`.
This is exactly the "third or fourth score concept" the brief's final report
asks about — **found during planning, must be retired in Step 3**, not just
the two systems named in the brief.

There is also a **fifth, unused field**: `FacilityNarrative.riskScore` in
`analysisService.ts` and `facts.ts` (`if (f.riskScore != null) lines.push(...)`)
— declared, typed, rendered in the templated summary, but never populated by
anything in the current codebase (no assignment site found). Dead scaffolding
from an earlier attempt at exactly this unification. It will be replaced by
the real thing rather than left dangling.

### 1.4 (continued) — every UI surface that renders a score-like number

| File | Renders | Signal used today | View type |
|---|---|---|---|
| `frontend/components/HealthScoreRing.tsx` | Ring showing `score`/100 | §1.1 health score (full ring = healthy) | Shared component |
| `frontend/components/FacilityDetailPanel.tsx` | `HealthScoreRing` for one facility | §1.1 | Facility detail |
| `frontend/components/DetailDrawer.tsx` | Hotspot-click detail: classifier class/confidence + viewport GRU risk-signal counts (`RISK_LEVEL_LABELS`) | §1.2 (implicitly, via class) + §1.3 (`overall` levels only, aggregated per viewport, not per hotspot) | Hotspot detail drawer |
| `frontend/components/TopBar.tsx` | Some score summary (needs re-check at implementation time — grep hit, not yet line-inspected) | TBD | Global chrome |
| `frontend/app/dashboard/page.tsx` | Facility list + `a.score` inline (`{a.facility.type} · {a.detectionCount} det · score {a.score}`) AND consumes `/api/command`'s `riskScore` field | §1.1 **and** §1.4's ad hoc blend simultaneously | Dashboard list |
| `frontend/app/facilities/page.tsx` | Facility list, score column | §1.1 | List view |
| `frontend/app/facilities/[id]/page.tsx` | Facility detail, `HealthScoreRing` | §1.1 | Detail view |
| `frontend/app/compare/page.tsx` | Side-by-side score compare | §1.1 | Compare view |
| `frontend/app/predict/page.tsx` | `risk_score` from `/predict` | §1.2 | Predict/hotspot page |
| `frontend/lib/mlApi.ts`, `frontend/lib/features.ts`, `frontend/lib/api.ts`, `frontend/lib/types.ts` | Type defs / fetchers carrying `risk_score`/`riskScore` through | passthrough | client libs |

Every row above must end this task rendering the **same** `riskScore` value,
sourced from the new `riskScoreService`, with no independent computation left
in any of these files.

**Duplication confirmed. Proceeding to Step 2 per the brief's own instruction
("never correct regardless of what you find") — no need to pause for approval.**

---

## 2. Unified Risk Score design (Step 2)

### 2.1 Decision
One score per facility (and, separately, per unregistered hotspot — see §2.6),
called **Risk Score**, `0–100`, **higher = more risk**, everywhere in the app.
"Health score" is retired completely: no variable name, UI label, aria-label,
or comment may use "health" to mean this number after Step 3 (one grandfathered
explanatory comment in `riskScoreService.ts` describing what was replaced is
allowed, per the brief). `command.controller.ts`'s `computeRiskScore` and
`FacilityNarrative.riskScore`'s dead field are both retired, not kept alongside
the new one.

### 2.2 Composition — weighted sum, with a documented deviation

```
riskScore = 0.40 × baseSignal            (FRP-anomaly rule, inverted)
          + 0.35 × environmentSignal     (ML classification-risk, weather+land+OSM informed)
          + 0.25 × temporalSignal        (GRU 1/3/7-day, environment/history informed)
```
renormalized over whichever signals are actually available (see below).

**Base signal (40%)** — `100 - computeHealthScore(...)`. This is a *semantic*
inversion, not `100 - score` bolted on after the fact: `computeHealthScore`
already does `100 - discounted` internally, so the fully-simplified risk
contribution is just `Math.max(0, Math.min(100, discounted))` (the same
clamped penalty sum the health score subtracts from 100). We compute it as
`100 - c.score` at the integration point rather than re-deriving `discounted`,
to avoid duplicating the `computeHealthScore` internals in two places — but the
unit test in §4 explicitly checks the one edge case a naive `100 - score` could
get wrong: `liveCount === 0` short-circuits to `HEALTHY_BASELINE` (90), not
100, inside `computeHealthScore`, so the inverted risk contribution for a fully
quiet site is **10**, not **0**. This must be asserted directly, not assumed.

**Environment/classification signal (35%)** — `compute_classification_risk_score`
from `predict.py`, called through a new `mlProxyService` function (see §2.3).
This is the piece that was previously **absent from the backend's own score
entirely** — the whole point of this fix.

**Temporal signal (25%) — deviation from the brief's suggested bucket mapping,
documented per its own instruction to do so:**
The brief's default is `HIGH=100, MODERATE=55, LOW=15`. We deviate: `pyrosense_ml`
already returns raw per-horizon probabilities (`score_risk()`'s
`{"1day": {"score": 0.0-1.0}, ...}`, and `RiskHorizonEntry.probability` on the
frontend contract). Using raw probabilities is strictly more informative and
already piped end-to-end, so:

```
temporalSignal = 100 × mean(prob_1day, prob_3day, prob_7day)
```

using an unweighted mean of the three horizon probabilities (not the bucketed
`overall` level). Reasoning for equal weighting across horizons rather than
biasing toward the near-term: the three GRUs are independent models trained on
different sequence lengths for different decision timescales, and the brief
gives no basis to prefer one horizon over another for a *composite* danger
number (a 7-day-out escalation is not less "real" risk than a 1-day one, just
differently timed) — this is exactly the ambiguity clause in the brief's own
preamble ("state your reasoning and proceed... flag it in the final report").
**Flag for review:** if product feedback later wants near-term risk weighted
higher inside this one sub-signal, that's a one-line change isolated to
`riskScoreService.ts`, not a re-architecture.

If a future facility/cell has no stored `risk_predictions` row (`GRU
score_risk` never having been run for its H3 cell, e.g. insufficient 30-day
history), we fall back to `overall` bucket mapping (`HIGH=100, MODERATE=55,
LOW=15`) *only* as a degraded path — this is documented in code as the
brief's original suggestion, retained as the fallback rather than discarded.

**Renormalization.** If the environment or temporal signal is unavailable
(ML service down, no stored `risk_predictions` row for the facility's H3 cell,
insufficient history), the weights of the *available* signals are renormalized
to sum to 100%, never treated as 0:
```
available = { base: 0.40 (always available — local, synchronous),
              env:  0.35 if reachable,
              temporal: 0.25 if a stored row exists for this cell }
riskScore = Σ (signal_value × weight) / Σ weight   over available signals
```
The base signal is always available (pure local computation, no network call),
so the worst case is base-only (100% weight on the FRP-anomaly rule), never a
fully-missing score.

**Provenance.** Every response carries `risk_score_provenance: string[]`
listing which signals actually contributed (e.g. `["base", "environment"]` when
temporal was missing) — reusing the exact naming convention already
established by `feature_provenance` (`predict.py`) and `explanation_provenance`
(`genai/explanation_service.py`), not a new pattern.

### 2.3 Where it's computed
New file: `backend/src/services/riskScoreService.ts` — **the only place in the
codebase allowed to produce the number shown to users as "Risk Score."**

```ts
export interface RiskScoreResult {
  riskScore: number;                 // 0-100, rounded
  riskScoreProvenance: string[];     // e.g. ["base","environment","temporal"]
  computedAt: string;                // ISO timestamp
  live: boolean;                     // true = just computed; false = read from cache
}

export async function computeRiskScoreLive(
  facility: FacilityRow,
  classification: Classification,       // from classifyFromDetections — reuse, don't recompute
): Promise<RiskScoreResult> { ... }

export function composeCachedRiskScore(
  baseComponent: number,               // from classification.score, always fresh (local)
  cached: { environment?: number; temporal?: number; computedAt: string } | null,
): RiskScoreResult { ... }
```
It calls:
- `classifyFromDetections` (existing, local, fast) for the base component.
- A new `mlProxyService.proxyClassificationRisk(lat, lng)` — thin wrapper
  around `/predict`, extracting only `risk_score` + `feature_provenance` (not
  the full classification response, to keep this call cheap and its intent
  explicit) — for the environment component, on the single-facility path.
- A new `mlProxyService.proxyCellRisk(h3Cell)` (or reuse the existing
  `/internal/risk/{h3_cell}` proxy if `v1.route.ts` already exposes one
  suitable for server-to-server use — **check `v1.route.ts` and
  `mlProxyService.ts` at implementation time before adding a duplicate proxy
  function**) for the temporal component.

Every UI surface from §1.4 renders **this function's output**, via one new
backend endpoint that returns the already-composed result (§2.5) — the
frontend never calls three sources and merges client-side.

### 2.4 Performance plan

**Bulk views (facility list, map markers — `analyzeAllFacilities`, `/api/command`):**
No live ML call per facility per request — that's O(facilities × ML latency)
and unacceptable at scale. Instead:
- Extend the **existing** nightly orchestrator
  (`pyrosense_ml/app/pipeline/orchestrator.py`, stages
  `ingest → weather → aggregate → risk → hotspots`, already triggered nightly
  at 21:30 UTC by `backend/src/server.ts`'s `cron.schedule("30 21 * * *", ...)`)
  rather than inventing a new scheduled job. Add a stage (or extend `risk`) that,
  for every facility in `getAllFacilitiesMerged()` — **the same facility set the
  Node backend already tracks, not a separately derived list** (this addresses
  the brief's explicit worry about a facility-set mismatch) — computes and
  stores the environment component (`compute_classification_risk_score` via
  the auto-feature-engineering path already used by `/predict`) and looks up
  the temporal component for that facility's H3 cell from `risk_predictions`
  (already populated by the existing `risk` stage — no new GRU inference
  needed for bulk, just a join).
- Store the two cached components + a `computed_at` timestamp keyed by
  facility id in a new small table/column reachable from the Node backend
  (exact storage mechanism — new SQLite table in the Node backend's DB vs. a
  new table in `pyrosense_ml`'s DB read cross-service — is a Step 3
  implementation decision; the existing precedent is `risk_predictions` living
  in `pyrosense_ml`'s DB and being read cross-service via `/internal/risk`, so
  default to that pattern: a new `pyrosense_ml` table +
  `/internal/facility-risk/{facility_id}` or `/batch` endpoint, proxied by
  Node, mirroring `/internal/risk`'s existing shape).
- `analyzeAllFacilities` / `getCommand` read the cached composite +
  `last-computed-at`, reusing the `FreshnessBadge.tsx` pattern already in the
  codebase (its `MetaLike { data_timestamp, stale, cached, age_ms }` contract)
  rather than inventing a new freshness UI.

**Single-facility / single-hotspot detail views:** compute live. This already
has precedent — `getFacilityAnalysis` / the `ObservationsPanels` flow already
makes a live per-facility call to the ML service for environment data in the
same best-effort/non-fatal style; we add the temporal-risk lookup alongside it,
non-fatally (missing temporal → renormalize, don't fail the request).

**UI must show the distinction, not just track it internally:** bulk views
render `"Risk Score — as of {cache timestamp}"` (via `FreshnessBadge`), detail
views render `"Risk Score — live, just computed"`.

### 2.5 File change list

**New:**
- `backend/src/services/riskScoreService.ts` — the single composition point (§2.3)
- `backend/src/services/riskScoreService.test.ts`
- `pyrosense_ml` batch stage/extension for per-facility environment caching (exact
  module TBD at implementation time — likely `orchestrator.py` + a new module
  alongside `risk_batch.py`)
- New backend endpoint serving the pre-composed result to the frontend (e.g.
  extend `/api/command`'s response shape in place, rather than adding a
  parallel endpoint the frontend has to also call — check `v1.route.ts` /
  `command.controller.ts` route wiring at implementation time)
- `docs/RISK_SCORE_UNIFICATION.md` (this document, finalized)

**Rename:**
- `frontend/components/HealthScoreRing.tsx` → `RiskScoreRing.tsx`, ring-fill
  direction inverted (full ring = high risk — chosen because a facility
  operator scanning a dashboard should read "more filled = more urgent",
  consistent with how `DetailDrawer.tsx`'s existing `RISK_LEVEL_COLORS` already
  color HIGH as the alarming end; "full ring = fully assessed" would fight that
  existing convention). Every import site updated.

**Edit (every file from §1.4's table, plus):**
- `backend/src/services/scoringService.ts` — no change to `computeHealthScore`
  itself (still a valid, useful base-signal input, per the brief's own
  reasoning: fast, no network call, real-time thermal behavior). Only its
  *label and consumption* change — nothing here still calls it "health" outside
  the retained one-line explanatory comment.
- `backend/src/services/analysisService.ts` — `FacilityAnalysis.score` and
  `FacilityNarrative.riskScore` (the dead field, §1.4) both replaced by a
  single populated `riskScore: number` + `riskScoreProvenance: string[]`.
  `facts.ts`'s `healthScore` field and its templated-summary line
  (`Thermal Health Score {healthScore}/100`) become `Risk Score
  {riskScore}/100`.
- `backend/src/controllers/command.controller.ts` — delete `computeRiskScore`
  entirely (not deprecate — delete, per the GRU module's own precedent of not
  even leaving old formulas as comments). `CommandFacility` keeps one
  `riskScore` field, sourced from `riskScoreService`'s cached bulk path.
  `classifyRuleBased`/`CLASSIFICATION_SEVERITY` usage here is re-evaluated: if
  nothing else in the codebase needs the rule-based classification label
  independent of scoring, consider whether it survives Step 3 at all, or
  whether it's replaced by the ML classifier's own `class` field — **flag as
  an open question for the final report**, don't silently delete
  functionality the brief didn't ask about.
- `frontend/app/predict/page.tsx` / `DetailDrawer.tsx` — per the brief's §3.6:
  a hotspot with no registered facility has no FRP-anomaly base component, so
  its Risk Score there is legitimately environment+temporal only,
  renormalized. Add a one-line caption: *"based on classification + temporal
  signals only — no registered facility history at this point."*

### 2.6 Hotspot vs. facility scores — explicit UI distinction
Per §3.6 of the brief: unregistered hotspots (from the Predict page /
`DetailDrawer`) get a Risk Score computed the same way but with the base
signal weight redistributed (renormalized over env+temporal only, since there's
no facility detection history to anchor a base signal to). The tooltip above
makes this visible so nobody mistakes the two numbers for being computed
identically.

---

## 3. Implementation checklist (Step 3)

- [ ] `riskScoreService.ts`: implement formula, renormalization, provenance
- [ ] Add/confirm `mlProxyService` functions for (a) classification-risk-only
      extraction from `/predict`, (b) cell-risk read — reuse existing proxy if
      one already covers `/internal/risk`
- [ ] Wire into `analysisService.ts`'s `analyzeFacility` (live path) — rename
      `score` → `riskScore` on `FacilityAnalysis`/`FacilityNarrative`; run
      `npx tsc --noEmit` repeatedly as references break, not once at the end
- [ ] Rename `HealthScoreRing.tsx` → `RiskScoreRing.tsx`, invert fill logic,
      update all import sites (§1.4 table)
- [ ] Update all §1.4 UI surfaces to render the unified value + provenance +
      freshness (cached vs. live wording per §2.4)
- [ ] Delete `command.controller.ts`'s `computeRiskScore`; wire `/api/command`
      to the cached bulk composite; decide fate of `classifyRuleBased` usage
      here (flag in final report either way)
- [ ] Extend `pyrosense_ml/app/pipeline/orchestrator.py` (or a sibling module)
      to compute + store per-facility environment component + temporal lookup,
      iterating `getAllFacilitiesMerged()`'s exact facility set (via whatever
      cross-service contract already exists, or a small new one modeled on
      `/internal/risk`)
- [ ] Add the new backend endpoint/response field serving the pre-composed
      result (extend, don't duplicate, existing routes)
- [ ] `grep -rn "health.score\|healthScore\|Health Score" frontend/ backend/`
      after edits — must return zero hits outside one permitted explanatory
      comment in `riskScoreService.ts`

---

## 4. Tests (Step 4)

`backend/src/services/riskScoreService.test.ts` — **no existing `*.test.ts`
files were found in this repo**, so confirm the actual test runner from
`backend/package.json` before assuming Jest/Vitest (not yet checked at
planning time — do this first in Step 4, per the brief's own instruction).

Cases:
1. All three signals available → correct weighted composite (hand-computed
   fixture, not a snapshot)
2. ML service unreachable → renormalized to base-only, provenance = `["base"]`
3. Temporal unavailable (no `risk_predictions` row for the cell) but
   classification available → two-signal renormalization, provenance =
   `["base","environment"]`
4. **Explicit edge case from §2.2**: `liveCount === 0` (quiet site) → base
   contribution is exactly `100 - HEALTHY_BASELINE = 10`, not `0`
5. Monotonicity: increasing danger on any *one* signal, holding the others
   fixed, never decreases the composite — test this as a property (loop over
   perturbations), not a single example

`pyrosense_ml` side: extend/add tests near `pyrosense_ml/tests/` (existing
`conftest.py`/pytest setup found — reuse it) for the new batch stage's
per-facility caching, and confirm `test_regression_known_sample.py` (existing
GRU regression test) still passes unmodified — this task must not touch model
weights or `score_risk()` itself.

Run the full backend suite + `pyrosense_ml` suite; fix real causes only.
`cd frontend && npx tsc --noEmit && npm run build` — must be clean.

---

## 5. Verify end-to-end (Step 5)

1. Start backend + `pyrosense_ml` locally (background, capture PIDs)
2. `curl` a single-facility analysis endpoint → confirm exactly one score
   field (`riskScore`), with `riskScoreProvenance` and a computed-at timestamp
3. `curl` the facility list/map endpoint → confirm it returns the **cached**
   composite (response time flat, not proportional to facility count × ML
   latency) plus a `last-computed-at` distinct from the live endpoint's
4. Trace in code (not by eyeballing): does a facility's map marker color and
   its detail-page ring read from the *same* `riskScoreService` output?
5. Kill background processes cleanly

---

## 6. Commit (Step 6)

```
git add -A
git commit -m "Unify health score and ML risk score into one Risk Score,
genuinely composed from FRP-anomaly rules + weather/land-cover-informed
classification + GRU temporal risk, with honest provenance and cached
bulk / live detail views"
```
Do not push.

---

## Open items to surface in the final report (per the brief's explicit ask)

1. **A third and fourth score concept were found beyond the two named in the
   brief**: `command.controller.ts`'s `computeRiskScore` (a fourth ad hoc
   blend, live in production on the dashboard/chatbot endpoint today) and
   `FacilityNarrative.riskScore` (a dead, never-populated field). Both are
   retired by this plan, not left as unify-later debt.
2. `predict.py`'s `RISK_NOT_IMPLEMENTED_DETAIL` / HTTP 501 gate is stale —
   the GRU pipeline it claims doesn't exist yet is actually live elsewhere in
   the repo. Not this task's job to fix that endpoint's gate, but worth
   flagging since it could confuse the next engineer who reads `/predict`'s
   docstring at face value.
3. `classifyRuleBased`/`CLASSIFICATION_SEVERITY` in `command.controller.ts`
   is a rule-based classifier distinct from the ML classifier — its fate after
   `computeRiskScore` is deleted needs a decision (kept as informational label,
   or dropped in favor of the ML `class` field).
4. Exact cross-service storage mechanism for the new per-facility environment
   cache (new `pyrosense_ml` table + endpoint vs. Node-side table) is proposed
   but not finalized in this doc — resolve during Step 3 by first checking
   whether `v1.route.ts` already has infrastructure this can reuse.

---

## 7. Resolved decisions (post-implementation)

The plan's open items, settled during Step 3 with reasons:

**7.1 Cross-service storage** — Node-pushed cache table on BOTH sides.
A direct source read showed `pyrosense_ml` has no facility concept at all
(no table, no model, no reference anywhere in `app/`). Deriving its own
facility list would have invented one — the exact facility-set mismatch the
brief warned about. So the direction is reversed from the doc's default:
Node PUSHES its exact facility set (`getAllFacilitiesMerged()` ids + coords)
to the new `POST /internal/facility-risk/sync`; pyrosense_ml registers the
rows in a new `facility_risk_cache` table (mirroring the Node-side
`facility_risk_cache` table), computes components in a new nightly
`facility_risk` pipeline stage, and serves the latest computed components
back on each sync call. The sync job runs at 22:15 UTC — 45 min after the
21:30 UTC pipeline trigger — so it reads freshly-written `risk_predictions`.

**7.2 Environment component endpoint** — `/internal/classify`, not
`/predict`. Source inspection showed `POST /predict` persists a hotspot +
prediction + timeline snapshot AND runs the GenAI explanation chain on every
call — unacceptable side effects for a scoring read. The existing
`POST /internal/classify` runs the identical engineering + inference path
with zero persistence and no GenAI, and already exposes `risk_score` +
`feature_provenance`. It is the scoring primitive; the mlClient Zod schema
(`ClassificationRiskResponseSchema`) validates its output at the boundary.

**7.3 Temporal-component freshness on the sync path** — when the sync
endpoint serves a computed row, it recomputes the temporal component inline
from the current `risk_predictions` (the GRU output) rather than serving the
nightly stage's possibly-stale copy. Same formula both sides (raw
probability mean × 100; bucket fallback HIGH=100/MODERATE=55/LOW=15), pinned
by paired tests (`test_facility_risk.py` ↔ `riskScoreService.test.ts`) so
the two implementations cannot drift.

**7.4 `classifyRuleBased` fate** — KEPT, as an informational label only.
The dashboard/chatbot UI groups and displays `classificationLabel`; deleting
it would remove user-facing functionality the brief didn't ask to remove.
It no longer contributes to any score: `command.controller.ts`'s
`computeRiskScore` blend is deleted outright (the GRU module's Phase 2A
precedent), and the label is documented as non-scoring at both the type
level (`CommandFacility`) and in this doc.

**7.5 Degenerate case found during e2e verification** — a hotspot with the
ML service down AND no stored prediction composes zero contributing signals.
`composeFromComponents` now returns `riskScore: 0` with an EMPTY provenance
array and the contract states: empty provenance means "unavailable", never
"no risk". Verified live via `GET /api/v1/risk-score?lat=…&lng=…`.

**7.6 Naming sweep went to the function level** — the brief's zero-hits rule
("no variable name… may use 'health'") required renaming
`computeHealthScore` → `computeBaseScore`, `HealthScoreInput` →
`BaseScoreInput`, `HEALTHY_BASELINE` → `QUIET_BASELINE` (value and semantics
unchanged; it is the documented 90 floor for a quiet site). Remaining
"health" strings are service-health endpoints (`/health`,
`proxyMlHealth`), which refer to uptime probes, not scores.

**7.7 Verification against the live production-shaped DB** (54,570
facilities, 209 MB SQLite):
- `/api/command`: 25.2 s cold (classification of every facility — the
  pre-existing bulk cost, not the risk composition), **0.146 s warm** —
  the cached bulk path adds no per-facility ML latency. Provenance
  `["base"]` while the ML service is down (honest degradation), sorted
  descending by riskScore, zero `healthScore` fields in the response.
- `/api/facilities/:id/analyses`: live composition in 0.2 s with the ML
  service down — renormalized to base-only, `riskScoreLive: true`,
  narrative and top-level blocks identical, templated summary says
  "Risk Score …/100 (higher = more risk)".
- Quiet-site assertion on real data: a facility with no detections scores
  exactly 10 (the 100 − QUIET_BASELINE edge case from §2.2), not 0.
- Servers killed cleanly after verification.

---

## 8. Final report (per the brief's explicit ask)

1. **Two additional score concepts beyond the two named in the brief were
   found and retired**: `command.controller.ts`'s `computeRiskScore` (a
   fourth ad hoc blend, live on the dashboard/chatbot endpoint) and the dead
   never-populated `FacilityNarrative.riskScore` field. The fifth concept
   named in the brief (`predict.py`'s classification-derived score) survived
   — as the environment component of the unified score.
2. **`predict.py`'s `RISK_NOT_IMPLEMENTED_DETAIL` / HTTP 501 gate is stale** —
   the GRU pipeline it claims doesn't exist is live elsewhere. Not fixed
   here (out of scope), but flagged: the docstring misleads the next reader.
   Note the gate is *partially* wrong: `/predict` DOES return the
   classification-derived `risk_score` — only the GRU temporal fields are
   gated behind the 501.
3. **`classifyRuleBased` fate**: kept as a purely informational behavioural
   label (see 7.4) — flagged for product review if the UI grouping ever
   moves to the ML classifier's own class field.
4. **Weighting is a product decision, not a law of nature**: 0.40/0.35/0.25
   and the equal-horizon temporal mean are documented defaults, isolated to
   `riskScoreService.ts` constants — a one-line change each if review
   wants different emphasis. The near-term-horizon-weighting flag from §2.2
   remains open for the same reason.
5. **No existing test runner existed** (as suspected in §4); `node:test` via
   the installed tsx loader was added (`npm run test:services`), plus the
   paired pytest file on the ML side. Both suites pass; the pre-existing
   GRU regression test passes unmodified.
6. **Known limitation**: the nightly sync currently computes the environment
   component with the synchronous inference path per facility; at the
   current facility count (54.5k) a full pass is a long-running batch — the
   pipeline stage design (job-run bookkeeping, per-facility isolation,
   idempotent upserts) tolerates partial completion, and components fill in
   progressively. If facility count grows another order of magnitude, this
   stage should move to explicit batching/chunking across nights.
