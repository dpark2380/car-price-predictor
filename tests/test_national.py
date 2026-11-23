"""tests/test_national.py — rough ratings from US-wide figures. Run: PYTHONPATH=. python3 tests/test_national.py"""
from ml.pipeline import _national_score, _deal_label

S = {"count": 50, "median": 20000, "p25": 18000, "p75": 23000}


def test_national_score():
    assert _national_score(20000, S) == 50
    assert _national_score(18000, S) == 75 and _deal_label(75) == "4 Stars"    # p25 = cheap quartile
    assert _national_score(23000, S) == 25                                      # p75 = dear quartile
    assert _national_score(19000, S) == 62.5 and _national_score(21500, S) == 37.5  # each side scales on its own spread
    assert _national_score(5000, S) == 89.9 and _national_score(90000, S) == 15  # clamped out of the top and bottom tiers
    assert _national_score(18000, S, model_score=95) == round(0.7 * 75 + 0.3 * 95, 1)  # blended with the model's score


def test_national_unrated():
    assert _national_score(18000, {**S, "count": 29}) is None   # too few listed
    assert _national_score(18000, None) is None                 # no stats row
    assert _national_score(18000, {**S, "p25": None}) is None
    assert _national_score(18000, {**S, "p25": 20000}) is None  # no spread to measure against
