from datetime import datetime
from sqlalchemy import (
    create_engine, Column, String, Integer, Float,
    DateTime, Text, Index
)
from sqlalchemy.orm import declarative_base, sessionmaker

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

def init_db(db_url: str = DB_PATH):
    engine = create_engine(db_url, echo=False)
    Base.metadata.create_all(engine)
    return engine

def get_session(engine):
    Session = sessionmaker(bind=engine)
    return Session()
