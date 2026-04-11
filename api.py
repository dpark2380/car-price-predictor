"""
api.py — Flask REST API for Car Intel dashboard
Run: PYTHONPATH=. python3 api.py
"""

import math
import os
from datetime import datetime, timezone

import pandas as pd
from flask import Flask, jsonify, request
from flask_cors import CORS

from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository

app = Flask(__name__)
CORS(app)


def get_db():
    engine = init_db()
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


@app.route("/api/deals")
def deals():
    """
    Returns "deal finder" rows.

    deal_score is 0–100 where 100 is best deal.
    Query params:
      - min_score: minimum deal_score to include (default 0)
      - make/model: substring filters
      - body: body type filter (e.g. SUV, Sedan, Truck). Use "unknown" for NULLs.
    """
    limit     = int(request.args.get("limit", 100))
    min_score = float(request.args.get("min_score", 0))
    make      = request.args.get("make", "").strip().lower()
    model_q   = request.args.get("model", "").strip().lower()
    body_q    = request.args.get("body", "").strip().lower()  # NEW

    session = get_db()
    try:
        repo = PredictionRepository(session)

        # Pull a bunch, then filter/sort in API
        df = repo.get_top_deals(limit=max(limit, 5000), min_deal_score=min_score)
        if df is None or df.empty:
            return jsonify([])

        # Ensure numeric columns
        df["price"] = pd.to_numeric(df.get("price"), errors="coerce")
        df["predicted_price"] = pd.to_numeric(df.get("predicted_price"), errors="coerce")
        df["deal_score"] = pd.to_numeric(df.get("deal_score"), errors="coerce")

        # Ensure body_type exists as a column, even if missing
        if "body_type" not in df.columns:
            df["body_type"] = None

        df["savings"] = (df["predicted_price"] - df["price"]).round(0)

        if make:
            df = df[df["make"].astype(str).str.lower().str.contains(make, na=False)]
        if model_q:
            df = df[df["model"].astype(str).str.lower().str.contains(model_q, na=False)]

        # NEW: Body type filter
        # - body=unknown filters for NULL/empty
        # - otherwise substring match (case-insensitive)
        if body_q:
            bt = df["body_type"].astype(str).str.strip()
            if body_q in {"unknown", "null", "(null)", "none"}:
                df = df[df["body_type"].isna() | (bt == "") | (bt.str.lower() == "nan")]
            else:
                df = df[bt.str.lower().str.contains(body_q, na=False)]

        # Apply min_score again after filters (defensive)
        df = df[df["deal_score"].fillna(-1) >= min_score]

        # Best-first
        df = df.sort_values("deal_score", ascending=False).head(limit)

        records = []
        for _, row in df.iterrows():
            records.append({
                "listing_id":      row.get("listing_id"),
                "url":             row.get("url"),
                "year":            si(row.get("year")),
                "make":            row.get("make"),
                "model":           row.get("model"),
                "trim":            ss(row.get("trim")),
                "body_type":       ss(row.get("body_type")),  # NEW
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
            })
        return jsonify(records)
    finally:
        session.close()


@app.route("/api/popular")
def popular():
    limit = int(request.args.get("limit", 20))
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
def stats():
    session = get_db()
    try:
        repo = ListingRepository(session)
        df = repo.get_active_listings_df()
        if df is None or df.empty:
            return jsonify({})

        return jsonify({
            "active_listings": int(repo.count_active()),
            "makes":           int(df["make"].nunique()) if "make" in df else 0,
            "models":          int(df["model"].nunique()) if "model" in df else 0,
            "avg_price":       sf(df["price"].mean()) if "price" in df else None,
            "price_min":       sf(df["price"].min()) if "price" in df else None,
            "price_max":       sf(df["price"].max()) if "price" in df else None,
            "avg_mileage":     sf(df["mileage"].mean()) if "mileage" in df else 0,
            "last_updated":    datetime.now(timezone.utc).isoformat()
        })
    finally:
        session.close()


@app.route("/api/trends")
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

        pred_df = pred.get_top_deals(limit=99999, min_deal_score=0)
        if pred_df is not None and not pred_df.empty:
            df = df.merge(
                pred_df[["listing_id", "predicted_price", "deal_score", "deal_label"]],
                on="listing_id",
                how="left",
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


@app.route("/api/market-popular")
def market_popular():
    state = request.args.get("state", "CA")
    limit = request.args.get("limit", 20, type=int)
    try:
        from scraper.marketcheck_enrichment import MarketCheckEnrichment
        return jsonify(MarketCheckEnrichment().get_popular_cars(state=state, limit=limit))
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/recent-listings")
def recent_listings():
    make  = request.args.get("make")
    model = request.args.get("model")
    rows  = request.args.get("rows", 50, type=int)
    try:
        from scraper.marketcheck_enrichment import MarketCheckEnrichment
        results = MarketCheckEnrichment().get_recent_listings(rows=rows, make=make, model=model)
        mapped = []
        for r in results:
            build = r.get("build", {}) or {}
            mapped.append({
                "id":      r.get("id"),
                "vin":     r.get("vin"),
                "year":    build.get("year") or r.get("year"),
                "make":    build.get("make") or r.get("make"),
                "model":   build.get("model") or r.get("model"),
                "trim":    build.get("trim") or r.get("trim"),
                "price":   r.get("price"),
                "mileage": r.get("miles"),
                "dom":     r.get("dom"),
                "url":     r.get("vdp_url"),
                "city":    (r.get("dealer") or {}).get("city"),
                "state":   (r.get("dealer") or {}).get("state"),
            })
        return jsonify(mapped)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/predict")
def predict_price():
    """
    Returns a predicted market price for a given car.
    Required: make, model, year, mileage
    Optional: accident_count, owner_count, state
    """
    make       = request.args.get("make", "").strip()
    model_name = request.args.get("model", "").strip()
    year       = request.args.get("year", type=int)
    mileage    = request.args.get("mileage", type=int)

    if not make or not model_name or not year or mileage is None:
        return jsonify({"error": "make, model, year, and mileage are required"}), 400

    try:
        from ml.pipeline import load as load_model, _build_features_raw
        import numpy as np

        payload = load_model()
        if payload is None:
            return jsonify({"error": "Model not available"}), 503

        row = {
            "make":           make,
            "model":          model_name,
            "year":           year,
            "mileage":        mileage,
            "accident_count": request.args.get("accident_count", 0, type=int),
            "owner_count":    request.args.get("owner_count", 1, type=int),
            "location_state": request.args.get("state", ""),
        }

        X = _build_features_raw(pd.DataFrame([row]))
        log_calibration = payload.get("log_calibration", 0.0)
        predicted = float(np.expm1(payload["model"].predict(X)[0] - log_calibration))

        return jsonify({"predicted_price": round(predicted, 0)})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    print(f"Car Intel API running on port {port}")
    app.run(host="0.0.0.0", debug=False, port=port)