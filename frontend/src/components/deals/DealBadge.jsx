import React from "react";
import { getDealColor, dealTierLabel } from "../../utils/scoreColor";

/**
 * Deal grade as words with a small fill bar (fuel-gauge style). The words
 * carry the meaning; the colour and bar only reinforce it. Kept to a few DOM
 * nodes: it renders once per row in a list of thousands.
 */
export default function DealBadge({ score, width = 36, height = 6 }) {
  const color = getDealColor(score);
  const pct = score != null ? Math.max(0, Math.min(100, score)) : 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <span
        style={{ position: "relative", display: "inline-block", width, height, borderRadius: 2, background: "var(--color-surface-subtle)", border: "1px solid var(--color-border)", overflow: "hidden", flexShrink: 0 }}
        aria-hidden="true"
      >
        <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: color }} />
      </span>
      <span style={{ fontSize: 13, fontWeight: 600, color, whiteSpace: "nowrap" }}>
        {score != null ? dealTierLabel(score) : "Not graded"}
      </span>
    </span>
  );
}
