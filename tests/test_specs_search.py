"""The true-value rule in scripts/specs_search_backfill.py. Run: PYTHONPATH=. python3 tests/test_specs_search.py"""
from scripts.specs_search_backfill import accept, accept_zero, cost

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


Z = lambda a, b, qa="0-60 mph in 5.9 seconds", qb="hits 60 in 6.2 s": {"zero_to_sixty": [
    {"sec": a, "url": URLS[0], "quote": qa}, {"sec": b, "url": URLS[1], "quote": qb}]}


def test_zero():
    assert accept_zero(Z(5.9, 6.2), URLS) == 6.2                                        # slower of two
    assert accept_zero({"zero_to_sixty": Z(5.9, 6.2)["zero_to_sixty"][:1]}, URLS) is None  # one site
    assert accept_zero(Z(5.9, 6.5, qb="6.5 s"), URLS) is None                                       # 0.6 s apart
    assert accept_zero(Z(5.9, 6.4, qb="6.4 s"), URLS) == 6.4                                        # exactly 0.5 apart is fine
    assert accept_zero(Z(1.2, 1.3, "1.2 s", "1.3 s"), URLS) is None                     # < 1.5
    assert accept_zero(Z(25.5, 25.6, "25.5 s", "25.6 s"), URLS) is None                 # > 25
    assert accept_zero(Z(5.9, 6.2, "0-60 in 15.9 s"), URLS) is None                     # number not in quote
    assert accept_zero(Z(5.9, 6.2), URLS[:1]) is None                                   # 2nd site not tool-returned
    both = {"ratings": [{"hp": 355, "torque_lbft": 383, "sources": TWO}], **Z(5.9, 9.0, qb="9 s")}
    assert accept(both, "355", URLS)[0] == 355 and accept_zero(both, URLS) is None      # hp ok, 0-60 rejected
    nohp = {"ratings": [], **Z(5.9, 6.2)}
    assert accept(nohp, "355", URLS)[0] is None and accept_zero(nohp, URLS) == 6.2      # 0-60 ok, hp none


def test_cost():
    u = {"input_tokens": 20000, "output_tokens": 1000, "cache_read_input_tokens": 10000,
         "cache_creation_input_tokens": 4000, "server_tool_use": {"web_search_requests": 3}}
    # haiku: (0.1*20000 + 0.5*1000 + 0.01*10000 + 0.125*4000)/1e6 + 3 searches * $0.01
    assert abs(cost(u, "claude-haiku-5-5") - 0.0331) < 1e-9
    assert abs(cost(u, "claude-sonnet-5-5") - (0.04 + 0.01 + 0.002 + 0.01 + 0.03)) < 1e-9
    assert cost(None) == 0


if __name__ == "__main__":
    test_accept()
    test_zero()
    test_cost()
    print("ok")


def test_decode_extract():
    from scripts.specs_decode_backfill import extract
    e = lambda attr, v: {"category": "Engine", "attribute": attr, "value": v}
    std = [e("Maximum power hp/PS", "600/608"), e("maximum torque lb ft", "553"), e("acceleration 0-60 mph", "3.2"),
           {"category": "Body", "attribute": "Maximum power hp/PS", "value": "1"}]
    opt = [e("Maximum power hp/PS", "617"), e("acceleration 0-60 mph", "fast"), e("maximum torque lb ft", "99999")]
    assert extract({"installed_equipment": {"STANDARD": std, "ZCP": opt}}) == (
        {"hp": 617, "torque": 553, "zero_to_sixty": 3.2}, {"hp": "ZCP", "torque": "STANDARD", "zero_to_sixty": "STANDARD"})
    assert extract({"installed_equipment": {"ZCP": opt, "STANDARD": std}})[0]["hp"] == 617   # key order irrelevant
    assert extract({"installed_equipment": None}) == ({}, {}) and extract({}) == ({}, {}) and extract(None) == ({}, {})
    assert extract({"installed_equipment": {"STANDARD": "junk"}}) == ({}, {})
