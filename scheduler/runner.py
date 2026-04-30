"""
scheduler/runner.py — Orchestrates scrape → score → train jobs
"""

import argparse
import csv
import os
from datetime import datetime, timezone
from pathlib import Path

from loguru import logger

from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository
from scraper.data_ingest import DataIngestor
from ml import pipeline

from scraper.api_usage import get_calls_today

LOGS_DIR = Path("logs")

# ── Persistent run logging ────────────────────────────────────────────────────

def _append_csv(path: Path, row: dict) -> None:
    """Append one row to a CSV log, writing headers on first write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    write_header = not path.exists()
    with open(path, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=row.keys())
        if write_header:
            writer.writeheader()
        writer.writerow(row)


def log_scrape(new: int, updated: int, total_active: int, targets: list[str]) -> None:
    row = {
        "timestamp":    datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "new":          new,
        "updated":      updated,
        "total_active": total_active,
        "targets":      "|".join(targets),
    }
    _append_csv(LOGS_DIR / "scrape_log.csv", row)


def log_training(result: dict) -> None:
    metrics = result.get("metrics", {})

    def m(model: str, key: str):
        return round(metrics.get(model, {}).get(key, float("nan")), 1) if model in metrics else ""

    row = {
        "timestamp":          datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "model_version":      result.get("version", ""),
        "n_rows":             result.get("n", ""),
        "train_rows":         result.get("train_rows", ""),
        "test_rows":          result.get("test_rows", ""),
        "selected_model":     result.get("selected_model", ""),
        # per-candidate MAE
        "linear_mae":         m("linear", "mae"),
        "relaxed_lasso_mae":  m("relaxed_lasso", "mae"),
        "rf_mae":             m("rf", "mae"),
        "xgb_mae":            m("xgb", "mae"),
        # XGB detail
        "xgb_rmse":           m("xgb", "rmse"),
        "xgb_luxury_mae":     m("xgb", "luxury_mae"),
        "xgb_nonlux_mae":     m("xgb", "nonlux_mae"),
        # XGB hyperparams (returned only when XGB was tuned)
        "xgb_lr":             result.get("xgb_lr", ""),
        "xgb_n_estimators":   result.get("xgb_n_estimators", ""),
    }
    _append_csv(LOGS_DIR / "training_log.csv", row)


# ── Jobs ──────────────────────────────────────────────────────────────────────

def load_targets(path: str = "config/search_targets.json") -> list[dict]:
    import json
    with open(path, "r", encoding="utf-8") as f:
        return [t for t in json.load(f) if t.get("enabled", True)]


def scrape_job(
    repo: ListingRepository,
    pred_repo: PredictionRepository,
    pop_repo: PopularityRepository,
):
    logger.info("▶ Scrape job starting")
    ingestor = DataIngestor()
    targets = load_targets()
    total_new = 0
    total_upd = 0
    target_names = []

    for target in targets:
        name = target.get("name")
        if not name:
            continue

        logger.info(f"  Scraping: {name}")
        listings = ingestor.scrape_search(search_target=name) or []
        if listings:
            ins, upd = repo.upsert_listings(listings)
            total_new += ins
            total_upd += upd
            target_names.append(name)

    total_active = repo.count_active()
    logger.info(f"▶ Scrape job done | new={total_new} updated={total_upd} active={total_active}")
    log_scrape(total_new, total_upd, total_active, target_names)


def score_job(repo: ListingRepository, pred_repo: PredictionRepository):
    logger.info("▶ Score job starting")
    df = repo.get_active_listings_df()
    if df.empty:
        logger.warning("No active listings to score")
        return

    predictions = pipeline.score_listings(df) or []
    if predictions:
        pred_repo.save_predictions(predictions)

    logger.info("▶ Score job done")


def popularity_job(repo: ListingRepository, pop_repo: PopularityRepository):
    logger.info("▶ Popularity job starting")
    df = repo.get_active_listings_df()
    if df.empty:
        logger.warning("No active listings for popularity snapshot")
        return

    cohorts = pipeline.update_popularity_snapshot(df) or []
    if cohorts:
        pop_repo.save_snapshot(cohorts)

    logger.info("▶ Popularity job done")


def ml_train_job(repo: ListingRepository):
    logger.info("▶ ML train job starting")

    df = repo.get_active_listings_df()
    if df.empty:
        logger.warning("No data to train on")
        return

    result = pipeline.train(df)

    if result is None:
        logger.warning("Training did not run (insufficient data)")
        return

    log_training(result)
    logger.info("▶ ML train job complete")


def run_all(engine):
    session = get_session(engine)
    repo = ListingRepository(session)
    pred = PredictionRepository(session)
    pop = PopularityRepository(session)
    try:
        scrape_job(repo, pred, pop)
        ml_train_job(repo)
        score_job(repo, pred)
        popularity_job(repo, pop)
    finally:
        session.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--scrape-only", action="store_true")
    parser.add_argument("--train-only", action="store_true")
    parser.add_argument("--score-only", action="store_true")
    args = parser.parse_args()

    engine = init_db()

    if args.scrape_only:
        session = get_session(engine)
        try:
            repo = ListingRepository(session)
            pred = PredictionRepository(session)
            pop = PopularityRepository(session)
            scrape_job(repo, pred, pop)
        finally:
            session.close()
        return

    if args.train_only:
        session = get_session(engine)
        try:
            repo = ListingRepository(session)
            ml_train_job(repo)
        finally:
            session.close()
        return

    if args.score_only:
        session = get_session(engine)
        try:
            repo = ListingRepository(session)
            pred = PredictionRepository(session)
            score_job(repo, pred)
        finally:
            session.close()
        return

    logger.info("Running all jobs once…")
    run_all(engine)


if __name__ == "__main__":
    main()
