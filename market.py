"""
market.py — read-only aggregates for the Market pages (api.py /api/market/*, /api/car, /api/model-card).
Every figure counts a car once: the latest active row per VIN, at or above the price floor, with its
prediction. Pure functions of that frame, so tests need no database.
"""
import re

import numpy as np
import pandas as pd
from sqlalchemy import text

from db.models import MIN_PRICE
from db.price_history import credible_change

TIERS = ["great", "good", "fair", "high", "over"]
# Same cuts as frontend/src/utils/scoreColor.js (TIER_MIN = [0, 15, 35, 65, 90]): the tier comes from deal_score alone.
TIER_MIN = [(90, "great"), (65, "good"), (35, "fair"), (15, "high"), (0, "over")]
TIER_NUM = {"over": 1, "high": 2, "fair": 3, "good": 4, "great": 5}
DOM_BANDS = [("0-30", 0, 30), ("31-60", 31, 60), ("61-90", 61, 90), ("91-180", 91, 180), ("181-365", 181, 365), ("365+", 366, None)]
COMP_BANDS = [("0", 0, 0), ("1-2", 1, 2), ("3-9", 3, 9), ("10-29", 10, 29), ("30+", 30, None)]
MAX_POINTS = 500
SEED = 42

_SQL = text("""
    SELECT c.id, c.listing_id, c.vin, c.url, c.year, c.make, c.model, c.trim, c.price, c.mileage, c.dealer_name,
           c.location_city, c.location_state, c.first_seen, c.last_seen, c.days_listed, c.dom_active, c.ref_price,
           c.first_seen_at_mc_date, c.photo_url, c.drivetrain, c.dealer_type, c.is_certified,
           c.exterior_color, c.base_ext_color,
           p.predicted_price, p.deal_score, p.deal_label, p.rating_basis, p.comparables, p.typical_error_pct
    FROM car_listings c JOIN predictions p ON p.listing_id = c.listing_id
    WHERE c.is_active = 1 AND c.price >= :floor AND c.year IS NOT NULL AND c.make IS NOT NULL AND c.model IS NOT NULL
""")


# Makes the feed sends in capitals that really are written that way; every other all-caps make is title-cased for display.
_CAPS_MAKES = {"BMW", "GMC", "MINI", "INEOS", "RAM", "INFINITI", "FIAT"}  # official brand styling
_MAKE_NAMES = {"Am General": "AM General"}


def show_make(make):
    make = _MAKE_NAMES.get(make, make)
    return make.title() if isinstance(make, str) and make.isupper() and make not in _CAPS_MAKES else make


def show_dealer(name):
    """Dealer names for display: all-caps names are title-cased and company suffixes are capitals ("Car Shine Auto Sales LLC")."""
    if not isinstance(name, str):
        return name
    if name.isupper():
        name = name.title()
    return re.sub(r"\b(llc|inc|llp|lp)\b", lambda m: m.group(1).upper(), name, flags=re.I)


def latest_per_vin(df: pd.DataFrame) -> pd.DataFrame:
    """One row per car: the newest by last_seen (ties: newest id). A row without a VIN is its own car.
    Rows were not being marked inactive when a dealer's cut re-listed a VIN, so active rows hold duplicates."""
    key = df["vin"].fillna("").where(df["vin"].fillna("") != "", "listing:" + df["listing_id"].astype(str))
    return df.assign(_k=key).sort_values(["last_seen", "id"]).drop_duplicates("_k", keep="last").drop(columns="_k").sort_values("id")


def load_cars(session) -> pd.DataFrame:
    df = pd.read_sql(_SQL, session.connection(), params={"floor": MIN_PRICE}, parse_dates=["first_seen", "last_seen"])
    df = latest_per_vin(df).reset_index(drop=True)
    df["tier"] = df["deal_score"].map(tier)
    df["gap_pct"] = (df["predicted_price"] - df["price"]) / df["predicted_price"] * 100   # + = listed below the estimate
    df["color_family"] = [color_family(b, t) for b, t in zip(df["base_ext_color"], df["exterior_color"])]
    df["make_l"], df["model_l"] = df["make"].str.lower(), df["model"].str.lower()
    df["make"], df["dealer_name"] = df["make"].map(show_make), df["dealer_name"].map(show_dealer)
    return df


# First match wins, so "Black/White" reads black. ponytail: keyword guess, not a colour model.
_COLORS = [("black", "black blk ebony onyx obsidian"), ("white", "white pearl ivory snow blizzard"), ("silver", "silver"),
           ("grey", "gray grey charcoal graphite gunmetal slate"), ("blue", "blue navy"), ("red", "red maroon burgundy crimson"),
           ("green", "green"), ("brown", "brown beige tan bronze champagne gold")]


def color_family(base, text=None) -> str:
    """black, white, silver, grey, blue, red, green, brown or other: from the feed's base colour when present, else the free-text colour."""
    s = str(base if isinstance(base, str) and base.strip() else text if isinstance(text, str) else "").lower()
    return next((fam for fam, words in _COLORS if any(w in s for w in words.split())), "other")


