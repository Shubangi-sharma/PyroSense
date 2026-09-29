"""POST /predict — classify a new/live hotspot end-to-end.

Phase 2A pipeline: schema guard → MLP classifier → class + confidence →
persistence (hotspot + prediction + daily snapshot) → GenAI explanation →
response.

Two modes:
- Full auto mode (default): only latitude/longitude required; the 43 classifier
  features are engineered from SQLite detection history + OSM + land cover +
  weather, with documented fallbacks.
- Expert mode: a full 43-feature payload bypasses engineering (still passes
  the schema guard).

RISK PREDICTION PATH (Phase 2A): the GRU risk models need a 30-day × 17-feature
H3-cell sequence that this endpoint cannot build yet — that is Phase 2C's live
feature pipeline. Until then the risk path returns HTTP 501 with a clear
error; it is never faked or silently skipped.
"""

from __future__ import annotations

import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.health import get_db
from app.data.live import (
    get_or_create_live_hotspot,
    record_timeline_snapshot,
    save_prediction,
)
from app.feature_schema import (
    CLASSIFIER_FEATURES,
    CLASSIFIER_FEATURES_OLD,
    CLASSIFIER_MODEL_VERSION,
    DATASET_VERSION,
    SCHEMA_VERSION,
    SchemaViolation,
)
from app.features.engineer import engineer_features
from app.ml.inference import predict as run_inference
from app.ml.risk_score import score_risk  # ready for Phase 2C; unused until then
from app.genai.explanation_service import get_explanation

logger = logging.getLogger("pyrosense.api.predict")

router = APIRouter()

RISK_NOT_IMPLEMENTED_DETAIL = (
    "risk prediction requires the live H3 feature pipeline, not yet built (Phase 2C)"
)

# Category risk weights + the weighted-probability risk score now live in
# app.ml.predict_weights — the single source of truth shared with the
# facility-risk pipeline stage (both feed the unified Risk Score's
# environment component). Re-exported here for backwards compatibility.
from app.ml.predict_weights import (  # noqa: E402
    CATEGORY_RISK_WEIGHTS,
    compute_classification_risk_score,
)


class PredictRequest(BaseModel):
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    region: str | None = None
    features: dict[str, float | str] | None = None
    # Decision (b): "new" (default, MLP) or "old" (legacy GBM) — see
    # docs/decisions-and-faq.md. The response's classifier_model_used field
    # always names the model that actually answered.
    model_version: Literal["new", "old"] | None = None
    # Phase 2A: risk is not computable yet (no live H3 sequence pipeline).
    include_risk: bool = False

    @field_validator("features")
    @classmethod
    def _reject_leakage_early(cls, v: dict | None) -> dict | None:
        from app.feature_schema import LEAKAGE_COLUMNS

        if v is not None:
            leaky = LEAKAGE_COLUMNS.intersection(v)
            if leaky:
                raise ValueError(
                    f"leakage column(s) {sorted(leaky)} must never be provided as input"
                )
        return v


@router.post("/predict")
async def predict_endpoint(
    body: PredictRequest,
    session: AsyncSession = Depends(get_db),
):
    # ── 0. Risk path: cannot run until the Phase 2C H3 pipeline exists ──────
    # Never fake a sequence, never return a made-up risk score, never silently
    # skip the risk fields — refuse loudly instead.
    if body.include_risk:
        raise HTTPException(status_code=501, detail={"error": RISK_NOT_IMPLEMENTED_DETAIL})

    # ── 1. Features: engineer or accept expert payload ──────────────────────
    warnings: list[str] = []
    provenance: dict[str, str] = {}
    if body.features is None:
        engineered = await engineer_features(body.latitude, body.longitude)
        features = engineered.features
        warnings = engineered.warnings
        provenance = engineered.provenance
    else:
        features = dict(body.features)
        provenance = {"features": "client_provided"}

    # ── 2. Schema guard → classifier ─────────────────────────────────────────
    try:
        expected_count = (
            len(CLASSIFIER_FEATURES_OLD)
            if (body.model_version or "new") == "old"
            else len(CLASSIFIER_FEATURES)
        )
        result = run_inference(features, model_version=body.model_version)
        if body.features is not None and len(features) != expected_count:
            raise SchemaViolation(
                f"expert payload must contain all {expected_count} features "
                f"for model_version={body.model_version or 'new'} "
                f"(got {len(features)})"
            )
    except SchemaViolation as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    # ── 3. Compute classification-derived risk score ─────────────────────
    cls_risk_score = compute_classification_risk_score(result.probabilities)

    # ── 4. Persist hotspot + prediction + daily snapshot ────────────────────
    created = await get_or_create_live_hotspot(
        session, latitude=body.latitude, longitude=body.longitude, region=body.region
    )
    pred = await save_prediction(
        session,
        hotspot=created.hotspot,
        result=result,
        risk_score=cls_risk_score,
        top_contributing_features=[],  # per-feature importances not exposed by the MLP
        source="live",
    )
    await record_timeline_snapshot(session, hotspot=created.hotspot, prediction=pred)
    await session.commit()

    # ── 5. GenAI explanation (cached → LLM → template) ──────────────────────
    explanation, explanation_provenance = await get_explanation(
        session,
        features=result.features,
        risk_score=cls_risk_score,
        predicted_class=result.predicted_class,
        probabilities=result.probabilities,
        confidence=result.confidence,
        top_features=[],
        source="live",
        prediction_id=pred.id,
    )
    await session.commit()

    return {
        "hotspot_id": created.hotspot.hotspot_uid,
        # Echo the analyzed coordinates so clients can display them from the
        # response itself (single source of truth for what was classified).
        "latitude": body.latitude,
        "longitude": body.longitude,
        "class": result.predicted_class,
        "probabilities": result.probabilities,
        "confidence": result.confidence,
        "classifier_model_used": result.classifier_model_used,
        "risk": None,
        "risk_unavailable": RISK_NOT_IMPLEMENTED_DETAIL,
        # Contract-compat fields for the frontend's PredictionResponseDto:
        # explicit null / empty rather than absent keys, so no client can
        # mistake their absence for a bug (risk stays un-faked until Phase 2C).
        "risk_score": cls_risk_score,
        "top_contributing_features": [],
        "explanation": explanation,
        "explanation_provenance": explanation_provenance,
        "source": "live",
        "model_version": CLASSIFIER_MODEL_VERSION,
        "dataset_version": DATASET_VERSION,
        "feature_schema_version": SCHEMA_VERSION,
        "prediction_timestamp": result.prediction_timestamp.isoformat(),
        "feature_provenance": provenance,
        "warnings": warnings,
    }
