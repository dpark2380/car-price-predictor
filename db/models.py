from datetime import datetime
from sqlalchemy import (
    create_engine, Column, String, Integer, Float,
    DateTime, Text, Index, text
)
from sqlalchemy.orm import declarative_base, sessionmaker

from env_utils import env_int

Base = declarative_base()

class CarListing(Base):
    __tablename__ = "car_listings"
    id             = Column(Integer, primary_key=True, autoincrement=True)
    listing_id     = Column(String, unique=True, nullable=False)
    vin            = Column(String, index=True)
    url            = Column(Text)
    scrape_source  = Column(String)
    year           = Column(Integer)
    make           = Column(String)
    model          = Column(String)
    trim           = Column(String)
    body_style     = Column(String)
    body_type      = Column(String, nullable=True)
    condition      = Column(String)
    exterior_color = Column(String)
    price          = Column(Float)
    mileage        = Column(Integer)
    accident_count = Column(Integer, default=0)
    owner_count    = Column(Integer, default=1)
    dealer_name    = Column(String)
    dealer_rating  = Column(Float)
    location_city  = Column(String)
    location_state = Column(String)
    location_zip   = Column(String)
    first_seen     = Column(DateTime, default=datetime.utcnow)
    last_seen      = Column(DateTime, default=datetime.utcnow)
    days_listed    = Column(Integer, default=0)
    is_active      = Column(Integer, default=1)
    __table_args__ = (
        Index("ix_make_model", "make", "model"),
        Index("ix_active", "is_active"),
    )

class Prediction(Base):
    __tablename__ = "predictions"
    id              = Column(Integer, primary_key=True, autoincrement=True)
    listing_id      = Column(String, index=True, nullable=False)
    predicted_price = Column(Float)
    deal_score      = Column(Float)
    deal_label      = Column(String)
    model_version   = Column(String)
    scored_at       = Column(DateTime, default=datetime.utcnow)

class PopularitySnapshot(Base):
    __tablename__ = "popularity_snapshots"
    id              = Column(Integer, primary_key=True, autoincrement=True)
    snapshot_date   = Column(DateTime, default=datetime.utcnow)
    year            = Column(Integer)
    make            = Column(String)
    model           = Column(String)
    popularity_rank = Column(Integer)
    active_listings = Column(Integer)
    avg_price       = Column(Float)
    median_price    = Column(Float)
    avg_mileage     = Column(Float)
    avg_days_listed = Column(Float)
    sold_last_7d    = Column(Integer, default=0)


DB_PATH = "sqlite:///car_intel.db"

# Listings on market longer than this (Marketcheck `dom`) are excluded from
# training — their asking price is unreliable as a market signal. They are
# still scored; we just don't learn "market" from them.
STALE_LISTING_MAX_DAYS = env_int("STALE_LISTING_MAX_DAYS", 365)
TRAINING_WINDOW_DAYS = 180

# The single definition of which rows the model trains on.
# training_pool_v: value filters + one row per VIN, so scripts/holdout_audit.py
# can apply the recency window as of a past training time. training_listings_v:
# the pool plus the rolling last_seen window — what train() consumes.
#
# Dealers re-list the same car under a new Marketcheck id (usually after a
# price cut), so one VIN can hold several near-identical rows; keeping them
# all leaks test cars into training. Keep the latest valid snapshot per VIN
# (ties -> newest id); rows without a VIN count as their own car.
VIEWS = {
    "training_pool_v": f"""
        CREATE VIEW training_pool_v AS
        SELECT * FROM (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY COALESCE(NULLIF(vin, ''), 'listing:' || listing_id)
                ORDER BY last_seen DESC, id DESC
            ) AS vin_rank
            FROM car_listings
            WHERE price BETWEEN 3000 AND 100000
              AND mileage BETWEEN 0 AND 400000
              AND COALESCE(days_listed, 0) <= {STALE_LISTING_MAX_DAYS}
              AND year IS NOT NULL
              AND make IS NOT NULL
              AND model IS NOT NULL
        )
        WHERE vin_rank = 1""",
    "training_listings_v": f"""
        CREATE VIEW training_listings_v AS
        SELECT * FROM training_pool_v
        WHERE last_seen >= datetime('now', '-{TRAINING_WINDOW_DAYS} days')""",
}


def _sync_views(engine) -> None:
    """Create views, recreating any whose definition changed (e.g. env tweak)."""
    with engine.begin() as conn:
        for name, sql in VIEWS.items():
            current = conn.execute(
                text("SELECT sql FROM sqlite_master WHERE type = 'view' AND name = :n"), {"n": name}
            ).scalar()
            if current != sql.strip():
                conn.execute(text(f"DROP VIEW IF EXISTS {name}"))
                conn.execute(text(sql.strip()))


def init_db(db_url: str = DB_PATH):
    engine = create_engine(db_url, echo=False)
    Base.metadata.create_all(engine)
    _sync_views(engine)
    return engine

def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
