"""
tests/test_eval.py — VIN-grouped split and the scoring price floor.
Run: PYTHONPATH=. python3 tests/test_eval.py
"""
from datetime import datetime

import numpy as np
import pandas as pd

from db.models import init_db, get_session, CarListing, Prediction, MIN_PRICE
from db.repository import ListingRepository, PredictionRepository
from ml.pipeline import _vin_split, _vin_groups


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


if __name__ == "__main__":
    test_vin_split_disjoint()
    test_price_floor()
    print("ok")
