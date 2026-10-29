"""
scheduler/runner.py — Runs scrape → train → score → popularity once, then exits.

No flag runs all four; --scrape-only / --train-only / --score-only run one.
Scheduling lives outside this script (launchd, see deploy/macmini/).
"""

import argparse
import csv
import os
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

from loguru import logger

from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository
from db.validation import run_validation
from scraper.api_usage import NY_TZ, month_total
from scraper.data_ingest import DataIngestor, MONTHLY_CALL_BUDGET
from ml import pipeline
from env_utils import env_int

LOGS_DIR = Path("logs")

# See ListingRepository.mark_stale_inactive for why this is generous rather
# than per-run: the scraper only re-confirms a rotating slice of inventory
# each run (each zip comes round every ~15 days on the daily schedule), so
# "unseen for N days" needs headroom for that coverage cycle. 60 days is about
# four cycles; a listing typically stays up ~18 days. It was 180 while the
# laptop schedule left months-long gaps; a deactivated listing that is seen
# again is reactivated on upsert. Display only: training and scoring use
# every listing seen in the last 180 days, active or not.
INACTIVE_AFTER_DAYS = env_int("INACTIVE_AFTER_DAYS", 60)

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


def log_validation(counts: dict) -> None:
    """One row per retrain, so e.g. duplicate_vins can be tracked over time.
    ponytail: header is written once; adding a check to validation.sql needs a
    fresh validation_log.csv (columns would misalign otherwise)."""
    row = {"timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"), **counts}
    _append_csv(LOGS_DIR / "validation_log.csv", row)


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

    deactivated = repo.mark_stale_inactive(INACTIVE_AFTER_DAYS)
    total_active = repo.count_active()
    logger.info(
        f"▶ Scrape job done | new={total_new} updated={total_upd} "
        f"deactivated={deactivated} (unseen {INACTIVE_AFTER_DAYS}+ days) active={total_active}"
    )
    log_scrape(total_new, total_upd, total_active, target_names)


def month_end_topup(repo, pred_repo, pop_repo, now: datetime | None = None) -> int:
    """
    On the last day of the month (New York time, like the usage counter),
    repeat the scrape until the monthly budget can't fit another pass, so
    calls the daily runs left unused (~50 a month, more after downtime) aren't
    wasted. Returns the number of extra passes.
    """
    now = now or datetime.now(NY_TZ)
    if (now + timedelta(days=1)).month == now.month:
        return 0
    per_pass = DataIngestor.CALLS_PER_TARGET * len(load_targets())
    passes = 0
    while passes < 20 and month_total() + per_pass <= MONTHLY_CALL_BUDGET:
        before = month_total()
        logger.info(f"▶ Month-end top-up pass {passes + 1} ({MONTHLY_CALL_BUDGET - before} calls left)")
        scrape_job(repo, pred_repo, pop_repo)
        passes += 1
        if month_total() == before:  # no call went out (API down?): don't spin
            break
    return passes


def score_job(repo: ListingRepository, pred_repo: PredictionRepository):
    logger.info("▶ Score job starting")
    # Includes recently-deactivated listings too, so predictions stay ready
    # for them (e.g. if a listing gets re-seen and reactivated later) even
    # though the live results endpoint only ever surfaces active ones.
    df = repo.get_scoring_listings_df()
    if df.empty:
        logger.warning("No listings to score")
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

    counts = run_validation(repo.session)
    logger.info("Data validation: " + ", ".join(f"{k}={v}" for k, v in counts.items()))
    log_validation(counts)

    # All training filters live in the training_listings_v SQL view
    # (db/models.py); recently-delisted listings stay in — their data is
    # still real signal, only the live results endpoint excludes them.
    df = repo.get_training_listings_df()
    if df.empty:
        logger.warning("No data to train on")
        return

    result = pipeline.train(df, repo)

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
        month_end_topup(repo, pred, pop)
        ml_train_job(repo)
        score_job(repo, pred)
        popularity_job(repo, pop)
    finally:
        session.close()


def main():
    parser = argparse.ArgumentParser()
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
    try:
        run_all(engine)
    except Exception:
        ping_healthcheck("/fail")
        raise
    ping_healthcheck()


def ping_healthcheck(suffix: str = "") -> None:
    """Dead-man's switch: healthchecks.io emails you if a ping is late or a /fail
    arrives. Unset HEALTHCHECK_URL disables it; a failed ping never fails the run."""
    url = os.getenv("HEALTHCHECK_URL", "").strip()
    if not url:
        return
    try:
        urllib.request.urlopen(url + suffix, timeout=10)
    except Exception as e:
        logger.warning(f"Healthcheck ping failed: {e}")


if __name__ == "__main__":
    main()
