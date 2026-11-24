"""Per-VIN price history. record_point is called for every listing the nightly scrape sees
(ListingRepository.upsert_listings); scripts/backfill_price_history.py seeds it from older rows."""
from sqlalchemy.orm import Session

from db.models import VinPriceHistory

# Earlier prices from the feed are junk-prone (a $999,900 ref_price on a $9,999 car). Believe only
# changes of 1-40% of the larger of the two prices, up or down (api.py _reduced uses the same bounds for cuts).
MIN_CHANGE_PCT, MAX_CHANGE_PCT = 1, 40


def credible_change(was, now) -> float | None:
    """Signed % change from `was` to `now` (negative = cut) when the pair is believable, else None."""
    if not was or not now or was <= 0 or now <= 0:
        return None
    if not MIN_CHANGE_PCT <= abs(was - now) / max(was, now) * 100 <= MAX_CHANGE_PCT:
        return None
    return round((now - was) / was * 100, 1)


def record_point(session: Session, data: dict, when) -> None:
    """data: a mapped listing. Append (when, price, miles) when it differs from the VIN's latest point
    (a first sighting is the first point), then the feed's earlier price as a "ref" point when it is
    dated before our first point and believably different from it."""
    vin, price, miles = data.get("vin"), data.get("price"), data.get("mileage")
    if not vin or not price:
        return
    q = session.query(VinPriceHistory).filter_by(vin=vin)
    last = q.order_by(VinPriceHistory.date.desc(), VinPriceHistory.id.desc()).first()
    if last is None or (last.price, last.miles) != (price, miles):
        session.add(VinPriceHistory(vin=vin, date=when, price=price, miles=miles, seller=data.get("dealer_name"), source="scrape"))
    ref_price, ref_dt = data.get("ref_price"), data.get("ref_price_dt")
    if ref_price and ref_dt:
        first = q.order_by(VinPriceHistory.date, VinPriceHistory.id).first()   # autoflush: includes the point above
        if ref_dt < first.date and credible_change(ref_price, first.price) is not None:
            session.add(VinPriceHistory(vin=vin, date=ref_dt, price=ref_price, miles=data.get("ref_miles"),
                                        seller=data.get("dealer_name"), source="ref"))
