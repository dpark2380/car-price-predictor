from datetime import datetime, timedelta

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from db.models import Base, CarListing
from db.repository import ListingRepository


def test_only_newest_row_per_vin_stays_active():
    s = sessionmaker(bind=create_engine("sqlite://"))()
    Base.metadata.create_all(s.get_bind())
    now = datetime.utcnow()
    for lid, vin, ago in [("a", "V1", 5), ("b", "V1", 1), ("c", "V2", 3), ("d", "", 2), ("e", "", 1)]:
        s.add(CarListing(listing_id=lid, vin=vin, price=20000, is_active=1, last_seen=now - timedelta(days=ago)))
    s.commit()
    assert ListingRepository(s).mark_stale_inactive(180) == 1
    active = {r.listing_id for r in s.query(CarListing).filter_by(is_active=1)}
    assert active == {"b", "c", "d", "e"}
