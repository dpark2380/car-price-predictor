"""
scheduler/runner.py — Orchestrates scrape → score → train jobs
"""

import argparse
from loguru import logger

from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository, PopularityRepository
from scraper.data_ingest import DataIngestor
from ml import pipeline

from scraper.api_usage import get_calls_today


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
    seen_ids: set[str] = set()

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

            # be defensive: only add non-empty ids
            for l in listings:
                lid = l.get("listing_id")
                if lid:
                    seen_ids.add(lid)

    # Optional: mark inactive based on "not seen recently".
    # NOTE: seen_ids is not used by mark_inactive() in repo; it uses last_seen timestamps.
    # If you want "not in this scrape" logic, we can add a repo.mark_inactive_by_seen_ids(seen_ids).
    # repo.mark_inactive(scrape_source="cars.com", older_than_hours=48)

    logger.info(f"▶ Scrape job done | new={total_new} updated={total_upd}")


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
            scrape_job(repo, pred, pop)   # ONLY scrape
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