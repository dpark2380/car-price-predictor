"""
scripts/score_audit.py — Show score distribution and worst-scoring listings.
Run: PYTHONPATH=. python3 scripts/score_audit.py
"""
from db.models import init_db, get_session
from db.repository import ListingRepository, PredictionRepository

session = get_session(init_db())
listings_df = ListingRepository(session).get_active_listings_df()
preds_df    = PredictionRepository(session).get_top_deals(limit=99999, min_deal_score=0)

df = listings_df.merge(
    preds_df[["listing_id", "predicted_price", "deal_score", "deal_label"]],
    on="listing_id",
    how="inner",
)
df["savings"] = df["predicted_price"] - df["price"]

print(f"\nTotal scored listings: {len(df)}")
print(f"Positive savings:      {(df['savings'] > 0).sum()}")
print(f"Negative savings:      {(df['savings'] < 0).sum()}")

print("\n--- Savings distribution ---")
print(df["savings"].describe().apply(lambda x: f"${x:,.0f}"))

print("\n--- Deal score distribution ---")
bins = [(0, 45, "1★"), (45, 60, "2★"), (60, 75, "3★"), (75, 90, "4★"), (90, 101, "5★")]
for lo, hi, label in bins:
    n = ((df["deal_score"] >= lo) & (df["deal_score"] < hi)).sum()
    print(f"  {label}  ({lo}–{hi}): {n} listings")

print("\n--- 20 worst-scoring listings ---")
worst = (
    df.sort_values("deal_score")
    .head(20)[["year", "make", "model", "trim", "price", "predicted_price", "savings", "deal_score"]]
)
worst["savings"] = worst["savings"].apply(lambda x: f"${x:,.0f}")
worst["price"]   = worst["price"].apply(lambda x: f"${x:,.0f}")
worst["predicted_price"] = worst["predicted_price"].apply(lambda x: f"${x:,.0f}")
worst["deal_score"] = worst["deal_score"].apply(lambda x: f"{x:.1f}")
print(worst.to_string(index=False))
