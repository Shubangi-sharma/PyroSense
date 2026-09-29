"""Facility-risk component tests — pure logic, no DB or models required.

The temporal component's shape MUST stay identical on both sides of the
sync (Node's riskScoreService::temporalSignalFromCellRisk and this repo's
temporal_from_horizons) so the same stored GRU prediction always yields the
same signal. These tests pin this repo's side; Node's side is pinned by
backend/src/services/riskScoreService.test.ts.
"""

from __future__ import annotations

import pytest

from app.pipeline.facility_risk import temporal_from_horizons


def _h(p1=0.0, p3=0.0, p7=0.0):
    return {
        "1day": {"probability": p1},
        "3day": {"probability": p3},
        "7day": {"probability": p7},
    }


def test_raw_probabilities_win_over_bucket():
    t = temporal_from_horizons(_h(0.2, 0.5, 0.9), "HIGH")
    assert t is not None
    signal, source = t
    assert abs(signal - (0.2 + 0.5 + 0.9) / 3 * 100) < 1e-9
    assert source == "raw_probabilities"


def test_mean_is_unweighted_across_horizons():
    t = temporal_from_horizons(_h(0.3, 0.3, 0.3), "LOW")
    assert t is not None
    signal, source = t
    assert signal == pytest.approx(30.0)
    assert source == "raw_probabilities"


@pytest.mark.parametrize(
    ("overall", "expected"),
    [("HIGH", 100.0), ("MODERATE", 55.0), ("LOW", 15.0)],
)
def test_bucket_fallback_matches_node(overall, expected):
    t = temporal_from_horizons({}, overall)
    assert t is not None
    signal, source = t
    assert signal == expected
    assert source == "overall_bucket_fallback"


def test_unknown_overall_and_no_probabilities_is_none():
    assert temporal_from_horizons({}, "WEIRD") is None
    assert temporal_from_horizons(None, None) is None


def test_partial_horizons_use_what_exists():
    t = temporal_from_horizons({"1day": {"probability": 0.4}}, "LOW")
    assert t is not None
    signal, source = t
    assert signal == pytest.approx(40.0)
    assert source == "raw_probabilities"


def test_out_of_range_probability_is_ignored():
    t = temporal_from_horizons({"1day": {"probability": 1.5}}, "LOW")
    assert t is not None
    signal, source = t
    assert signal == 15.0
    assert source == "overall_bucket_fallback"
