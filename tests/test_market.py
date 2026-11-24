"""
tests/test_market.py — per-VIN price history rule and the Market page aggregates.
Run: PYTHONPATH=. python3 tests/test_market.py
"""
from datetime import datetime, timedelta

import pandas as pd

import market
from db.models import init_db, get_session, VinPriceHistory
from db.price_history import credible_change, record_point
from scraper.data_ingest import _dt

T0 = datetime(2026, 11, 1)


def _points(session):
    return [(p.source, p.date, p.price, p.miles) for p in session.query(VinPriceHistory).order_by(VinPriceHistory.date, VinPriceHistory.id)]


def test_history_appends_only_on_change():
    s = get_session(init_db("sqlite://"))
    car = {"vin": "1HGCM82633A004352", "dealer_name": "D", "price": 20000.0, "mileage": 50000}
    record_point(s, car, T0)                                              # first sighting is the first point
    record_point(s, car, T0 + timedelta(days=1))                          # unchanged
    record_point(s, {**car, "price": 19000.0}, T0 + timedelta(days=2))    # cut
    record_point(s, {**car, "price": 19000.0, "mileage": 50100}, T0 + timedelta(days=3))   # miles only
    record_point(s, {**car, "price": 20000.0}, T0 + timedelta(days=4))    # back up, miles back too
    record_point(s, {"vin": "", "price": 5000.0}, T0)                     # no VIN: nothing
    assert [(p[2], p[3]) for p in _points(s)] == [(20000, 50000), (19000, 50000), (19000, 50100), (20000, 50000)]


def test_history_ref_point_sanity():
    s = get_session(init_db("sqlite://"))
    car = {"dealer_name": "D", "price": 20000.0, "mileage": 50000, "ref_price_dt": T0 - timedelta(days=9), "ref_miles": 49000}
    record_point(s, {**car, "vin": "A" * 17, "ref_price": 22000.0}, T0)     # earlier, 9% off: kept, first
    record_point(s, {**car, "vin": "A" * 17, "ref_price": 22000.0}, T0 + timedelta(days=1))   # same ref again: no duplicate
    record_point(s, {**car, "vin": "B" * 17, "ref_price": 999900.0}, T0)    # junk
    record_point(s, {**car, "vin": "C" * 17, "ref_price": 20000.0}, T0)     # same price: nothing new
    record_point(s, {**car, "vin": "D" * 17, "ref_price": 15000.0}, T0)     # earlier and cheaper (a rise of 33%): kept
    record_point(s, {**car, "vin": "E" * 17, "ref_price": 10000.0}, T0)     # a rise of 100%: junk
    record_point(s, {**car, "vin": "F" * 17, "ref_price": 22000.0, "ref_price_dt": T0 + timedelta(days=1)}, T0)   # not earlier
    by_vin = {v: [p.source for p in s.query(VinPriceHistory).filter_by(vin=v * 17).order_by(VinPriceHistory.date)] for v in "ABCDEF"}
    assert by_vin == {"A": ["ref", "scrape"], "B": ["scrape"], "C": ["scrape"], "D": ["ref", "scrape"], "E": ["scrape"], "F": ["scrape"]}
    assert credible_change(25782, 24127) == -6.4 and credible_change(100, 100.5) is None and credible_change(None, 5) is None


def test_feed_dates():
    assert _dt(1788412917) == datetime(2026, 9, 3, 5, 21, 57) and _dt("2025-10-30T14:38:32.000Z") == datetime(2025, 10, 30, 14, 38, 32)
    assert _dt(None) is None and _dt("") is None


def test_latest_row_per_vin_and_tiers():
    df = pd.DataFrame({"id": [1, 2, 3, 4], "listing_id": list("abcd"), "vin": ["V1", "V1", "", None],
                       "last_seen": pd.to_datetime(["2026-11-01", "2026-11-02", "2026-11-01", "2026-11-01"]), "price": [9, 8, 7, 6]})
    assert list(market.latest_per_vin(df)["price"]) == [8, 7, 6]   # newest V1 row; VIN-less rows stay separate
    assert [market.tier(x) for x in (None, float("nan"), 0, 14.9, 15, 34.9, 35, 64.9, 65, 89.9, 90, 100)] == \
        ["nr", "nr", "over", "over", "high", "high", "fair", "fair", "good", "good", "great", "great"]
    assert market.grade_mix(["great", "nr", "nr"]) == {"great": 1, "good": 0, "fair": 0, "high": 0, "over": 0, "nr": 2}


def test_histogram_and_bands():
    assert market.histogram([3000, 4999, 5000, 17000]) == [{"lo": 0, "n": 2}, {"lo": 5000, "n": 1}, {"lo": 10000, "n": 0}, {"lo": 15000, "n": 1}]
    assert market.histogram([]) == []
    got = market.band_counts([0, 30, 31, 90, 91, 365, 366, 900, None], market.DOM_BANDS)
    assert [b["n"] for b in got] == [2, 1, 1, 1, 1, 2] and got[-1]["band"] == "365+"


def test_merge_history_dedupes():
    own = [{"date": "2026-11-05", "price": 25782.0, "miles": 79591, "seller": "A", "source": "scrape"}]
    mc = [{"date": "2026-11-04", "price": 25782.0, "miles": 79591}, {"date": "2025-01-10", "price": 30000.0, "miles": 40000, "seller": "B"}]
    got = market.merge_history(own, mc)
    assert [(p["date"], p["source"]) for p in got] == [("2025-01-10", "marketcheck"), ("2026-11-05", "scrape")]
