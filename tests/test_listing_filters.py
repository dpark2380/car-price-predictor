"""
tests/test_listing_filters.py — new listing fields, colour/fuel families, /api/deals filter validation, featured-sort stability.
Run: PYTHONPATH=. python3 tests/test_listing_filters.py
"""
import json

import api
import market
from scraper.data_ingest import map_listing

SAMPLE = "/Users/danielpark/car-intel/logs/marketcheck_sample.json"


def test_map_listing_new_fields():
    raw = {"vin": "1", "price": 9000, "miles": 5, "dom": 1, "fees": 122, "price_includes_fees": True, "base_ext_color": "Gray",
           "base_int_color": "Black", "interior_color": "Ebony", "is_certified": 1, "stock_no": "A1", "dos_active": 7,
           "dealer": {"website": "x.com", "msa_code": "7320"},
           "build": {"year": 2020, "make": "Nissan", "model": "Kicks", "overall_length": "169.1"}}
    m = map_listing(raw)
    assert (m["fees"], m["price_includes_fees"], m["base_ext_color"], m["is_certified"], m["stock_no"], m["dos_active"]) == (122.0, 1, "Gray", 1, "A1", 7)
    assert (m["dealer_website"], m["dealer_msa_code"], m["overall_length"], m["interior_color"]) == ("x.com", "7320", 169.1, "Ebony")
    m = map_listing({**raw, "fees": [{"a": 1}], "is_certified": None, "price_includes_fees": None})
    assert (m["fees"], m["is_certified"], m["price_includes_fees"]) == (None, 0, None)
    try:   # the real payload, when this machine has it
        for r in json.load(open(SAMPLE))["listings"]:
            assert map_listing(r) is not None
    except OSError:
        pass


def test_color_and_fuel_family():
    assert market.color_family("Gray", "WHITE") == "grey"            # the feed's family wins
    assert market.color_family(None, "STELLAR BLACK METALLIC") == "black"
    assert market.color_family(None, "Magnetic Charcoal") == "grey"
    assert market.color_family(float("nan"), None) == "other"
    assert market.color_family("Orange") == "other"
    assert market.fuel_family("Unleaded", "Combustion") == "gas"
    assert market.fuel_family("Electric", "BEV") == "electric"
    assert market.fuel_family("Electric / Unleaded", "PHEV") == "hybrid"
    assert market.fuel_family("Diesel", None) == "diesel" and market.fuel_family(None, None) is None


def test_filter_validation():
    c = api.app.test_client()
    for q in ("drivetrain=sideways", "fuel=steam", "color=pink", "sort=random", "min_price=abc", "has_photo=maybe", "seed=x"):
        assert c.get("/api/deals/count?" + q).status_code == 400, q
    assert c.get("/api/deals/count?drivetrain=AWD,4wd&fuel=gas&color=black&min_year=2018&max_miles=90000&has_photo=1").status_code == 200


def test_featured_is_stable_and_paged():
    rows = [{"listing_id": f"L{i}", "photo_url": "u" if i % 4 else None, "deal_score": 80 if i % 5 else 20, "deal_label": "x"} for i in range(60)]
    real, api._deal_records = api._deal_records, lambda version: rows
    try:
        c = api.app.test_client()
        ids = lambda q: [r["listing_id"] for r in c.get("/api/deals?sort=featured&" + q).get_json()]
        a, b = ids("seed=7"), ids("seed=7")
        assert a == b and a != ids("seed=8")
        assert all(int(i[1:]) % 4 and int(i[1:]) % 5 for i in a)     # photo and fair-or-better only
        assert ids("seed=7&limit=10") + ids("seed=7&limit=10&offset=10") == a[:20]
        assert c.get("/api/deals/count?sort=featured&seed=7").get_json() == {"count": len(a)}
    finally:
        api._deal_records = real


if __name__ == "__main__":
    for n, f in list(globals().items()):
        if n.startswith("test_"):
            f()
    print("ok")
