"""
api.py — Flask REST API for Car Intel dashboard
Run: PYTHONPATH=. python3 api.py
"""

import functools
import json
import math
import os
import random
import re
import threading
from datetime import datetime, timezone

import pandas as pd
from flask import Flask, abort, jsonify, request
from flask_cors import CORS
from loguru import logger
from werkzeug.exceptions import HTTPException

import market
from db.models import CarListing, Prediction, VinHistory, VinOptions, VinPriceHistory, init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository
from scraper import vehicle_specs
from scraper.api_usage import month_total
from scraper.data_ingest import CALL_CAP, extract, mc_get

app = Flask(__name__)
# Browsers may call the API only from the public dashboard, the Mac mini's LAN
# dashboard and local dev. Not access control (curl ignores CORS): it stops
# other websites from using this API from their visitors' browsers.
CORS(app, origins=[
    "https://cars.danielpark.fyi",
    r"http://[\w-]+\.local:3000",
    r"http://(localhost|127\.0\.0\.1):\d+",
])


@app.errorhandler(HTTPException)
def _http_error(e):
    return jsonify({"error": e.description}), e.code


@app.errorhandler(Exception)
def _server_error(e):
    # Log the detail; never send it (paths, SQL, library internals) to clients.
    logger.exception(f"Unhandled error on {request.path}")
    return jsonify({"error": "Internal error"}), 500


