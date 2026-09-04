import { useEffect, useRef, useState } from "react";
import { getDealColor } from "../../utils/scoreColor";

/**
 * Semicircular arc gauge, styled after a speedometer/fuel gauge: a swept
 * track, a needle, and tick marks at the quartiles. The needle sweeps once
 * from zero on mount — the page's one deliberate motion moment — and holds
 * still afterward. Respects prefers-reduced-motion by skipping the sweep.
 */
export default function ArcGauge({ value = 0, size = 220, label, sublabel }) {
  const r = size * 0.42;
  const cx = size / 2;
  const cy = size / 2 + r * 0.12;
  const circumference = Math.PI * r;
  const viewBoxH = cy + size * 0.06;

  const [animated, setAnimated] = useState(0);
  const reduceMotion = useRef(
    typeof window !== "undefined" &&
      !!window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );

  useEffect(() => {
    if (reduceMotion.current) {
      setAnimated(value);
      return;
    }
    let raf;
    const start = performance.now();
    const duration = 1000;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setAnimated(value * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const pct = Math.max(0, Math.min(100, animated));
  const angleDeg = 180 - (pct / 100) * 180;
  const angleRad = (angleDeg * Math.PI) / 180;
  const needleLen = r * 0.82;
  const nx = cx + needleLen * Math.cos(angleRad);
  const ny = cy - needleLen * Math.sin(angleRad);

  const ticks = [0, 25, 50, 75, 100].map((t) => {
    const a = ((180 - (t / 100) * 180) * Math.PI) / 180;
    return {
      t,
      x1: cx + (r + 3) * Math.cos(a),
      y1: cy - (r + 3) * Math.sin(a),
      x2: cx + (r + 11) * Math.cos(a),
      y2: cy - (r + 11) * Math.sin(a),
    };
  });

  const color = getDealColor(value);
  const strokeW = size * 0.055;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <svg width={size} height={viewBoxH} viewBox={`0 0 ${size} ${viewBoxH}`} role="img" aria-label={label ? `${label}: ${Math.round(value)} of 100` : `${Math.round(value)} of 100`}>
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`}
          fill="none"
          stroke="var(--color-border)"
          strokeWidth={strokeW}
          strokeLinecap="round"
        />
        <path
          d={`M ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}`}
          fill="none"
          stroke={color}
          strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        />
        {ticks.map((tk) => (
          <line key={tk.t} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke="var(--color-border-strong)" strokeWidth={2} />
        ))}
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="var(--color-text-primary)" strokeWidth={2.5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={size * 0.032} fill="var(--color-text-primary)" />
      </svg>
      <div
        style={{
          fontFamily: "'Overpass', sans-serif",
          fontWeight: 800,
          fontSize: size * 0.155,
          color,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          marginTop: -size * 0.06,
        }}
      >
        {Math.round(pct)}
      </div>
      {label && (
        <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 13, color: "var(--color-text-secondary)", textAlign: "center" }}>
          {label}
        </div>
      )}
      {sublabel && (
        <div style={{ fontFamily: "'Public Sans', sans-serif", fontSize: 11.5, color: "var(--color-text-subtle)", textAlign: "center" }}>
          {sublabel}
        </div>
      )}
    </div>
  );
}
