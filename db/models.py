from datetime import datetime
from sqlalchemy import (
    create_engine, Column, String, Integer, Float,
    DateTime, Text, Index, UniqueConstraint, text
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
    dealer_name    = Column(String)
    # accident_count, owner_count and dealer_rating are still in the table but
    # were always 0/1/NULL (search results never carry them); no longer written.
    dealer_type    = Column(String)    # franchise / independent
    dealer_phone   = Column(String)
    dealer_street  = Column(String)
    transmission   = Column(String)
    drivetrain     = Column(String)
    fuel_type      = Column(String)
    powertrain_type = Column(String)
    engine_size    = Column(Float)
    cylinders      = Column(Integer)
    doors          = Column(Integer)
    seats          = Column(Integer)
    city_mpg       = Column(Integer)
    highway_mpg    = Column(Integer)
    carfax_1_owner = Column(Integer)   # 1/0 as reported; 0 is "not reported" at independents
    ref_price      = Column(Float)     # price-cut history: display/validation only,
    price_change_percent = Column(Float)  # never price-model features (outcomes of pricing)
    dom_active     = Column(Integer)
    location_city  = Column(String)
    location_state = Column(String)
    location_zip   = Column(String)
    first_seen     = Column(DateTime, default=datetime.utcnow)
    last_seen      = Column(DateTime, default=datetime.utcnow)
    days_listed    = Column(Integer, default=0)
    is_active      = Column(Integer, default=1)
    photo_url      = Column(Text)   # first listing photo (https), shown on the dashboard
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

# Free NHTSA specs for the listing detail page (scraper/vehicle_specs.py), raw
# JSON. ponytail: never refreshed; NHTSA data rarely changes. Add a max age if
# re-decodes start to matter.
class VinSpecs(Base):
    __tablename__ = "vin_specs"
    squish     = Column(String, primary_key=True)   # VIN chars 1-8 + 10
    data       = Column(Text)                       # vPIC fields, {} if none
    fetched_at = Column(DateTime, default=datetime.utcnow)

# Auto.dev photo lookups (scraper/vehicle_photos.py), so a VIN is asked about
# once, not nightly. found=0 rows are retried after RETRY_MISS_DAYS.
class VinPhoto(Base):
    __tablename__ = "vin_photos"
    vin        = Column(String, primary_key=True)
    found      = Column(Integer, nullable=False)    # 1 = photo_url filled from Auto.dev
    fetched_at = Column(DateTime, default=datetime.utcnow)

class ModelSpecs(Base):
    __tablename__ = "model_specs"
    id         = Column(Integer, primary_key=True, autoincrement=True)
    year       = Column(Integer, nullable=False)
    make       = Column(String, nullable=False)     # lowercase
    model      = Column(String, nullable=False)     # lowercase
    dims       = Column(Text)                       # Canadian spec groups
    ratings    = Column(Text)                       # rated variants
    fetched_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("year", "make", "model"),)


DB_PATH = "sqlite:///car_intel.db"

# Listings on market longer than this (Marketcheck `dom`) are excluded from
# training — their asking price is unreliable as a market signal. They are
# still scored; we just don't learn "market" from them.
STALE_LISTING_MAX_DAYS = env_int("STALE_LISTING_MAX_DAYS", 365)
TRAINING_WINDOW_DAYS = 180
# Price floor for both training and scoring: below it the model has no data,
# so a deal score there would be a guess (and tends to read as "100, steal").
MIN_PRICE = 3000

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
            WHERE price BETWEEN {MIN_PRICE} AND 100000
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


def _add_missing_columns(engine) -> None:
    """create_all never alters existing tables: add columns introduced later.
    ponytail: additive nullable columns only; anything else needs a real migration."""
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            have = {row[1] for row in conn.execute(text(f"PRAGMA table_info({table.name})"))}
            for col in table.columns:
                if have and col.name not in have:
                    conn.execute(text(f"ALTER TABLE {table.name} ADD COLUMN {col.name} {col.type.compile(engine.dialect)}"))


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
    # 30 s lock wait (default 5): API reads can briefly block a long backfill's commits
    engine = create_engine(db_url, echo=False, connect_args={"timeout": 30})
    Base.metadata.create_all(engine)
    _add_missing_columns(engine)
    _sync_views(engine)
    return engine

def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
