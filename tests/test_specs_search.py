"""The true-value rule in scripts/specs_search_backfill.py. Run: PYTHONPATH=. python3 tests/test_specs_search.py"""
from scripts.specs_search_backfill import accept

TWO = [{"url": "https://www.chevrolet.com/x", "quote": "5.3L V8 355 hp and 383 lb-ft"},
       {"url": "https://gmauthority.com/y", "quote": "rated at 355 horsepower, 383 lb-ft"}]


def test_accept():
    assert accept({"ratings": [{"hp": 355, "torque_lbft": 383, "sources": TWO}]}, "makes 355 hp") == (355, 383, TWO)
    assert accept({"ratings": [{"hp": 355, "sources": TWO[:1]}]}, "355 hp")[0] is None                   # one site
    assert accept({"ratings": [{"hp": 355, "sources": TWO}]}, "no number")[0] is None                    # not in citations
    assert accept({"ratings": [{"hp": 160, "sources": TWO}, {"hp": 163, "sources": TWO}]}, "160 163")[0] is None  # conflict
    assert accept({"ratings": [{"hp": 355, "torque_lbft": 999, "sources": TWO}]}, "355")[1] is None     # torque unquoted
    assert accept({"ratings": [{"hp": 35, "sources": TWO}]}, "355")[0] is None                           # no partial match


if __name__ == "__main__":
    test_accept()
    print("ok")
