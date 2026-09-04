import React from "react";
import { getDealColor } from "../../utils/scoreColor";

/**
 * Compact deal-score readout: a fill bar (fuel-gauge style) plus the
 * numeral. Deliberately just two DOM nodes (track + fill) — this renders
 * once per row in a list that can hold thousands of listings, so a heavier
 * multi-segment markup here directly costs scroll performance.
 */
export default function DealBadge({ score, width = 44, height = 7, showValue = true }) {
  const color = getDealColor(score);
  const pct = score != null ? Math.max(0, Math.min(100, score)) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        style={{ position: "relative", display: "inline-block", width, height, borderRadius: 2, background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", overflow: "hidden" }}
        aria-hidden="true"
      >
        <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: color }} />
      </span>
      {showValue && (
        <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 12, fontWeight: 600, color }}>
          {score != null ? Math.round(score) : "—"}
        </span>
      )}
    </span>
  );
}