def fuel_family(fuel, powertrain) -> str | None:
    """gas, hybrid, electric, diesel or other from fuel_type and powertrain_type; None when the car has no fuel type."""
    f, p = str(fuel or "").lower(), str(powertrain or "").upper()
    if not f or f == "nan":
        return None
    if "hydrogen" in f:
        return "other"
    if "diesel" in f:
        return "diesel"
    if p in ("HEV", "MHEV", "PHEV", "EREV") or ("electric" in f and "/" in f):
        return "hybrid"
    return "electric" if f == "electric" or p == "BEV" else "gas"


def tier(score) -> str:
    """"great".."over" from deal_score; "nr" (not rated) when it is missing."""
    if score is None or pd.isna(score):
        return "nr"
    return next(name for lo, name in TIER_MIN if score >= lo)


def grade_mix(tiers) -> dict:
    counts = pd.Series(list(tiers), dtype=object).value_counts()
    return {t: int(counts.get(t, 0)) for t in TIERS + ["nr"]}


def band_counts(values, bands) -> list[dict]:
    """[{band, n}] for (label, lo, hi) bands, hi None = open-ended. Missing values are skipped."""
    v = pd.Series(values).dropna()
    return [{"band": label, "n": int(((v >= lo) & (v <= (np.inf if hi is None else hi))).sum())} for label, lo, hi in bands]


