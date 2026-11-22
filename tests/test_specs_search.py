"""The true-value rule in scripts/specs_search_backfill.py. Run: PYTHONPATH=. python3 tests/test_specs_search.py"""
from scripts.specs_search_backfill import accept

TWO = [{"url": "https://www.chevrolet.com/x", "quote": "5.3L V8 355 hp and 383 lb-ft"},
       {"url": "https://gmauthority.com/y", "quote": "rated at 355 horsepower, 383 lb-ft"}]


URLS = [s["url"] for s in TWO]
GOOD = [{**s, "tool_urls": [s["url"]]} for s in TWO]


def test_accept():
    assert accept({"ratings": [{"hp": 355, "torque_lbft": 383, "sources": TWO}]}, "makes 355 hp", URLS) == (355, 383, GOOD)
    assert accept({"ratings": [{"hp": 355, "sources": TWO[:1]}]}, "355 hp", URLS)[0] is None             # one site
    assert accept({"ratings": [{"hp": 355, "sources": TWO}]}, "no number", URLS)[0] is None              # not in citations
    assert accept({"ratings": [{"hp": 160, "sources": TWO}, {"hp": 163, "sources": TWO}]}, "160 163", URLS)[0] is None  # conflict
    assert accept({"ratings": [{"hp": 355, "torque_lbft": 999, "sources": TWO}]}, "355", URLS)[1] is None  # torque unquoted
    assert accept({"ratings": [{"hp": 35, "sources": TWO}]}, "355", URLS)[0] is None                    # no partial match
    assert accept({"ratings": [{"hp": 355, "sources": TWO}]}, "355", URLS[:1])[0] is None                # 2nd site never returned by tool
    assert accept({"ratings": [{"hp": 355, "sources": TWO}]}, "355", [])[0] is None                      # no tool urls at all
    junk = [{"url": "", "quote": "355 hp"}, {"url": "not a url", "quote": "355 hp"}]
    assert accept({"ratings": [{"hp": 355, "sources": junk}]}, "355", ["", "not a url"])[0] is None      # empty site is no site
    big = [{"url": "https://a.com/x", "quote": "3550 hp 5000 lb-ft"}, {"url": "https://b.com/x", "quote": "3550 hp 5000 lb-ft"}]
    assert accept({"ratings": [{"hp": 3550, "sources": big}]}, "3550", ["https://a.com/x", "https://b.com/x"])[0] is None  # hp range
    tq = [{**t, "quote": t["quote"] + " 5000 lb-ft"} for t in TWO]
    assert accept({"ratings": [{"hp": 355, "torque_lbft": 5000, "sources": tq}]}, "355", URLS)[1] is None  # torque range


if __name__ == "__main__":
    test_accept()
    print("ok")
