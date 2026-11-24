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
    msrp           = Column(Float)     # as listed; often just the asking price on used cars, so not a model feature (research/marketcheck_mcp_research.md)
    ref_price      = Column(Float)     # price-cut history: display/validation only,
    price_change_percent = Column(Float)  # never price-model features (outcomes of pricing)
    dom_active     = Column(Integer)
    # Listing extras (added 2026-11-24, filled from later scrapes; NULL = not in the feed)
    fees           = Column(Float)     # dealer fees in dollars as listed (one number in the feed); NULL if absent or not a number
    price_includes_fees = Column(Integer)  # 1/0 as reported
    base_ext_color = Column(String)    # colour family from the feed (Gray, Black, ...)
    base_int_color = Column(String)
    interior_color = Column(String)
    is_certified   = Column(Integer)   # 1/0; the feed only sends it for certified cars, so a scraped row holds 0 otherwise
    stock_no       = Column(String)
    dos_active     = Column(Integer)   # days at this dealer's site
    dealer_website = Column(String)
    dealer_msa_code = Column(String)
    overall_length = Column(Float)     # inches
    # The feed's earlier price/odometer with their dates, and when MarketCheck / the listing site
    # first saw the car (UTC): history points for the car page (db/price_history.py), display only.
    ref_price_dt   = Column(DateTime)
    ref_miles      = Column(Integer)
    ref_miles_dt   = Column(DateTime)
    first_seen_at_mc_date     = Column(DateTime)
    first_seen_at_source_date = Column(DateTime)
    location_city  = Column(String)
    location_state = Column(String)
    location_zip   = Column(String)
    first_seen     = Column(DateTime, default=datetime.utcnow)
    last_seen      = Column(DateTime, default=datetime.utcnow)
    days_listed    = Column(Integer, default=0)
    is_active      = Column(Integer, default=1)
    photo_url      = Column(Text)   # first listing photo (https), shown on the dashboard
    photo_urls     = Column(Text)   # JSON list of every usable photo, for the listing page gallery
    __table_args__ = (
        Index("ix_make_model", "make", "model"),
        Index("ix_active", "is_active"),
    )

# One row per listing id, written when it is first seen or its price changes
# (ListingRepository.upsert_listings). A dealer's price cut arrives under a new
# listing id, so no listing has ever held 2 rows; nothing but a test reads this.
# The per-car history lives in VinPriceHistory.
class PriceHistory(Base):
    __tablename__ = "price_history"
    id         = Column(Integer, primary_key=True, autoincrement=True)
    listing_id = Column(String, index=True, nullable=False)
    price      = Column(Float, nullable=False)
    seen_at    = Column(DateTime, default=datetime.utcnow)

class VinPriceHistory(Base):
    """One point per change of a car's asking price or odometer, keyed by VIN (db/price_history.py).
    source: "scrape" (our nightly search), "ref" (the feed's earlier price) or "marketcheck" (reserved for stored full histories)."""
    __tablename__ = "vin_price_history"
    id     = Column(Integer, primary_key=True, autoincrement=True)
    vin    = Column(String, nullable=False)
    date   = Column(DateTime, nullable=False)
    price  = Column(Float, nullable=False)
    miles  = Column(Integer)
    seller = Column(String)
    source = Column(String, nullable=False)
    __table_args__ = (Index("ix_vph_vin_date", "vin", "date"),)

class Prediction(Base):
    __tablename__ = "predictions"
    id              = Column(Integer, primary_key=True, autoincrement=True)
    listing_id      = Column(String, index=True, nullable=False)
    predicted_price = Column(Float)
    deal_score      = Column(Float)
    deal_label      = Column(String)
    model_version   = Column(String)
    scored_at       = Column(DateTime, default=datetime.utcnow)
    # deal_score is NULL ("Not rated") when ml.pipeline._is_rated says so. These three are
    # NULL on rows scored before they were added.
    comparables         = Column(Integer)
    typical_error_pct   = Column(Float)
    cohort_median_price = Column(Float)
    # "national" = a rough rating from US-wide MarketStats (ml.pipeline._national_score), not the model's; NULL otherwise.
    rating_basis        = Column(String)

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


class EngineSpecs(Base):
    """hp and torque found by web search (scripts/specs_search_backfill.py).
    hp/torque are set only when two sites quote the same single rating; else NULL."""
    __tablename__ = "engine_specs"
    id          = Column(Integer, primary_key=True, autoincrement=True)
    year        = Column(Integer, nullable=False)
    make        = Column(String, nullable=False)     # lowercase
    model       = Column(String, nullable=False)     # lowercase
    engine_size = Column(Float, nullable=False)      # litres, 1 decimal
    fuel        = Column(String, nullable=False)     # gas, diesel or hybrid: same size can differ (Duramax 6.6)
    hp          = Column(Integer)
    torque      = Column(Integer)                    # lb-ft
    zero_to_sixty = Column(Float)                    # seconds; set only when two sites quote it within 0.5 s
    sources     = Column(Text)                       # JSON [{url, quote}] backing hp/torque
    raw         = Column(Text)                       # model answer + cited text, for audit
    fetched_at  = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("year", "make", "model", "engine_size", "fuel"),)


class VinHistory(Base):
    """On-demand MarketCheck listing history for one VIN (api.py /api/history): collapsed price steps as JSON.
    rows is NULL while the call is in flight or after it failed; either way it counts toward ON_DEMAND_PER_DAY."""
    __tablename__ = "vin_history"
    vin        = Column(String, primary_key=True)
    fetched_at = Column(DateTime, default=datetime.utcnow)
    rows       = Column(Text)


class VinOptions(Base):
    """On-demand MarketCheck NeoVIN decode extract for one VIN (api.py /api/options): factory options, sticker price, hp/torque/0-60."""
    __tablename__ = "vin_options"
    vin        = Column(String, primary_key=True)
    fetched_at = Column(DateTime, default=datetime.utcnow)
    data       = Column(Text)   # NULL as in VinHistory.rows


class MarketStats(Base):
    """US-wide asking prices for a make/model/year (scripts/market_stats_backfill.py), shown for cars we can't rate."""
    __tablename__ = "market_stats"
    id            = Column(Integer, primary_key=True, autoincrement=True)
    make          = Column(String, nullable=False)   # as in car_listings
    model         = Column(String, nullable=False)
    year          = Column(Integer, nullable=False)
    listing_count = Column(Integer)
    price_median  = Column(Float)
    price_p25     = Column(Float)
    price_p75     = Column(Float)
    fetched_at    = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("make", "model", "year"),)


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
