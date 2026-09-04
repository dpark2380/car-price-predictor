/**
 * 0–100 scoring (internal):
 *   100 = best deal  →  tier 5
 *   50  = fair price →  tier 2–3
 *   0   = worst deal →  tier 1
 */
export function dealTier(score) {
  const s = score ?? 50;
  if (s >= 90) return 5;
  if (s >= 75) return 4;
  if (s >= 60) return 3;
  if (s >= 45) return 2;
  return 1;
}

export const DEAL_TIER_LABELS = ["Overpriced", "Below fair", "Fair price", "Good deal", "Great deal"];

export function dealTierLabel(score) {
  return DEAL_TIER_LABELS[dealTier(score) - 1];
}

// Returns theme-aware CSS custom properties (defined in theme.css) so deal
// colors adapt to day/night mode and stay WCAG AA compliant in both.
export function getDealColor(score) {
  const s = score ?? 50;
  if (s >= 90) return "var(--color-deal-excellent)";
  if (s >= 75) return "var(--color-deal-good)";
  if (s >= 60) return "var(--color-deal-fair)";
  if (s >= 45) return "var(--color-deal-poor)";
  return "var(--color-deal-bad)";
}
