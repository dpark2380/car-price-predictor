"""
tests/test_eval.py — VIN-grouped split, scoring price floor, and the
segment-scaled deal score.
Run: PYTHONPATH=. python3 tests/test_eval.py
"""
from datetime import datetime

import numpy as np
import pandas as pd

from db.models import init_db, get_session, CarListing, Prediction, MIN_PRICE
from db.repository import ListingRepository, PredictionRepository
from ml.pipeline import (_vin_split, _vin_groups, _deal_score_from_prices, _deal_label,
                         _segment_errors, _segment_error_for,
                         _dealer_keys, _cohort_ref, _cohort_features)


def test_vin_split_disjoint():
    # 300 cars, many listed 2-3 times under different ids, some without a VIN
    rng = np.random.default_rng(0)
    vins = [f"VIN{i}" for i in rng.integers(0, 300, 900)] + [""] * 50
    df = pd.DataFrame({"vin": vins, "listing_id": range(len(vins))})
    tr, va, te = _vin_split(df)
    assert sorted(np.concatenate([tr, va, te])) == list(range(len(df)))
    g = _vin_groups(df).to_numpy()
    s = [set(g[i]) for i in (tr, va, te)]
    assert not (s[0] & s[1]) and not (s[0] & s[2]) and not (s[1] & s[2])
    assert 0.15 < len(te) / len(df) < 0.25 and 0.1 < len(va) / len(df) < 0.22
    assert all((a == b).all() for a, b in zip((tr, va, te), _vin_split(df)))  # deterministic


def test_price_floor():
    session = get_session(init_db("sqlite://"))
    now = datetime.utcnow()
    for lid, price in (("cheap", MIN_PRICE - 1), ("ok", MIN_PRICE)):
        session.add(CarListing(listing_id=lid, vin=lid, price=price, year=2015, mileage=90_000,
                               make="honda", model="civic", last_seen=now, is_active=1))
        session.add(Prediction(listing_id=lid, predicted_price=9000, deal_score=100.0, deal_label="5 Stars"))
    session.commit()

    assert list(ListingRepository(session).get_scoring_listings_df().listing_id) == ["ok"]
    preds = PredictionRepository(session)
    assert list(preds.get_top_deals(limit=None).listing_id) == ["ok"]  # stale sub-floor score hidden
    assert preds.count_graded() == 1


def test_deal_score_scales_with_segment_error():
    # default scale is the original fixed formula: 50 + 1.25 * diff_pct
    for actual in (6000, 8000, 10000, 12000):
        diff = (10000 - actual) / 10000 * 100
        assert abs(_deal_score_from_prices(actual, 10000) - min(100, max(0, 50 + 1.25 * diff))) < 1e-9
    # same 20% discount: 5 stars where the model is usually within 6%, 3 stars at 17%
    assert _deal_label(_deal_score_from_prices(8000, 10000, 6.0)) == "5 Stars"
    assert _deal_label(_deal_score_from_prices(8000, 10000, 17.0)) == "3 Stars"
    # 5 stars needs a discount of at least 3x the segment error
    assert _deal_label(_deal_score_from_prices(8200, 10000, 6.0)) == "5 Stars"   # 18% = 3x
    assert _deal_label(_deal_score_from_prices(8300, 10000, 6.0)) != "5 Stars"   # 17%


def test_segment_errors():
    true = np.array([5000.0] * 40 + [25000.0] * 40 + [80000.0] * 3)
    pred = true * np.array([1.2] * 40 + [1.05] * 40 + [1.5] * 3)
    errs = _segment_errors(true, pred)
    assert abs(_segment_error_for(5000, errs) - 20) < 1e-6
    assert abs(_segment_error_for(25000, errs) - 5) < 1e-6
    overall = float(np.median(np.abs(pred - true) / true * 100))
    assert abs(_segment_error_for(80000, errs) - overall) < 1e-6   # only 3 rows: falls back
    assert abs(_segment_error_for(25000, None) - 32 / 3) < 1e-9     # old payloads

    # by cohort size: 30 rare $5k cars at 40% error, 30 common ones at 10%
    true = np.array([5000.0] * 60)
    pred = true * np.array([1.4] * 30 + [1.1] * 30)
    errs = _segment_errors(true, pred, np.array([1.0] * 30 + [50.0] * 30))
    assert abs(_segment_error_for(5000, errs, 0) - 40) < 1e-6
    assert abs(_segment_error_for(5000, errs, 12) - 10) < 1e-6
    assert abs(_segment_error_for(5000, errs, 5) - 25) < 1e-6      # empty cell: band error
    assert abs(_segment_error_for(5000, errs) - 25) < 1e-6         # no count given


def test_cohort_features_exclude_own_dealer():
    df = pd.DataFrame({
        "make": ["honda"] * 4 + ["ford"], "model": ["civic"] * 4 + ["focus"], "year": [2018.0] * 5,
        "dealer_name": ["Hertz", " hertz", "Bob's", "", "Bob's"], "listing_id": list("abcde"),
    })
    price = pd.Series([10000.0, 12000.0, 20000.0, 30000.0, 9000.0])
    d = _dealer_keys(df)
    X = _cohort_features(df, d, _cohort_ref(df, d, price))
    # Hertz cars see only Bob's and the no-name car; the others see the other three
    assert list(X.cohort_median_price[:4]) == [25000.0, 25000.0, 12000.0, 12000.0]
    assert list(X.cohort_count) == [2.0, 2.0, 3.0, 3.0, 0.0]
    assert np.isnan(X.cohort_median_price[4])  # only its own dealer has this cohort


if __name__ == "__main__":
    test_vin_split_disjoint()
    test_price_floor()
    test_deal_score_scales_with_segment_error()
    test_segment_errors()
    test_cohort_features_exclude_own_dealer()
    print("ok")