@app.after_request
def _nosniff(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


def _db_version() -> float:
    """Changes whenever the pipeline writes the database or the dealer-site check."""
    from scraper.dealer_sites import DEALER_SITES_PATH
    try:
        db = os.path.getmtime("car_intel.db")
    except OSError:
        db = 0.0
    try:
        return max(db, os.path.getmtime(DEALER_SITES_PATH))
    except OSError:
        return db


def db_cached(*params, maxsize=8):
    """
    Serve a GET endpoint's response from memory until the pipeline next writes
    the database. Only the named query params form the key, so junk params
    (Cloudflare cache-busting) can't force recomputation, and maxsize bounds
    memory however many distinct values arrive. URL parts (<make>) join the key.
    """
    def deco(view):
        @functools.lru_cache(maxsize=maxsize)
        def compute(version, key):
            r = view(**dict(key[0]))
            r = r if isinstance(r, app.response_class) else app.make_response(r)
            return r.get_data(), r.status_code, r.mimetype

        @functools.wraps(view)
        def wrapper(**url_parts):
            key = (tuple(url_parts.items()), tuple(request.args.get(p, "") for p in params))
            body, status, mimetype = compute(_db_version(), key)
            return app.response_class(body, status=status, mimetype=mimetype)
        return wrapper
    return deco


def _arg_int(name, default, lo, hi):
    """Integer query param clamped to [lo, hi]; non-numeric -> 400."""
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError:
        abort(400, f"{name} must be a whole number")


@app.after_request
def _public_cors(resp):
    """Cloudflare caches public API responses for every visitor and ignores
    Vary: Origin, so one cached from a request without an Origin (a bot, curl)
    would lack the header the dashboard needs. Requests through the public
    hostname always get the dashboard's origin."""
    if request.host == "cars-api.danielpark.fyi":
        resp.headers["Access-Control-Allow-Origin"] = "https://cars.danielpark.fyi"
    return resp


# Once per process: init_db also syncs the SQL views (DROP/CREATE), and running
# that per request let the dashboard's concurrent /deals + /stats calls race
# ("view already exists" -> 500) on a DB that didn't have the views yet.
engine = init_db()


def get_db():
    return get_session(engine)


def ss(v):
    """Safe string — converts NaN to None."""
    if v is None:
        return None
    try:
        if isinstance(v, float) and math.isnan(v):
            return None
        return str(v)
    except Exception:
        return None


def sf(v):
    """Safe float — converts NaN/Inf to None."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except Exception:
        return None


def si(v):
    """Safe int — converts NaN to None."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if math.isnan(f) else int(f)
    except Exception:
        return None


# The public site shows live-looking ads only; stale ones stay in the DB for
# training. Each zip comes round about every 15 days, so a live ad can go
# that long unseen; ads on sale for months at a "deal" price were mostly
# dead links, sold cars or problem cars.
MAX_DAYS_SINCE_SEEN = 21
MAX_DAYS_LISTED = 180


def _reduced(was, now):
    """{was, amount, pct} when the dealer's earlier price is believable: the feed has junk
    like a $999,900 ref_price on a $9,999 car, so only drops of 1-40% count."""
    was, now = sf(was), sf(now)
    if not was or not now or was <= now:
        return None
    pct = (was - now) / was * 100
    return {"was": was, "amount": round(was - now), "pct": round(pct, 1)} if 1 <= pct <= 40 else None


def _extras(c):
    """Listing columns filled from scrapes after 2026-11-24 (NULL on older rows); c is a row or a CarListing."""
    g = (lambda k: getattr(c, k)) if isinstance(c, CarListing) else c.get
    return {"fees": sf(g("fees")), "price_includes_fees": si(g("price_includes_fees")),
            "base_int_color": ss(g("base_int_color")), "interior_color": ss(g("interior_color")),
            "is_certified": si(g("is_certified")), "stock_no": ss(g("stock_no")),
            "dos_active": si(g("dos_active") if si(g("dos_active")) is not None else g("dom_active")),   # days at this dealer's site, whichever source has it
            "dealer_website": ss(g("dealer_website")), "dealer_msa_code": ss(g("dealer_msa_code")),
            "overall_length": sf(g("overall_length"))}


@functools.lru_cache(maxsize=1)
def _deal_records(version):
    """Every graded, non-stale listing as API rows, best deal first. version: _db_version()."""
    session = get_db()
    try:
        df = PredictionRepository(session).get_top_deals(limit=None, include_unrated=True)
        if df is None or df.empty:
            return []
        market_stats = ListingRepository(session).get_market_stats()

        df["price"] = pd.to_numeric(df.get("price"), errors="coerce")
        df["predicted_price"] = pd.to_numeric(df.get("predicted_price"), errors="coerce")
        df["deal_score"] = pd.to_numeric(df.get("deal_score"), errors="coerce")
        if "body_type" not in df.columns:
            df["body_type"] = None
        df["predicted_price"] = df["predicted_price"].where(df["deal_score"].notna())  # not rated: no market value
        # Rough national ratings: the model's estimate is why those cars weren't rated, so "market value" is the US median.
        nat = df["rating_basis"].eq("national")
        df.loc[nat, "predicted_price"] = [market_stats.get((r.make, r.model, int(r.year)), {}).get("median") for r in df[nat].itertuples()]
        df["savings"] = (df["predicted_price"] - df["price"]).round(0)
        seen = pd.to_datetime(df["last_seen"], errors="coerce")
        fresh = (seen >= pd.Timestamp.utcnow().tz_localize(None) - pd.Timedelta(days=MAX_DAYS_SINCE_SEEN)) \
            & (pd.to_numeric(df["days_listed"], errors="coerce").fillna(0) <= MAX_DAYS_LISTED)
        # Ads whose dealer website is down can't be followed up: hide them too.
        from scraper.dealer_sites import host_of, load_down
        down = load_down()
        reachable = ~df["url"].map(host_of).isin(down) if down else True
        df = df[fresh & reachable].sort_values("deal_score", ascending=False)

        # US-wide figures for cars rated or shown from them (one query; cached with the rest by _db_version)
        return [{
            "listing_id":      row.get("listing_id"),
            "url":             row.get("url"),
            "vin":             ss(row.get("vin")),
            "photo_url":       ss(row.get("photo_url")),
            "year":            si(row.get("year")),
            "make":            market.show_make(row.get("make")),
            "model":           row.get("model"),
            "trim":            ss(row.get("trim")),
            "body_type":       ss(row.get("body_type")),
            "price":           sf(row.get("price")),
            "predicted_price": sf(row.get("predicted_price")),
            "savings":         sf(row.get("savings")),
            "deal_score":      sf(row.get("deal_score")),
            "deal_label":      row.get("deal_label"),
            "comparables":     si(row.get("comparables")),
            "market":          None if pd.notna(row.get("deal_score")) and row.get("rating_basis") != "national" else market_stats.get((row.get("make"), row.get("model"), si(row.get("year")))),
            "rating_basis":    ss(row.get("rating_basis")),
            "typical_error_pct":   sf(row.get("typical_error_pct")),
            "cohort_median_price": sf(row.get("cohort_median_price")),
            "mileage":         si(row.get("mileage")),
            "location_state":  row.get("location_state"),
            "location_city":   row.get("location_city"),
            "condition":       row.get("condition"),
            "days_listed":     si(row.get("days_listed")) or 0,
            "dealer_name":     market.show_dealer(ss(row.get("dealer_name"))),
            "dealer_phone":    ss(row.get("dealer_phone")),
            "dealer_street":   ss(row.get("dealer_street")),
            "dealer_type":     ss(row.get("dealer_type")),
            "drivetrain":      ss(row.get("drivetrain")),
            "fuel_type":       ss(row.get("fuel_type")),
            "fuel":            market.fuel_family(ss(row.get("fuel_type")), ss(row.get("powertrain_type"))),
            "exterior_color":  ss(row.get("exterior_color")),
            "base_ext_color":  ss(row.get("base_ext_color")),
            "color_family":    market.color_family(ss(row.get("base_ext_color")), ss(row.get("exterior_color"))) if ss(row.get("base_ext_color")) or ss(row.get("exterior_color")) else None,
            "city_mpg":        si(row.get("city_mpg")),
            "highway_mpg":     si(row.get("highway_mpg")),
            **_extras(row),
            # Last price cut (negative %) and the price before it; display only.
            "price_change_percent": sf(row.get("price_change_percent")),
            "ref_price":       sf(row.get("ref_price")),
            "reduced":         _reduced(row.get("ref_price"), row.get("price")),
            # Date our scraper last saw the ad live; older means it may have sold.
            "last_seen":       str(row.get("last_seen"))[:10] if row.get("last_seen") is not None else None,
            # When our scraper first found the ad (UTC), for the "Date found" sort.
            "first_seen":      pd.to_datetime(row.get("first_seen")).strftime("%Y-%m-%dT%H:%M:%SZ") if pd.notna(row.get("first_seen")) else None,
        } for _, row in df.iterrows()]
    finally:
        session.close()


_DEAL_PARAMS = ("limit", "offset", "min_score", "make", "model", "body", "drivetrain", "fuel", "color", "min_price", "max_price",
                "min_miles", "max_miles", "min_year", "max_year", "has_photo", "reduced", "sort", "seed")
_CHOICES = {"drivetrain": {"awd", "4wd", "fwd", "rwd"}, "fuel": {"gas", "hybrid", "electric", "diesel"},
            "color": {"black", "white", "silver", "grey", "blue", "red", "green", "brown", "other"}}


def _arg_choices(name):
    """Comma-separated values from a whitelist, lower-cased; anything else -> 400. None when absent."""
    raw = request.args.get(name, "").strip().lower()
    vals = {v.strip() for v in raw.split(",") if v.strip()}
    if vals - _CHOICES[name]:
        abort(400, f"{name} must be one or more of {', '.join(sorted(_CHOICES[name]))}")
    return vals or None


def _arg_flag(name):
    raw = request.args.get(name, "").strip().lower()
    if raw not in ("", "0", "1", "true", "false"):
        abort(400, f"{name} must be 1 or 0")
    return raw in ("1", "true")


def _filtered_deals():
    """Rows for /api/deals and /api/deals/count after every filter and the sort, before offset and limit.
    A filter on a field hides the cars that lack it."""
    min_score = request.args.get("min_score", 0.0, type=float)
    make      = request.args.get("make", "").strip().lower()[:60]
    model_q   = request.args.get("model", "").strip().lower()[:60]
    body_q    = request.args.get("body", "").strip().lower()[:60]
    lim = {n: _arg_int(n, None, 0, 10_000_000) for n in ("min_price", "max_price", "min_miles", "max_miles", "min_year", "max_year")}
    choice = {n: _arg_choices(n) for n in _CHOICES}
    sort = request.args.get("sort", "").strip().lower()
    if sort not in ("", "score", "featured", "mpg"):
        abort(400, "sort must be score, featured or mpg")
    seed = _arg_int("seed", 0, 0, 2**31 - 1)

    rows = _deal_records(_db_version())
    if min_score > 0:
        rows = [r for r in rows if (r["deal_score"] or 0) >= min_score]
    if make:
        rows = [r for r in rows if make == str(r["make"] or "").lower()]
    if model_q:
        rows = [r for r in rows if model_q == str(r["model"] or "").lower()]
    if body_q in {"unknown", "null", "(null)", "none"}:
        rows = [r for r in rows if not (r["body_type"] or "").strip() or r["body_type"].lower() == "nan"]
    elif body_q:
        rows = [r for r in rows if body_q in (r["body_type"] or "").lower()]
    if choice["drivetrain"]:
        rows = [r for r in rows if (r["drivetrain"] or "").lower() in choice["drivetrain"]]
    if choice["fuel"]:
        rows = [r for r in rows if r["fuel"] in choice["fuel"]]
    if choice["color"]:
        rows = [r for r in rows if r["color_family"] in choice["color"]]
    for col, key in (("price", "price"), ("mileage", "miles"), ("year", "year")):
        if lim["min_" + key] is not None:
            rows = [r for r in rows if r[col] is not None and r[col] >= lim["min_" + key]]
        if lim["max_" + key] is not None:
            rows = [r for r in rows if r[col] is not None and r[col] <= lim["max_" + key]]
    if _arg_flag("has_photo"):
        rows = [r for r in rows if r["photo_url"]]
    if _arg_flag("reduced"):
        rows = [r for r in rows if r["reduced"]]
    if sort == "featured":
        # Same seed, same order: shuffle in listing_id order so paging never repeats or skips a car.
        # Cars with a photo come first; no car is hidden.
        rows = sorted(rows, key=lambda r: r["listing_id"])
        random.Random(seed).shuffle(rows)
        rows.sort(key=lambda r: not r["photo_url"])
    elif sort == "mpg":   # city/highway average, cars without MPG last
        def mpg(r):
            v = [m for m in (r["city_mpg"], r["highway_mpg"]) if m]
            return -sum(v) / len(v) if v else float("inf")
        rows = sorted(rows, key=mpg)
    return rows


@app.route("/api/deals")
@db_cached(*_DEAL_PARAMS, maxsize=64)
def deals():
    """
    Returns "deal finder" rows, best first.

    deal_score is 0-100 where 100 is best deal.
    Query params (all optional; a bad value is a 400; a filter hides cars that lack the field):
      - limit, offset: page of the result (default: all)
      - min_score: minimum deal_score; make/model: exact match, any case
      - body: body type filter (e.g. SUV, Sedan, Truck). Use "unknown" for NULLs.
      - drivetrain (awd,4wd,fwd,rwd), fuel (gas,hybrid,electric,diesel), color (black,white,silver,grey,blue,red,green,brown,other):
        comma-separated lists mean "any of"
      - min_price, max_price, min_miles, max_miles, min_year, max_year; has_photo=1; reduced=1 (a believable price cut)
      - sort: score (default), featured (seeded shuffle, cars with a photo first), mpg
      - seed: whole number for sort=featured
    """
    limit  = _arg_int("limit", None, 1, 50_000)
    offset = _arg_int("offset", 0, 0, 10_000_000)
    rows = _filtered_deals()[offset:]
    return jsonify(rows[:limit] if limit else rows)


@app.route("/api/deals/count")
@db_cached(*_DEAL_PARAMS, maxsize=64)
def deals_count():
    """How many cars /api/deals returns for the same filters (limit and offset ignored): {"count": N}."""
    return jsonify({"count": len(_filtered_deals())})


@app.route("/api/specs")
@db_cached("id", maxsize=256)
def specs():
    """Spec sheet for one listing, carsales-style: [{group, rows: [[label, value]]}].
    Empty until the pipeline has fetched that car's NHTSA data. Query param: id."""
    session = get_db()
    try:
        sheet = vehicle_specs.sheet_for(session, request.args.get("id", "")[:200])
    finally:
        session.close()
    if sheet is None:
        abort(404, "no such listing")
    return jsonify(sheet)


# On-demand MarketCheck lookups (history, options) for the listing page. They spend the
# monthly quota, so: only VINs of active listings, results kept for good, and one shared
# daily cap, counted in the tables themselves (a failed or in-flight attempt keeps its slot).
ON_DEMAND_PER_DAY = 1
_VIN = re.compile(r"[A-HJ-NPR-Z0-9]{17}")
_on_demand_lock = threading.Lock()  # ponytail: one process; a second worker would need a DB-level reservation
HISTORY_POINTS = 20


def _collapse_history(rows):
    """MarketCheck history (newest first, one row per site) -> price steps, oldest first, at most HISTORY_POINTS.
    A dealer group lists one car on many sites at once, so a step is a change in (price, miles)."""
    pts = []
    for r in sorted((r for r in rows if isinstance(r, dict) and sf(r.get("price"))), key=lambda r: str(r.get("first_seen_at_date"))):
        p = {"date": str(r.get("first_seen_at_date") or "")[:10], "price": sf(r["price"]), "miles": si(r.get("miles")),
             "seller": r.get("seller_name"), "city": r.get("city"), "state": r.get("state")}
        if not pts or (p["price"], p["miles"]) != (pts[-1]["price"], pts[-1]["miles"]):
            pts.append(p)
    return pts if len(pts) <= HISTORY_POINTS else pts[:1] + pts[-(HISTORY_POINTS - 1):]


def _on_demand(table, column, call, shape):
    """Stored result for ?vin=, else (within the caps) one MarketCheck call, stored. {"available": false} otherwise."""
    vin = request.args.get("vin", "").strip().upper()
    if not _VIN.fullmatch(vin):
        abort(400, "vin must be 17 letters and digits")
    session = get_db()
    try:
        if session.query(CarListing.id).filter_by(vin=vin, is_active=1).first() is None:
            abort(404, "no such listing")
        with _on_demand_lock:
            row = session.get(table, vin)
            if row is not None and getattr(row, column) is not None:
                return jsonify({"available": True, **json.loads(getattr(row, column))})
            today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            used = sum(session.query(t).filter(t.fetched_at >= today).count() for t in (VinHistory, VinOptions))
            if used >= ON_DEMAND_PER_DAY or month_total() >= CALL_CAP or (row is not None and row.fetched_at >= today):
                return jsonify({"available": False})
            if row is None:
                row = table(vin=vin)
                session.add(row)
            row.fetched_at = datetime.utcnow()
            session.commit()  # reserve the slot before the call
            try:
                result = shape(call(vin))
            except Exception as e:  # RuntimeError from mc_get is already key-free; the reserved slot stays used
                logger.warning(f"on-demand lookup failed for {table.__tablename__}: {e}")
                return jsonify({"available": False})
            setattr(row, column, json.dumps(result))
            session.commit()
            return jsonify({"available": True, **result})
    finally:
        session.close()


def _history_shape(payload):
    if not isinstance(payload, list):
        raise ValueError("history is not a list")
    return {"points": _collapse_history(payload)}


def _options_shape(payload):
    if not isinstance(payload, dict):
        raise ValueError("decode is not an object")
    opts = [{"code": o.get("code"), "name": o.get("name"), "msrp": sf(o.get("msrp"))}
            for o in payload.get("installed_options_details") or [] if isinstance(o, dict) and o.get("name")]
    return {"options": opts, "combined_msrp": sf(payload.get("combined_msrp")), **extract(payload)[0]}


@app.route("/api/history")
def history():
    """Price history for one active listing's VIN (query param: vin): [{date, price, miles, seller, city, state}], oldest first."""
    return _on_demand(VinHistory, "rows", lambda vin: mc_get(f"history/car/{vin}", {"sort_order": "desc"}),
                      _history_shape)



# ── Market pages: aggregates over the latest active row per VIN, recomputed once per DB change ──

@functools.lru_cache(maxsize=1)
def _market_cars(version):
    session = get_db()
    try:
        return market.load_cars(session)
    finally:
        session.close()


def _found(page):
    if page is None:
        abort(404, "no such make or model")
    return jsonify(page)


@app.route("/api/market/makes")
@db_cached()
def market_makes():
    return jsonify(market.makes(_market_cars(_db_version())))


@app.route("/api/market/make/<make>")
@db_cached(maxsize=64)
def market_make(make):
    return _found(market.make_page(_market_cars(_db_version()), make[:60]))


@app.route("/api/market/model/<make>/<path:model>")
@db_cached(maxsize=128)
def market_model(make, model):
    return _found(market.model_page(_market_cars(_db_version()), make[:60], model[:80]))


@app.route("/api/model-card")
@db_cached()
def model_card():
    """The card ml.pipeline.train writes beside the model, plus live counts from the database."""
    from ml.pipeline import MODEL_PATH
    try:
        with open(os.path.join(os.path.dirname(MODEL_PATH), "model_card.json")) as f:
            card = json.load(f)
    except (OSError, ValueError):
        abort(404, "no model card yet")
    return jsonify({"card": card, "live": market.card_live(_market_cars(_db_version()))})


@app.route("/api/car/<vin>")
@db_cached(maxsize=256)
def car(vin):
    """One active listing for the car page: summary, rating, price history (ours plus any stored MarketCheck
    history, see /api/history) and the asking prices of the same make, model and year."""
    vin = vin.strip().upper()
    if not _VIN.fullmatch(vin):
        abort(400, "vin must be 17 letters and digits")
    session = get_db()
    try:
        c = session.query(CarListing).filter_by(vin=vin, is_active=1).order_by(CarListing.last_seen.desc(), CarListing.id.desc()).first()
        if c is None:
            abort(404, "no such listing")
        p = session.query(Prediction).filter_by(listing_id=c.listing_id).first() or Prediction()
        stats = ListingRepository(session).get_market_stats().get((c.make, c.model, c.year))
        own = [{"date": str(h.date)[:10], "price": h.price, "miles": h.miles, "seller": h.seller, "source": h.source}
               for h in session.query(VinPriceHistory).filter_by(vin=vin).order_by(VinPriceHistory.date, VinPriceHistory.id)]
        vh = session.get(VinHistory, vin)
        stored = json.loads(vh.rows).get("points", []) if vh is not None and vh.rows is not None else []
        rated = p.deal_score is not None
        return jsonify({
            "vin": vin, "listing_id": c.listing_id, "url": c.url, "photo_url": ss(c.photo_url),
            "year": c.year, "make": market.show_make(c.make), "model": c.model, "trim": ss(c.trim),
            "price": sf(c.price), "mileage": si(c.mileage), "dealer_name": market.show_dealer(ss(c.dealer_name)),
            "dealer_type": ss(c.dealer_type), "drivetrain": ss(c.drivetrain), "fuel_type": ss(c.fuel_type),
            "fuel": market.fuel_family(ss(c.fuel_type), ss(c.powertrain_type)),
            "exterior_color": ss(c.exterior_color), "base_ext_color": ss(c.base_ext_color),
            "color_family": market.color_family(c.base_ext_color, c.exterior_color) if c.base_ext_color or c.exterior_color else None,
            "city_mpg": si(c.city_mpg), "highway_mpg": si(c.highway_mpg), **_extras(c),
            "location_city": c.location_city, "location_state": c.location_state,
            "days_on_market": si(c.days_listed), "days_in_listing": si(c.dom_active),
            "last_seen": str(c.last_seen)[:10] if c.last_seen else None,   # as /api/deals: the listing page counts days from it
            "first_listed": str(c.first_seen_at_mc_date)[:10] if c.first_seen_at_mc_date else None,
            "first_seen": str(c.first_seen)[:10] if c.first_seen else None,
            "deal_score": sf(p.deal_score), "deal_label": p.deal_label, "rating_basis": p.rating_basis,
            "comparables": si(p.comparables), "typical_error_pct": sf(p.typical_error_pct),
            # as /api/deals: the model's estimate when it rated the car, the US median for a national rating, else none
            "predicted_price": stats["median"] if p.rating_basis == "national" and stats else sf(p.predicted_price) if rated and p.rating_basis != "national" else None,
            "model_number": sf(p.predicted_price),   # the raw estimate, even when unrated: show it as unverified
            "market": stats,
            "history": market.merge_history(own, stored),
            "has_full_history": vh is not None and vh.rows is not None,
            "cohort": market.cohort(_market_cars(_db_version()), c.make, c.model, c.year),
        })
    finally:
        session.close()

@app.route("/api/options")
def options():
    """Factory options and sticker price for one active listing's VIN (query param: vin)."""
    return _on_demand(VinOptions, "data", lambda vin: mc_get(f"decode/car/neovin/{vin}/specs", {}), _options_shape)


@app.route("/api/photos")
@db_cached("id", maxsize=256)
def photos():
    """Every photo URL for one listing, card photo first. Older rows and Auto.dev fills
    only have photo_url, so they return that one. Query param: id."""
    session = get_db()
    try:
        car = session.query(CarListing.photo_urls, CarListing.photo_url).filter_by(
            listing_id=request.args.get("id", "")[:200]).first()
    finally:
        session.close()
    if car is None:
        abort(404, "no such listing")
    return jsonify(json.loads(car.photo_urls) if car.photo_urls else [car.photo_url] if car.photo_url else [])


@app.route("/api/popular")
@db_cached("limit")
def popular():
    limit = _arg_int("limit", 20, 1, 200)
    session = get_db()
    try:
        repo = PopularityRepository(session)
        df = repo.get_trending(top_n=limit)
        if df is None or df.empty:
            return jsonify([])

        records = []
        for _, row in df.iterrows():
            records.append({
                "rank":            si(row.get("popularity_rank")),
                "year":            si(row.get("year")),
                "make":            market.show_make(row.get("make")),
                "model":           row.get("model"),
                "active_listings": si(row.get("active_listings")),
                "avg_price":       sf(row.get("avg_price")),
                "median_price":    sf(row.get("median_price")),
                "avg_mileage":     sf(row.get("avg_mileage")),
                "avg_days_listed": sf(row.get("avg_days_listed")),
                "sold_last_7d":    si(row.get("sold_last_7d")),
            })
        return jsonify(records)
    finally:
        session.close()


@app.route("/api/stats")
@db_cached()
def stats():
    session = get_db()
    try:
        repo = ListingRepository(session)
        df = repo.get_active_listings_df()
        if df is None or df.empty:
            return jsonify({})

        return jsonify({
            "active_listings": int(repo.count_active()),
            "graded_listings": len(_deal_records(_db_version())),  # what the site shows, rated or not
            "makes":           int(df["make"].nunique()) if "make" in df else 0,
            "models":          int(df["model"].nunique()) if "model" in df else 0,
            "avg_price":       sf(df["price"].mean()) if "price" in df else None,
            "price_min":       sf(df["price"].min()) if "price" in df else None,
            "price_max":       sf(df["price"].max()) if "price" in df else None,
            "avg_mileage":     sf(df["mileage"].mean()) if "mileage" in df else 0,
            # When the pipeline last wrote the data, not when this was served.
            "last_updated":    datetime.fromtimestamp(os.path.getmtime("car_intel.db"), timezone.utc).isoformat()
        })
    finally:
        session.close()


@app.route("/api/trends")
@db_cached()
def trends():
    session = get_db()
    try:
        repo = ListingRepository(session)
        df = repo.get_all_listings_df(days_back=210)
        if df is None or df.empty:
            return jsonify({"data": [], "makes": []})

        df["first_seen"] = pd.to_datetime(df["first_seen"], errors="coerce")
        df = df.dropna(subset=["first_seen"])
        df["month_num"] = df["first_seen"].dt.to_period("M")

        top_makes = df["make"].value_counts().head(5).index.tolist()
        df_top = df[df["make"].isin(top_makes)]

        grouped = df_top.groupby(["month_num", "make"])["price"].mean().reset_index()
        pivoted = grouped.pivot(index="month_num", columns="make", values="price").reset_index()
        pivoted = pivoted.sort_values("month_num").tail(7)
        pivoted["month"] = pivoted["month_num"].dt.strftime("%b")

        result = []
        for _, row in pivoted.iterrows():
            entry = {"month": row["month"]}
            for mk in top_makes:
                v = sf(row.get(mk))
                if v is not None:
                    entry[mk.lower()] = round(v, 0)
            result.append(entry)

        return jsonify({"data": result, "makes": top_makes})
    finally:
        session.close()


@app.route("/api/listings")
@db_cached()
def listings():
    """
    Data for PRICE vs MILEAGE scatter.
    We merge predictions onto active listings. deal_score is 0–100; default 50 if missing.
    """
    session = get_db()
    try:
        repo = ListingRepository(session)
        pred = PredictionRepository(session)

        df = repo.get_active_listings_df()
        if df is None or df.empty:
            return jsonify([])

        # Inner join: only graded listings (unscored ones, e.g. under the
        # price floor, would otherwise plot as a made-up score of 50).
        pred_df = pred.get_top_deals(limit=None, min_deal_score=0)
        if pred_df is None or pred_df.empty:
            return jsonify([])
        df = df.merge(
            pred_df[["listing_id", "predicted_price", "deal_score", "deal_label"]],
            on="listing_id",
        )

        if len(df) > 800:
            df = df.sample(800, random_state=42)

        records = []
        for _, row in df.iterrows():
            score = sf(row.get("deal_score"))
            records.append({
                "year":            si(row.get("year")),
                "make":            market.show_make(row.get("make")),
                "model":           row.get("model"),
                "price":           sf(row.get("price")),
                "mileage":         si(row.get("mileage")),
                "deal_score":      score if score is not None else 50.0,
                "deal_label":      row.get("deal_label") or "Fair Price",
                "predicted_price": sf(row.get("predicted_price")),
                "body_type":       ss(row.get("body_type")),  # NEW (optional for tooltip/filtering)
            })
        return jsonify(records)
    finally:
        session.close()


_model_cache: dict = {}


def _cached_model(load_model):
    """The saved model, reloaded only when the daily pipeline rewrites the file."""
    from ml.pipeline import MODEL_PATH
    try:
        mtime = os.path.getmtime(MODEL_PATH)
    except OSError:
        return None
    if _model_cache.get("mtime") != mtime:
        _model_cache.update(mtime=mtime, payload=load_model())
    return _model_cache["payload"]


@app.route("/api/predict")
def predict_price():
    """
    Returns a predicted market price for a given car.
    Required: make, model, year, mileage
    Optional: trim, state
    """
    make       = request.args.get("make", "").strip()[:60]
    model_name = request.args.get("model", "").strip()[:60]
    year       = request.args.get("year", type=int)
    mileage    = request.args.get("mileage", type=int)

    if not make or not model_name or not year or mileage is None:
        return jsonify({"error": "make, model, year, and mileage are required"}), 400
    if not 1980 <= year <= datetime.now().year + 1:
        return jsonify({"error": f"year must be between 1980 and {datetime.now().year + 1}"}), 400
    if not 0 <= mileage <= 1_000_000:
        return jsonify({"error": "mileage must be between 0 and 1,000,000"}), 400

    try:
        from ml.pipeline import load as load_model, _build_features_raw, _cohort_features, _segment_error_for
        import numpy as np

        payload = _cached_model(load_model)
        if payload is None:
            return jsonify({"error": "Model not available"}), 503

        row = {
            "make":           make,
            "model":          model_name,
            "year":           year,
            "mileage":        mileage,
            "trim":           request.args.get("trim", "")[:60],
            "location_state": request.args.get("state", "")[:2],
        }

        X = _build_features_raw(pd.DataFrame([row]))
        # this car has no dealer: compare with every dealer's
        X = _cohort_features(X, pd.Series(["(api)"]), payload["cohort_ref"])
        log_calibration = payload.get("log_calibration", 0.0)
        predicted = float(np.expm1(payload["model"].predict(X)[0] - log_calibration))

        # The model's median abs % error for cars at this price with this many
        # comparables (the deal score's yardstick): about half of similar
        # listings fall within +/- this much of the estimate.
        comparables = int(X["cohort_count"].iloc[0]) if "cohort_count" in X else None
        err_pct = _segment_error_for(predicted, payload.get("segment_errors"), comparables)
        return jsonify({
            "predicted_price": round(predicted, 0),
            "range_low":       round(predicted * (1 - err_pct / 100), -2),
            "range_high":      round(predicted * (1 + err_pct / 100), -2),
            "typical_error_pct": round(err_pct, 1),
            "comparables":     comparables,
        })
    except HTTPException:
        raise
    except Exception:
        logger.exception("predict failed")
        return jsonify({"error": "Couldn't estimate a price for that car"}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Car Intel API running on port {port}")
    app.run(host="127.0.0.1", debug=False, port=port)