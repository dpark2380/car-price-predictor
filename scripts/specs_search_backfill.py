"""
scripts/specs_search_backfill.py — Find true hp and torque by web search, for engines vPIC leaves blank.
Run by hand, not nightly: PYTHONPATH=. python3 scripts/specs_search_backfill.py --limit 1000 [--budget USD]
[--model M] [--redo kept|missed] (re-search rows without the "v": 2 mark; stored hp/torque are never nulled).
Needs the `ant` CLI logged in (`ant auth login`). Costs about $0.03 per config on Haiku,
mostly the $10 per 1,000 web searches (research/specs_search_research.md). Also finds 0-60 mph,
kept when two sites quote it within 0.5 s (the slower one), independent of hp.

Takes active listings with an engine size but no vPIC hp, groups them by
year/make/model/engine, and searches the most common configs first. Every answer
is stored in engine_specs, so a rerun skips configs already searched. hp and
torque are kept only when exactly one rating is found and two different sites
quote it; anything else stays NULL, so the site shows nothing rather than a guess.
"""
import argparse
import json
import re
import subprocess
from collections import Counter
from urllib.parse import urlparse

from db.models import CarListing, EngineSpecs, VinSpecs, init_db, get_session
from scraper.vehicle_specs import fuel_class, squish

MODEL = "claude-haiku-5-5"
SYSTEM = (
    "You find manufacturer-rated US specs. Search the web, preferring the manufacturer's own sites and well-known "
    "motoring press. Only report a number you read on a page for that exact model year, model and engine. If that "
    "engine had more than one rating that year (different tunes or trims), report every rating with the trims it "
    "applies to. Never estimate. For each rating give up to two sources from different websites, each with a verbatim "
    "quote containing the numbers. "
    "Also report the 0-60 mph time in seconds, again up to two sources from different websites with a verbatim quote "
    'containing the number. End with one JSON object: '
    '{"ratings":[{"hp":int,"torque_lbft":int|null,"applies_to":"trims or all",'
    '"sources":[{"url":"...","quote":"..."}]}],'
    '"zero_to_sixty":[{"sec":float,"url":"...","quote":"..."}]}'
)
TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 4}
# $ per 1M tokens (input, output) from the claude-api skill, 2026-11; Haiku prices are for prompts up to 100K tokens.
# Cache reads cost 0.1x input, cache writes 1.25x (5 min). Web search: $10 per 1,000 (skill, managed-agents-core.md).
PRICES = {"claude-haiku-5-5": (0.10, 0.50), "claude-sonnet-5-5": (2.00, 10.00)}
WEB_SEARCH_PER_1K = 10.00


def ask(year, make, model, engine, fuel, llm=MODEL) -> dict:
    """One Claude call with web search -> {"answer": {...}, "cited": str, "urls": [...], "usage": {...}}."""
    kind = {"gas": "gasoline", "diesel": "diesel", "hybrid": "hybrid"}[fuel]
    msg = {"role": "user", "content": f"{year} {make} {model} with the {engine:.1f} L {kind} engine: rated horsepower, torque and 0-60 mph time."}
    r = subprocess.run(
        ["ant", "--format", "json", "messages", "create", "--model", llm, "--max-tokens", "4000",
         "--system", json.dumps(SYSTEM), "--tool", json.dumps(TOOL), "--message", json.dumps(msg)],
        capture_output=True, text=True, timeout=300, check=True)
    resp = json.loads(r.stdout)
    texts = [b for b in resp.get("content", []) if b.get("type") == "text"]
    full = "".join(b["text"] for b in texts)
    cited = " ".join(c.get("cited_text", "") for b in texts for c in (b.get("citations") or []))
    # URLs the search tool really returned (result blocks and citations), not ones the model typed
    urls = sorted({r["url"] for b in resp.get("content", []) if b.get("type") == "web_search_tool_result"
                   for r in (b.get("content") or []) if isinstance(r, dict) and r.get("url")}
                  | {c["url"] for b in texts for c in (b.get("citations") or []) if c.get("url")})
    try:
        answer = json.JSONDecoder().raw_decode(full[full.rindex('{"ratings"'):])[0]
    except ValueError:  # no JSON: store nothing usable
        answer = {"ratings": [], "unparsed": full[-500:]}
    return {"answer": answer, "cited": cited, "urls": urls, "usage": resp.get("usage")}