def histogram(prices, width: int = 5000) -> list[dict]:
    """[{lo, n}] for contiguous bins of `width` from 0 to the highest price, empty bins included."""
    p = pd.Series(prices).dropna()
    if p.empty:
        return []
    bins = (p // width * width).astype(int).value_counts()
    return [{"lo": lo, "n": int(bins.get(lo, 0))} for lo in range(0, int(bins.index.max()) + width, width)]


def _n(v, nd=None):
    """JSON-safe number: None for NaN; whole numbers as int when nd is None."""
    if v is None or pd.isna(v):
        return None
    return int(round(float(v))) if nd is None else round(float(v), nd)


def quartiles(s: pd.Series, nd=None) -> dict:
    s = s.dropna()
    if s.empty:
        return {"p25": None, "p50": None, "p75": None}
    return {k: _n(v, nd) for k, v in zip(("p25", "p50", "p75"), np.percentile(s, [25, 50, 75]))}


def monthly(df: pd.DataFrame) -> list[dict]:
    """Price quartiles by month of first_seen, oldest first."""
    d = df.dropna(subset=["first_seen"])
    return [{"month": m, "n": int(len(g)), **quartiles(g["price"])}
            for m, g in d.groupby(d["first_seen"].dt.strftime("%Y-%m"))]


def price_changes(df: pd.DataFrame) -> dict:
    """Credible cuts and rises from ref_price (the dealer's earlier price) to the asking price."""
    ch = pd.Series([credible_change(w, n) for w, n in zip(df["ref_price"], df["price"])], index=df.index, dtype=float).dropna()
    cuts = -ch[ch < 0]
    return {"cut_n": int(len(cuts)), "median_cut_pct": _n(cuts.median(), 1), "raised_n": int((ch > 0).sum())}


def makes(df: pd.DataFrame) -> list[dict]:
    return [{"make": g["make"].iloc[0], "n": int(len(g)), "median_price": _n(g["price"].median()),
             "median_gap_pct": _n(g["gap_pct"].median(), 1), "median_dom": _n(g["days_listed"].median())}
            for _, g in sorted(df.groupby("make_l"), key=lambda kv: -len(kv[1]))]


def _model_row(g: pd.DataFrame) -> dict:
    return {"model": g["model"].iloc[0], "n": int(len(g)), **quartiles(g["price"]),
            "median_gap_pct": _n(g["gap_pct"].median(), 1), "median_dom": _n(g["days_listed"].median()),
            "usual_error_pct": _n(g["typical_error_pct"].median(), 1), "unrated": int((g["tier"] == "nr").sum()),
            "median_miles": _n(g["mileage"].median())}


def make_page(df: pd.DataFrame, make: str) -> dict | None:
    d = df[df["make_l"] == make.lower()]
    if d.empty:
        return None
    rows = sorted((_model_row(g) for _, g in d.groupby("model_l")), key=lambda r: -r["n"])
    return {"make": d["make"].iloc[0],
            "summary": {"n": int(len(d)), "models": len(rows), "median_price": _n(d["price"].median()), "median_dom": _n(d["days_listed"].median())},
            "models": rows,
            "dealer_types": {"franchise": int((d["dealer_type"] == "franchise").sum()), "independent": int((d["dealer_type"] == "independent").sum()),
                             "not_stated": int((~d["dealer_type"].isin(["franchise", "independent"])).sum())},
            "monthly": [{"model": r["model"], "months": monthly(d[d["model"] == r["model"]])} for r in rows[:4]]}


SPLIT_MIN_GROUP, CERT_MIN_GROUP = 15, 30


def _splits(d: pd.DataFrame) -> dict:
    """What splits the price: median price and count by drivetrain, colour-family share, certified vs not.
    Groups under 15 cars are dropped; the certified comparison needs 30+ cars in both groups, else None."""
    dt = d.dropna(subset=["drivetrain"]).query("drivetrain != ''")
    by_dt = [{"drivetrain": k, "n": int(len(g)), "median_price": _n(g["price"].median())} for k, g in dt.groupby("drivetrain") if len(g) >= SPLIT_MIN_GROUP]
    col = d["color_family"].value_counts()
    cert = d.dropna(subset=["is_certified"])
    yes, no = cert[cert["is_certified"] == 1], cert[cert["is_certified"] == 0]
    both = len(yes) >= CERT_MIN_GROUP and len(no) >= CERT_MIN_GROUP
    return {"by_drivetrain": sorted(by_dt, key=lambda r: -r["n"]),
            "by_color": [{"color": k, "n": int(v), "share": round(v / len(d), 3)} for k, v in col.items() if v >= SPLIT_MIN_GROUP],
            "certified": {"certified": {"n": len(yes), "median_price": _n(yes["price"].median())},
                          "other": {"n": len(no), "median_price": _n(no["price"].median())}} if both else None}


def model_page(df: pd.DataFrame, make: str, model: str) -> dict | None:
    d = df[(df["make_l"] == make.lower()) & (df["model_l"] == model.lower())]
    if d.empty:
        return None
    sample = d.sample(min(MAX_POINTS, len(d)), random_state=SEED)
    return {
        "make": d["make"].iloc[0], "model": d["model"].iloc[0],
        "summary": {"n": int(len(d)), **{"price_" + k: v for k, v in quartiles(d["price"]).items()},
                    "median_miles": _n(d["mileage"].median()),
                    **{"dom_" + k: v for k, v in quartiles(d["days_listed"]).items()}},
        **_splits(d),
        "by_year": [{"year": int(y), "n": int(len(g)), **quartiles(g["price"])} for y, g in d.groupby("year")],
        "histogram": histogram(d["price"]),
        "dom_bands": band_counts(d["days_listed"], DOM_BANDS),
        "price_changes": price_changes(d),
        "grades": grade_mix(d["tier"]),
        "monthly": monthly(d),
        # [year, miles, price, grade]: grade 1 (overpriced) to 5 (great deal), null when not rated
        "points": [[int(r.year), _n(r.mileage), _n(r.price), TIER_NUM.get(r.tier)] for r in sample.itertuples()],
        "points_total": int(len(d)),
    }


def cohort(df: pd.DataFrame, make: str, model: str, year: int, cap: int = 400) -> dict:
    """Asking prices of the same make/model/year, one per car, with quartiles over all of them."""
    p = df[(df["make_l"] == make.lower()) & (df["model_l"] == model.lower()) & (df["year"] == year)]["price"]
    shown = p.sample(min(cap, len(p)), random_state=SEED) if len(p) else p
    return {"n": int(len(p)), **quartiles(p), "prices": sorted(int(x) for x in shown)}


def merge_history(own: list[dict], stored: list[dict], days: int = 3) -> list[dict]:
    """Own points plus stored MarketCheck steps ({date, price, miles, seller, ...}), oldest first. A MarketCheck
    step is dropped when we hold a point with the same price and miles within `days` days of it."""
    out = list(own)
    for p in stored:
        d = pd.Timestamp(p["date"]) if p.get("date") else None
        if d is None or any((o["price"], o["miles"]) == (p["price"], p["miles"]) and abs((pd.Timestamp(o["date"]) - d).days) <= days for o in own):
            continue
        out.append({"date": p["date"], "price": p["price"], "miles": p["miles"], "seller": p.get("seller"), "source": "marketcheck"})
    return sorted(out, key=lambda p: p["date"])


def card_live(df: pd.DataFrame) -> dict:
    """Live counts for the model card: grade mix, why cars are not rated, median |gap| by comparables."""
    nr = df[df["tier"] == "nr"]
    c = df["comparables"]
    return {
        "cars_listed": int(len(df)),
        "grades": grade_mix(df["tier"]),
        "not_rated": {"no_comparables": int((nr["comparables"] < 1).sum()),
                      "thin_extreme_score": int((nr["comparables"] >= 1).sum()),
                      "unknown": int(nr["comparables"].isna().sum()),
                      "rated_from_national": int((df["rating_basis"] == "national").sum())},
        "gap_by_comparables": [{"band": label, "n": int(m.sum()), "median_abs_gap_pct": _n(df.loc[m, "gap_pct"].abs().median(), 1)}
                               for label, lo, hi in COMP_BANDS for m in [(c >= lo) & (c <= (np.inf if hi is None else hi))]],
    }
