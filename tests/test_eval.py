"""
tests/test_eval.py — VIN-grouped split, scoring price floor, and the
segment-scaled deal score.
Run: PYTHONPATH=. python3 tests/test_eval.py
"""
from datetime import datetime

import numpy as np
import pandas as pd
from sklearn.base import BaseEstimator

from db.models import init_db, get_session, CarListing, Prediction, MIN_PRICE
from db.repository import ListingRepository, PredictionRepository
from ml.pipeline import (_vin_split, _vin_groups, _deal_score_from_prices, _deal_label,
                         _segment_errors, _segment_error_for,
                         _dealer_keys, _cohort_ref, _cohort_features, PriceRouted)


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
        "make": ["honda"] * 4 + ["ford"], "model": ["civic"] * 4 + ["focus"], "year": [2018.0] * 5, "mileage": [50_000.0] * 5, "trim": [""] * 5,
        "dealer_name": ["Hertz", " hertz", "Bob's", "", "Bob's"], "listing_id": list("abcde"),
    })
    price = pd.Series([10000.0, 12000.0, 20000.0, 30000.0, 9000.0])
    d = _dealer_keys(df)
    X = _cohort_features(df, d, _cohort_ref(df, d, price))
    # Hertz cars see only Bob's and the no-name car; the others see the other three
    assert list(X.cohort_median_price[:4]) == [25000.0, 25000.0, 12000.0, 12000.0]
    assert list(X.cohort_count) == [2.0, 2.0, 3.0, 3.0, 0.0]
    assert np.isnan(X.cohort_median_price[4])  # only its own dealer has this cohort


def test_comp_price_uses_nearest_other_dealer_cars():
    df = pd.DataFrame({
        "make": ["honda"] * 4, "model": ["civic"] * 4, "year": [2018.0, 2018.0, 2018.0, 2010.0],
        "mileage": [50_000.0, 50_000.0, 50_000.0, 50_000.0], "trim": ["ex", "ex", "ex", "ex"],
        "dealer_name": ["Hertz", "Hertz", "Bob's", "Al's"], "listing_id": list("abcd"),
    })
    price = pd.Series([99_000.0, 99_000.0, 20_000.0, 5_000.0])
    d = _dealer_keys(df)
    X = _cohort_features(df, d, _cohort_ref(df, d, price))
    # Hertz cars never see Hertz prices; Bob's twin (dist 0) outweighs Al's 8-year-older car
    w_bob, w_al = 1 / 0.5, 1 / 8.5
    assert abs(X.comp_price[0] - (20_000 * w_bob + 5_000 * w_al) / (w_bob + w_al)) < 1e-6
    assert X.comp_price[0] < 20_000
    # a different trim weighs like 2 years: Bob's LX now sits between the EX cars
    df["trim"] = ["ex", "ex", "lx", "ex"]
    X = _cohort_features(df, d, _cohort_ref(df, d, price))
    w_bob, w_al = 1 / 2.5, 1 / 8.5
    assert abs(X.comp_price[0] - (20_000 * w_bob + 5_000 * w_al) / (w_bob + w_al)) < 1e-6


def test_price_routed_picks_model_by_cheap_prediction():
    class Const(BaseEstimator):
        def __init__(self, v=0.0): self.v = v
        def fit(self, X, y): return self
        def predict(self, X): return np.where(np.asarray(X)[:, 0] > 0, self.v, np.log1p(5_000))
    r = PriceRouted(cheap=Const(np.log1p(20_000)), rest=Const(np.log1p(30_000))).fit(np.zeros((2, 1)), [0, 0])
    # row 0: cheap model says $5k -> keeps it; row 1: cheap says $20k -> rest's $30k
    assert np.allclose(np.expm1(r.predict(np.array([[0.0], [1.0]]))), [5_000, 30_000])