def site(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower() if isinstance(url, str) else ""
    except ValueError:
        return ""
    return ".".join(host.split(".")[-2:])


def accept(answer: dict, cited: str, urls: list = ()) -> tuple[int | None, int | None, list]:
    """(hp, torque, sources) when one rating is backed by two sites the search tool
    really returned, else (None, None, []). Each source gets the tool's real urls for its site."""
    ratings = answer.get("ratings") or []
    if len({(r.get("hp"), r.get("torque_lbft")) for r in ratings}) != 1:
        return None, None, []  # none found, or several tunes/conflicting sources
    r = ratings[0]
    hp, tq = r.get("hp"), r.get("torque_lbft")
    if not isinstance(hp, int) or isinstance(hp, bool) or not 40 <= hp <= 2000:
        return None, None, []
    has = lambda n, q: n is not None and re.search(rf"(?<!\d){n:,}(?!\d)|(?<!\d){n}(?!\d)", q or "")
    real = {site(u) for u in urls} - {""}
    srcs = [{**s, "tool_urls": [u for u in urls if site(u) == site(s.get("url", ""))]}
            for s in r.get("sources") or []
            if has(hp, s.get("quote")) and site(s.get("url", "")) in real]  # named source must be one the tool returned
    if len({site(s["url"]) for s in srcs}) < 2 or not has(hp, cited):
        return None, None, []
    torque = tq if isinstance(tq, int) and not isinstance(tq, bool) and 40 <= tq <= 2500 \
        and all(has(tq, s.get("quote")) for s in srcs) else None
    return hp, torque, srcs


def cost(usage: dict | None, llm: str = MODEL) -> float:
    """Estimated dollars for one response's usage."""
    i, o = PRICES[llm]
    u, n = usage or {}, lambda k: (usage or {}).get(k) or 0
    tok = n("input_tokens") * i + n("output_tokens") * o + n("cache_read_input_tokens") * i * 0.1 + n("cache_creation_input_tokens") * i * 1.25
    return tok / 1e6 + ((u.get("server_tool_use") or {}).get("web_search_requests") or 0) * WEB_SEARCH_PER_1K / 1000


def accept_zero(answer: dict, urls: list = ()) -> float | None:
    """0-60 s when two sites the tool returned each quote their number, within 0.5 s, 1.5..25.0; the slower one."""
    real = {site(u) for u in urls} - {""}
    by = {}
    for s in answer.get("zero_to_sixty") or []:
        v, q = s.get("sec"), s.get("quote")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and 1.5 <= v <= 25.0 and isinstance(q, str) \
                and re.search(rf"(?<![\d.]){re.escape(f'{v:g}')}(?:\.0)?(?!\d|\.\d)", q) and site(s.get("url", "")) in real:
            by.setdefault(site(s["url"]), v)
    if len(by) < 2 or round(max(by.values()) - min(by.values()), 1) > 0.5:
        return None
    return round(max(by.values()), 1)


def listed(session) -> Counter:
    """Listing count per config (year, make, model, engine, fuel) lacking vPIC hp."""
    hp = {s for s, d in session.query(VinSpecs.squish, VinSpecs.data) if json.loads(d or "{}").get("EngineHP")}
    counts = Counter()
    for vin, year, make, model, engine, fuel_type, powertrain in (session.query(CarListing.vin, CarListing.year, CarListing.make,
                                                         CarListing.model, CarListing.engine_size,
                                                         CarListing.fuel_type, CarListing.powertrain_type)
                                           .filter(CarListing.is_active == 1, CarListing.engine_size > 0)):
        fuel = fuel_class(fuel_type, powertrain)
        if year and make and model and fuel and vin and len(vin) == 17 and squish(vin) not in hp:
            counts[(year, make.lower().strip(), model.lower().strip(), round(engine, 1), fuel)] += 1
    return counts


def todo(session) -> list[tuple]:
    """Configs not searched yet, most listings first."""
    done = {(e.year, e.make, e.model, e.engine_size, e.fuel) for e in session.query(EngineSpecs)}
    return [k for k, _ in listed(session).most_common() if k not in done]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20, help="configs to search this run")
    ap.add_argument("--model", default=MODEL)
    ap.add_argument("--redo", choices=["kept", "missed"], help="re-search rows with hp / without hp instead of new configs")
    ap.add_argument("--budget", type=float, help="stop before the next call once estimated spend reaches this many USD")
    args = ap.parse_args()
    if args.model not in PRICES:
        raise SystemExit(f"no price for {args.model}: add it to PRICES")
    session = get_session(init_db())
    rows = {}
    if args.redo:
        n = listed(session)
        for e in session.query(EngineSpecs).filter(EngineSpecs.hp.isnot(None) if args.redo == "kept" else EngineSpecs.hp.is_(None)):
            if json.loads(e.raw or "{}").get("v") != 2:
                rows[(e.year, e.make, e.model, e.engine_size, e.fuel)] = e
        configs = sorted(rows, key=lambda k: -n[k])[:args.limit]  # most-listed first; ties keep insertion (id) order
    else:
        configs = todo(session)[:args.limit]
    kept = searches = fails = 0
    spent = 0.0
    same, changed, lost = 0, [], 0
    for i, (year, make, model, engine, fuel) in enumerate(configs, 1):
        if args.budget is not None and spent >= args.budget:
            print(f"Budget ${args.budget:.2f} reached, stopping before config {i}")
            break
        if fails >= 5:
            print("5 failed calls in a row (credits or CLI?), stopping")
            break
        try:
            res = ask(year, make, model, engine, fuel, args.model)
        except (subprocess.SubprocessError, ValueError) as e:
            fails += 1
            print(f"{i}/{len(configs)} {year} {make} {model} {engine} {fuel}: failed ({e}), retried next run")
            continue
        fails = 0
        hp, torque, srcs = accept(res["answer"], res["cited"], res["urls"])
        zero = accept_zero(res["answer"], res["urls"])
        c = cost(res["usage"], args.model)
        spent += c
        searches += ((res["usage"] or {}).get("server_tool_use") or {}).get("web_search_requests", 0)
        kept += hp is not None
        got = {"answer": res["answer"], "cited": res["cited"], "urls": res["urls"]}
        row = rows.get((year, make, model, engine, fuel))
        if row is None:
            session.add(EngineSpecs(year=year, make=make, model=model, engine_size=engine, fuel=fuel, hp=hp, torque=torque,
                                    zero_to_sixty=zero, sources=json.dumps(srcs), raw=json.dumps({"v": 2, **got})))
        else:
            old = (row.hp, row.torque)
            if hp is not None:
                if torque is None and hp == old[0]:
                    torque = old[1]  # same hp, torque not re-quoted: keep the stored torque
                same, changed = same + ((hp, torque) == old), changed + ([f"{year} {make} {model} {engine} {fuel}: {old} -> {(hp, torque)}"] if (hp, torque) != old else [])
                row.hp, row.torque, row.sources = hp, torque, json.dumps(srcs)
            else:
                lost += 1  # not reconfirmed: stored hp/torque/sources stay
            if zero is not None:
                row.zero_to_sixty = zero
            row.raw = json.dumps({**json.loads(row.raw or "{}"), "v": 2, "v2": got})
        session.commit()
        print(f"{i}/{len(configs)} {year} {make} {model} {engine} {fuel}: {hp or '-'} hp, {torque or '-'} lb-ft, "
              f"0-60 {zero or '-'} s, ${c:.4f} (run ${spent:.4f})", flush=True)
    print(f"Done: {kept} of {len(configs)} configs accepted, {searches} searches, est. ${spent:.4f}")
    if args.redo:
        print(f"confirmed-same {same}, changed {len(changed)}, not-reconfirmed {lost}")
        for line in changed:
            print("  changed", line)


if __name__ == "__main__":
    main()
