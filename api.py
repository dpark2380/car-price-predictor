"""
api.py — Flask REST API for Car Intel dashboard
Run: PYTHONPATH=. python3 api.py
"""

import functools
import math
import os
from datetime import datetime, timezone

import pandas as pd
from flask import Flask, abort, jsonify, request
from flask_cors import CORS
from loguru import logger
from werkzeug.exceptions import HTTPException

from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository

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
    """Changes whenever the pipeline writes the database."""
    try:
        return os.path.getmtime("car_intel.db")
    except OSError:
        return 0.0


def db_cached(*params, maxsize=8):
    """
    Serve a GET endpoint's response from memory until the pipeline next writes
    the database. Only the named query params form the key, so junk params
    (Cloudflare cache-busting) can't force recomputation, and maxsize bounds
    memory however many distinct values arrive.
    """
    def deco(view):
        @functools.lru_cache(maxsize=maxsize)
        def compute(version, key):
            r = view()
            r = r if isinstance(r, app.response_class) else app.make_response(r)
            return r.get_data(), r.status_code, r.mimetype

        @functools.wraps(view)
        def wrapper():
            key = tuple(request.args.get(p, "") for p in params)
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


@functools.lru_cache(maxsize=1)
def _deal_records(version):
    """Every graded listing as API rows, best deal first. version: _db_version()."""
    session = get_db()
    try:
        df = PredictionRepository(session).get_top_deals(limit=None, min_deal_score=0)
        if df is None or df.empty:
            return []

        df["price"] = pd.to_numeric(df.get("price"), errors="coerce")
        df["predicted_price"] = pd.to_numeric(df.get("predicted_price"), errors="coerce")
        df["deal_score"] = pd.to_numeric(df.get("deal_score"), errors="coerce")
        if "body_type" not in df.columns:
            df["body_type"] = None
        df["savings"] = (df["predicted_price"] - df["price"]).round(0)
        df = df.sort_values("deal_score", ascending=False)

        return [{
            "listing_id":      row.get("listing_id"),
            "url":             row.get("url"),
            "year":            si(row.get("year")),
            "make":            row.get("make"),
            "model":           row.get("model"),
            "trim":            ss(row.get("trim")),
            "body_type":       ss(row.get("body_type")),
            "price":           sf(row.get("price")),
            "predicted_price": sf(row.get("predicted_price")),
            "savings":         sf(row.get("savings")),
            "deal_score":      sf(row.get("deal_score")),
            "deal_label":      row.get("deal_label"),
            "mileage":         si(row.get("mileage")),
            "location_state":  row.get("location_state"),
            "location_city":   row.get("location_city"),
            "condition":       row.get("condition"),
            "accident_count":  si(row.get("accident_count")) or 0,
            "days_listed":     si(row.get("days_listed")) or 0,
        } for _, row in df.iterrows()]
    finally:
        session.close()


@app.route("/api/deals")
@db_cached("limit", "min_score", "make", "model", "body", maxsize=4)
def deals():
    """
    Returns "deal finder" rows, best first.

    deal_score is 0–100 where 100 is best deal.
    Query params:
      - limit: max rows to return (default: all graded listings)
      - min_score: minimum deal_score to include (default 0)
      - make/model: substring filters
      - body: body type filter (e.g. SUV, Sedan, Truck). Use "unknown" for NULLs.
    """
    limit     = _arg_int("limit", None, 1, 50_000)
    min_score = request.args.get("min_score", 0.0, type=float)
    make      = request.args.get("make", "").strip().lower()[:60]
    model_q   = request.args.get("model", "").strip().lower()[:60]
    body_q    = request.args.get("body", "").strip().lower()[:60]

    rows = _deal_records(_db_version())
    if min_score > 0:
        rows = [r for r in rows if (r["deal_score"] or 0) >= min_score]
    if make:
        rows = [r for r in rows if make in str(r["make"] or "").lower()]
    if model_q:
        rows = [r for r in rows if model_q in str(r["model"] or "").lower()]
    if body_q in {"unknown", "null", "(null)", "none"}:
        rows = [r for r in rows if not (r["body_type"] or "").strip() or r["body_type"].lower() == "nan"]
    elif body_q:
        rows = [r for r in rows if body_q in (r["body_type"] or "").lower()]
    return jsonify(rows[:limit] if limit else rows)


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
                "make":            row.get("make"),
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
            "graded_listings": PredictionRepository(session).count_graded(),
            "makes":           int(df["make"].nunique()) if "make" in df else 0,
            "models":          int(df["model"].nunique()) if "model" in df else 0,
            "avg_price":       sf(df["price"].mean()) if "price" in df else None,
            "price_min":       sf(df["price"].min()) if "price" in df else None,
            "price_max":       sf(df["price"].max()) if "price" in df else None,
            "avg_mileage":     sf(df["mileage"].mean()) if "mileage" in df else 0,
            # When the pipeline last wrote the data, not when this was served.
            "last_updated":    datetime.fromtimestamp(_db_version(), timezone.utc).isoformat()
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
                "make":            row.get("make"),
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
    Optional: accident_count, owner_count, state
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
        from ml.pipeline import load as load_model, _build_features_raw, _apply_cohort_features, _cohort_features, _segment_error_for
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
            "accident_count": _arg_int("accident_count", 0, 0, 20),
            "owner_count":    _arg_int("owner_count", 1, 1, 20),
            "location_state": request.args.get("state", "")[:2],
        }

        X = _build_features_raw(pd.DataFrame([row]))
        cohort_ref, cohort_stats = payload.get("cohort_ref"), payload.get("cohort_stats")
        if cohort_ref is not None:  # this car has no dealer: compare with every dealer's
            X = _cohort_features(X, pd.Series(["(api)"]), cohort_ref)
        elif cohort_stats is not None:
            X = _apply_cohort_features(X, cohort_stats)
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