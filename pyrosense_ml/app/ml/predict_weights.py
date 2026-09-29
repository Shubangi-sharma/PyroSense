"""Classification-derived risk weighting — shared by /predict and the
facility-risk pipeline stage (single source of truth for the category
danger weights that feed the unified Risk Score's environment component).
"""

from __future__ import annotations

# Domain-expert category risk weights for computing a composite risk score
# from the classifier's probability distribution. Higher weight = category
# is inherently more dangerous / demands faster response.
CATEGORY_RISK_WEIGHTS: dict[str, float] = {
    "Agricultural": 0.30,
    "Forest_Vegetation": 0.55,
    "Industrial": 0.85,
    "Infrastructure_Energy": 0.70,
    "Mining": 0.65,
}


def compute_classification_risk_score(probabilities: dict[str, float]) -> float:
    """Weighted probability sum → 0-100 risk score from ML classification output.

    Each predicted class has a domain-assigned risk weight. The composite score
    is the sum of (probability × weight) across all classes, scaled to [0, 100].
    This is NOT the GRU temporal risk model — it's a classification-derived proxy
    that reflects how dangerous the predicted event category is.
    """
    score = sum(
        prob * CATEGORY_RISK_WEIGHTS.get(cls, 0.5)
        for cls, prob in probabilities.items()
    )
    return round(min(score * 100, 100.0), 2)