def test_monthly_call_budget():
    import tempfile
    from pathlib import Path
    from scraper import api_usage, data_ingest
    old_path, old_budget = api_usage.USAGE_PATH, data_ingest.MONTHLY_CALL_BUDGET
    try:
        api_usage.USAGE_PATH = Path(tempfile.mkdtemp()) / "usage.json"
        month = api_usage._today_key()[:7]
        api_usage._atomic_write(api_usage.USAGE_PATH, {"total": 9, "days": {
            f"{month}-01": {"total": 4}, f"{month}-02": {"total": 3}, "1999-01-01": {"total": 2}}})
        assert api_usage.month_total() == 7
        data_ingest.MONTHLY_CALL_BUDGET = 7   # reached: no request is made
        tmp = api_usage.USAGE_PATH.parent
        assert data_ingest.MarketCheckClient().fetch_listings(
            max_calls=3, page_cursor_path=tmp / "p.json", zip_cursor_path=tmp / "z.json") == []
        assert api_usage.month_total() == 7
    finally:
        api_usage.USAGE_PATH, data_ingest.MONTHLY_CALL_BUDGET = old_path, old_budget


def test_month_end_topup():
    from datetime import datetime
    from scheduler import runner
    used = [0]
    def fake_scrape(*a):
        used[0] += 15
    old = runner.scrape_job, runner.month_total, runner.MONTHLY_CALL_BUDGET
    try:
        runner.scrape_job, runner.month_total, runner.MONTHLY_CALL_BUDGET = fake_scrape, lambda: used[0], 500
        assert runner.month_end_topup(None, None, None, now=datetime(2026, 11, 29)) == 0  # not the last day
        used[0] = 451
        assert runner.month_end_topup(None, None, None, now=datetime(2026, 11, 30)) == 3  # 451 -> 496
        assert used[0] == 496
        runner.scrape_job = lambda *a: None   # calls not going out: one pass, then stop
        used[0] = 0
        assert runner.month_end_topup(None, None, None, now=datetime(2026, 12, 31)) == 1
    finally:
        runner.scrape_job, runner.month_total, runner.MONTHLY_CALL_BUDGET = old


def test_purge_cloudflare_cache():
    import os, urllib.request
    from scheduler import runner
    sent, old = [], urllib.request.urlopen
    try:
        urllib.request.urlopen = lambda req, timeout: sent.append(req)
        os.environ.pop("CLOUDFLARE_ZONE_ID", None)
        runner.purge_cloudflare_cache()          # unset: nothing sent
        assert sent == []
        os.environ.update(CLOUDFLARE_ZONE_ID="z1", CLOUDFLARE_API_TOKEN="t1")
        runner.purge_cloudflare_cache()
        req = sent[0]
        assert req.full_url.endswith("/zones/z1/purge_cache") and req.get_method() == "POST"
        assert req.get_header("Authorization") == "Bearer t1" and b"purge_everything" in req.data
        def boom(req, timeout): raise OSError("down")
        urllib.request.urlopen = boom
        runner.purge_cloudflare_cache()          # failure must not raise
    finally:
        urllib.request.urlopen = old
        for k in ("CLOUDFLARE_ZONE_ID", "CLOUDFLARE_API_TOKEN"):
            os.environ.pop(k, None)


def test_map_listing_keeps_first_https_photo():
    from scraper.data_ingest import map_listing
    raw = {"price": 20000, "miles": 1000, "vin": "X", "id": "1",
           "build": {"year": 2020, "make": "Kia", "model": "K5"},
           "media": {"photo_links": ["http://a/x.jpg", "https://cdn.example/1.jpg"]}}
    assert map_listing(raw)["photo_url"] == "https://cdn.example/1.jpg"
    assert map_listing({**raw, "media": None})["photo_url"] is None
    cached = {"photo_links": ["https://cdn.marketcheck.com/img.jpg?api_key=SECRET", "https://img.marketcheck.com/x.jpg"]}
    assert map_listing({**raw, "media": cached})["photo_url"] is None
    stub = {"photo_links": ["https://dealer.example/img/vehicle-image-notavailable-320x240.jpg", "https://cdn.example/2.jpg"]}
    assert map_listing({**raw, "media": stub})["photo_url"] == "https://cdn.example/2.jpg"


if __name__ == "__main__":
    test_vin_split_disjoint()
    test_price_floor()
    test_deal_score_scales_with_segment_error()
    test_segment_errors()
    test_cohort_features_exclude_own_dealer()
    test_comp_price_uses_nearest_other_dealer_cars()
    test_price_routed_picks_model_by_cheap_prediction()
    test_monthly_call_budget()
    test_month_end_topup()
    test_purge_cloudflare_cache()
    test_map_listing_keeps_first_https_photo()
    print("ok")
