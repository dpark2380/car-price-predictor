/**
 * deal_score (0–100) from the API: 50 = priced at the market estimate. The
 * distance from 50 is measured in units of the model's typical error at that
 * price (ml/pipeline.py _deal_score_from_prices), so the bands are symmetric
 * around fair and anything within about one typical error counts as fair.
 *
 *   tier 5  Great deal   >= 90   (discount >= 3x the model's typical error)
 *   tier 4  Good deal    65–90
 *   tier 3  Fair price   35–65
 *   tier 2  High price   15–35
 *   tier 1  Overpriced   < 15
 */
const TIER_MIN = [0, 15, 35, 65, 90];

export const DEAL_TIER_LABELS = ["Overpriced", "High price", "Fair price", "Good deal", "Great deal"];

export function dealTier(score) {
  const s = score ?? 50;
  let tier = 1;
  TIER_MIN.forEach((min, i) => {
    if (s >= min) tier = i + 1;
  });
  return tier;
}

export function dealTierLabel(score) {
  return DEAL_TIER_LABELS[dealTier(score) - 1];
}
