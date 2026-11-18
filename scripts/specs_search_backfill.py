"""
scripts/specs_search_backfill.py — Find true hp and torque by web search, for engines vPIC leaves blank.
Run by hand, not nightly: PYTHONPATH=. python3 scripts/specs_search_backfill.py --limit 1000
Needs the `ant` CLI logged in (`ant auth login`). Costs about $0.03 per config on Haiku,
mostly the $10 per 1,000 web searches (research/specs_search_research.md).

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
    "quote containing the numbers. End with one JSON object: "
    '{"ratings":[{"hp":int,"torque_lbft":int|null,"applies_to":"trims or all",'
    '"sources":[{"url":"...","quote":"..."}]}]}'
)
TOOL = {"type": "web_search_20250305", "name": "web_search", "max_uses": 3}


def ask(year, make, model, engine, fuel) -> dict:
    """One Claude call with web search -> {"answer": {...}, "cited": str, "usage": {...}}."""
    kind = {"gas": "gasoline", "diesel": "diesel", "hybrid": "hybrid"}[fuel]
    msg = {"role": "user", "content": f"{year} {make} {model} with the {engine:.1f} L {kind} engine: rated horsepower and torque."}
    r = subprocess.run(
        ["ant", "--format", "json", "messages", "create", "--model", MODEL, "--max-tokens", "4000",
         "--system", json.dumps(SYSTEM), "--tool", json.dumps(TOOL), "--message", json.dumps(msg)],
        capture_output=True, text=True, timeout=300, check=True)
    resp = json.loads(r.stdout)
    texts = [b for b in resp.get("content", []) if b.get("type") == "text"]
    full = "".join(b["text"] for b in texts)
    cited = " ".join(c.get("cited_text", "") for b in texts for c in (b.get("citations") or []))
    try:
        answer = json.JSONDecoder().raw_decode(full[full.rindex('{"ratings"'):])[0]
    except ValueError:  # no JSON: store nothing usable
        answer = {"ratings": [], "unparsed": full[-500:]}
    return {"answer": answer, "cited": cited, "usage": resp.get("usage")}


def site(url: str) -> str:
    host = urlparse(url).netloc.lower()
    return ".".join(host.split(".")[-2:])


def accept(answer: dict, cited: str) -> tuple[int | None, int | None, list]:
    """(hp, torque, sources) when one rating is backed by two sites, else (None, None, [])."""
    ratings = answer.get("ratings") or []
    if len({(r.get("hp"), r.get("torque_lbft")) for r in ratings}) != 1:
        return None, None, []  # none found, or several tunes/conflicting sources
    r = ratings[0]
    hp, tq = r.get("hp"), r.get("torque_lbft")
    if not isinstance(hp, int):
        return None, None, []
    has = lambda n, q: n is not None and re.search(rf"(?<!\d){n:,}(?!\d)|(?<!\d){n}(?!\d)", q or "")
    srcs = [s for s in r.get("sources") or [] if has(hp, s.get("quote"))]
    if len({site(s.get("url", "")) for s in srcs}) < 2 or not has(hp, cited):
        return None, None, []
    torque = tq if isinstance(tq, int) and all(has(tq, s.get("quote")) for s in srcs) else None
    return hp, torque, srcs


def todo(session) -> list[tuple]:
    """Configs (year, make, model, engine, fuel) lacking vPIC hp, most listings first."""
    hp = {s for s, d in session.query(VinSpecs.squish, VinSpecs.data) if json.loads(d or "{}").get("EngineHP")}
    done = {(e.year, e.make, e.model, e.engine_size, e.fuel) for e in session.query(EngineSpecs)}
    counts = Counter()
    for vin, year, make, model, engine, fuel_type, powertrain in (session.query(CarListing.vin, CarListing.year, CarListing.make,
                                                         CarListing.model, CarListing.engine_size,
                                                         CarListing.fuel_type, CarListing.powertrain_type)
                                           .filter(CarListing.is_active == 1, CarListing.engine_size > 0)):
        fuel = fuel_class(fuel_type, powertrain)
        if year and make and model and fuel and vin and len(vin) == 17 and squish(vin) not in hp:
            counts[(year, make.lower().strip(), model.lower().strip(), round(engine, 1), fuel)] += 1
    return [k for k, _ in counts.most_common() if k not in done]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20, help="configs to search this run")
    args = ap.parse_args()
    session = get_session(init_db())
    configs = todo(session)[:args.limit]
    kept = searches = 0
    for i, (year, make, model, engine, fuel) in enumerate(configs, 1):
        try:
            res = ask(year, make, model, engine, fuel)
        except (subprocess.SubprocessError, ValueError) as e:
            print(f"{i}/{len(configs)} {year} {make} {model} {engine} {fuel}: failed ({e}), retried next run")
            continue
        hp, torque, srcs = accept(res["answer"], res["cited"])
        searches += ((res["usage"] or {}).get("server_tool_use") or {}).get("web_search_requests", 0)
        kept += hp is not None
        session.add(EngineSpecs(year=year, make=make, model=model, engine_size=engine, fuel=fuel, hp=hp, torque=torque,
                                sources=json.dumps(srcs), raw=json.dumps({"answer": res["answer"], "cited": res["cited"]})))
        session.commit()
        print(f"{i}/{len(configs)} {year} {make} {model} {engine} {fuel}: {hp or '-'} hp, {torque or '-'} lb-ft", flush=True)
    print(f"Done: {kept} of {len(configs)} configs kept, {searches} searches")


if __name__ == "__main__":
    main()
