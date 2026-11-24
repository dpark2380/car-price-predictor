import { useEffect, useRef, useState } from "react";
import { GRADES, MON, dayMonth, kusd, lin, monthYear, niceTicks, num, pct, usd } from "./format";

// ── Frame: a responsive SVG that measures its container, with a shared tooltip ──
// children(f) draws in pixel space: f.x0..f.x1 is the plot's width, f.y1..f.y0 its height (top..bottom),
// f.hit(x, y, tipNode, ariaText) makes a hover and keyboard target, f.tip/f.untip drive the tooltip by hand.
export function Frame({ label, height, margin, children }) {
  const ref = useRef(null);
  const [W, setW] = useState(0);
  const [tip, setTip] = useState(null);
  useEffect(() => {
    const el = ref.current;
    const measure = () => setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const H = typeof height === "function" ? height(W) : height;
  const f = {
    W, H, x0: margin.l, x1: W - margin.r, y0: H - margin.b, y1: margin.t,
    tip: (x, y, node) => setTip({ x, y, node }),
    untip: () => setTip(null),
    hit(x, y, node, aria) {
      return {
        className: "hit", tabIndex: 0, role: "img", "aria-label": aria,
        onPointerEnter: () => setTip({ x, y, node }), onPointerLeave: () => setTip(null),
        onFocus: () => setTip({ x, y, node }), onBlur: () => setTip(null),
      };
    },
  };
  return (
    <div className="chart" ref={ref} style={{ minHeight: typeof height === "number" ? height : 40 }}>
      {W > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
          {children(f)}
        </svg>
      )}
      {tip && (
        <div className="tip" style={{ left: Math.max(70, Math.min(W - 70, tip.x)), top: Math.max(44, tip.y) }} aria-hidden="true">
          {tip.node}
        </div>
      )}
    </div>
  );
}

const YAxis = ({ f, y, ticks, fmt }) =>
  ticks.map((t) => (
    <g key={t}>
      <line className="grid" x1={f.x0} x2={f.x1} y1={y(t)} y2={y(t)} />
      <text x={f.x0 - 8} y={y(t) + 4} textAnchor="end">{fmt(t)}</text>
    </g>
  ));

const XAxis = ({ f, x, ticks, fmt, dy = 18 }) => (
  <>
    <line className="base" x1={f.x0} x2={f.x1} y1={f.y0} y2={f.y0} />
    {ticks.map((t) => <text key={t} x={x(t)} y={f.y0 + dy} textAnchor="middle">{fmt(t)}</text>)}
  </>
);

// Month starts (and mid-months for short spans) between t0 and t1, thinned to fit.
function timeTicks(t0, t1, max) {
  const spanD = (t1 - t0) / 864e5;
  const d0 = new Date(t0);
  const cands = [];
  for (let i = 0; i < 80; i++) {
    const a = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 1);
    if (a > t1) break;
    cands.push(a);
    if (spanD <= 100) {
      const b = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + i, 15);
      if (b <= t1) cands.push(b);
    }
  }
  let c = cands.filter((t) => t >= t0);
  const step = Math.ceil(c.length / Math.max(max, 2)) || 1;
  c = c.filter((_, i) => i % step === 0);
  if (c.length < 2) c = [t0, (t0 + t1) / 2, t1].map((t) => Math.round(t / 864e5) * 864e5);
  const fmt = spanD <= 100 || c.length < 2 ? dayMonth : monthYear;
  return { ticks: c, fmt };
}

const gapMonths = (a, b) => Math.round((b - a) / (30.4 * 864e5));

// ── Price history ───────────────────────────────────────────────────────────────
// points: [{t, price, miles}] oldest first. A silence over GAP_DAYS is drawn dashed and named.
const GAP_DAYS = 150;

export function StepChart({ points, endT, estimate, errPct, label }) {
  return (
    <Frame label={label} height={290} margin={{ l: 54, r: 14, t: 26, b: 30 }}>
      {(f) => {
        const prices = points.map((p) => p.price);
        const bandLo = estimate != null && errPct != null ? estimate * (1 - errPct / 100) : estimate;
        const bandHi = estimate != null && errPct != null ? estimate * (1 + errPct / 100) : estimate;
        const all = [...prices, ...(estimate != null ? [bandLo, bandHi] : [])];
        const lo = Math.min(...all), hi = Math.max(...all);
        const pad = Math.max((hi - lo) * 0.12, hi * 0.03);
        const { step } = niceTicks(lo - pad, hi + pad, 5);
        const yLo = Math.floor((lo - pad) / step) * step, yHi = Math.ceil((hi + pad) / step) * step;
        const ticks = [];
        for (let t = yLo; t <= yHi + 1e-9; t += step) ticks.push(t);
        const y = lin(yLo, yHi, f.y0, f.y1);
        const t0 = points[0].t, t1 = Math.max(endT, points[points.length - 1].t);
        const span = Math.max(t1 - t0, 864e5 * 7);
        const x = lin(t0 - span * 0.03, t1, f.x0, f.x1);
        const tt = timeTicks(t0, t1, Math.floor(f.W / 90));
        const segs = [[]];
        points.forEach((p, i) => {
          if (i && p.t - points[i - 1].t > GAP_DAYS * 864e5) segs.push([]);
          segs[segs.length - 1].push(p);
        });
        const stepPath = (seg, end) =>
          seg.map((p, i) => (i ? `H${x(p.t)}V${y(p.price)}` : `M${x(p.t)},${y(p.price)}`)).join("") + (end != null ? `H${end}` : "");
        const labelAll = points.length <= 8;
        let lastLabelX = -1e9;
        return (
          <>
            {estimate != null && errPct != null && <rect className="band" x={f.x0} width={f.x1 - f.x0} y={y(bandHi)} height={y(bandLo) - y(bandHi)} />}
            <YAxis f={f} y={y} ticks={ticks} fmt={usd} />
            <XAxis f={f} x={x} ticks={tt.ticks} fmt={tt.fmt} />
            {estimate != null && (
              <>
                <line className="est" x1={f.x0} x2={f.x1} y1={y(estimate)} y2={y(estimate)} />
                <text className="acc" x={f.x1 - 4} y={(errPct != null ? y(bandHi) : y(estimate)) + 15} textAnchor="end">
                  Model estimate {usd(estimate)}{errPct != null ? ` ±${errPct.toFixed(1)}%` : ""}
                </text>
              </>
            )}
            {segs.map((s, i) => {
              const next = segs[i + 1];
              return (
                <g key={i}>
                  {next && <path className="gap" d={`M${x(s[s.length - 1].t)},${y(s[s.length - 1].price)}L${x(next[0].t)},${y(next[0].price)}`} />}
                  <path className="line" d={stepPath(s, next ? undefined : f.x1)} />
                </g>
              );
            })}
            {segs.slice(0, -1).map((s, i) => {
              const a = s[s.length - 1], b = segs[i + 1][0];
              const mid = x(a.t) + 4;
              return (
                <text key={`g${i}`} className="small" x={mid} y={f.y1 + 12}>
                  {`No listing on record for ${gapMonths(a.t, b.t)} months`}
                </text>
              );
            })}
            {points.map((p, i) => {
              const last = i === points.length - 1, cx = x(p.t), cy = y(p.price);
              const prev = i ? points[i - 1].price : null;
              const peak = (prev == null || p.price >= prev) && (i === points.length - 1 || p.price >= points[i + 1].price);
              const showLabel = last || ((labelAll || i === 0) && cx - lastLabelX > 52);
              if (showLabel && !last) lastLabelX = cx;
              const text = `${usd(p.price)} from ${dayMonth(p.t)}${prev != null ? `, ${p.price > prev ? "+" : "−"}${usd(Math.abs(p.price - prev))} (${(((p.price - prev) / prev) * 100).toFixed(1)}%)` : ", first seen"}`;
              return (
                <g key={p.t + "-" + i}>
                  <circle className="pt" cx={cx} cy={cy} r={4.5} />
                  {showLabel && (
                    <text className={last ? "strong" : "lbl"} x={last ? cx : i ? cx + 7 : cx - 2} y={peak && !last ? cy - 9 : cy + 18} textAnchor={last ? "end" : "start"}>
                      {(last ? "Now " : "") + usd(p.price)}
                    </text>
                  )}
                  <circle {...f.hit(cx, cy, <><b>{usd(p.price)}</b> from {dayMonth(p.t)}<br />{prev != null ? `${p.price > prev ? "+" : "−"}${usd(Math.abs(p.price - prev))} (${(((p.price - prev) / prev) * 100).toFixed(1)}%)` : "first seen"}</>, text)} cx={cx} cy={cy} r={16} />
                </g>
              );
            })}
          </>
        );
      }}
    </Frame>
  );
}

export function MilesChart({ points, endT, label }) {
  const pts = points.filter((p) => p.miles != null);
  return (
    <Frame label={label} height={130} margin={{ l: 54, r: 14, t: 22, b: 10 }}>
      {(f) => {
        const top = Math.max(...pts.map((p) => p.miles));
        const { ticks } = niceTicks(0, top * 1.1, 3);
        const y = lin(0, ticks[ticks.length - 1], f.y0, f.y1);
        const t0 = pts[0].t, t1 = Math.max(endT, pts[pts.length - 1].t);
        const x = lin(t0 - (t1 - t0) * 0.03, t1, f.x0, f.x1);
        const segs = [[]];
        pts.forEach((p, i) => {
          if (i && p.t - pts[i - 1].t > GAP_DAYS * 864e5) segs.push([]);
          segs[segs.length - 1].push(p);
        });
        const d = (s) => "M" + s.map((p) => `${x(p.t)},${y(p.miles)}`).join("L");
        return (
          <>
            <YAxis f={f} y={y} ticks={ticks} fmt={(v) => `${v / 1000}k`} />
            <text className="small" x={f.x0} y={10}>Odometer, miles</text>
            {segs.slice(0, -1).map((s, i) => (
              <path key={`g${i}`} className="gap" d={`M${x(s[s.length - 1].t)},${y(s[s.length - 1].miles)}L${x(segs[i + 1][0].t)},${y(segs[i + 1][0].miles)}`} />
            ))}
            {segs.map((s, i) => <path key={i} className="line" d={d(s)} />)}
            {pts.map((p, i) => (
              <g key={i}>
                <circle className="pt" cx={x(p.t)} cy={y(p.miles)} r={4} />
                <circle {...f.hit(x(p.t), y(p.miles), <><b>{num(p.miles)} mi</b> {dayMonth(p.t)}</>, `${num(p.miles)} miles on ${dayMonth(p.t)}`)} cx={x(p.t)} cy={y(p.miles)} r={14} />
              </g>
            ))}
            <text className="lbl" x={x(pts[0].t) - 4} y={y(pts[0].miles) - 10}>{num(pts[0].miles)}</text>
            <text className="strong" x={f.x1} y={y(pts[pts.length - 1].miles) - 10} textAnchor="end">{num(pts[pts.length - 1].miles)}</text>
          </>
        );
      }}
    </Frame>
  );
}

// ── One dot per car at its asking price, with the middle half and median beneath ──
export function DotStrip({ prices, median, p25, p75, mine, band, label }) {
  return (
    <Frame label={label} height={(W) => (W < 520 ? 262 : 222)} margin={{ l: 10, r: 10, t: 34, b: 74 }}>
      {(f) => {
        const lo = Math.min(...prices, mine), hi = Math.max(...prices, mine);
        const { step } = niceTicks(lo, hi, 5);
        const dlo = Math.max(0, Math.floor(lo / (step / 2)) * (step / 2)), dhi = Math.ceil(hi / (step / 2)) * (step / 2);
        const x = lin(dlo, dhi, f.x0, f.x1);
        const { ticks } = niceTicks(dlo, dhi, Math.max(2, Math.floor(f.W / 110)));
        const colW = 8, cols = new Map();
        prices.forEach((p) => {
          const cx = Math.round(x(p) / colW) * colW;
          cols.set(cx, (cols.get(cx) || 0) + 1);
        });
        const maxStack = Math.max(...cols.values());
        const dy = Math.min(8, (f.y0 - f.y1 - 14) / maxStack);
        const seen = new Map();
        const qy = f.y0 + 40, mx = x(mine);
        return (
          <>
            {band && <rect className="band" x={x(band[0])} width={Math.max(x(band[1]) - x(band[0]), 2)} y={f.y1} height={f.y0 - f.y1} />}
            <XAxis f={f} x={x} ticks={ticks} fmt={kusd} />
            {prices.map((p, i) => {
              const cx = Math.round(x(p) / colW) * colW, n = (seen.set(cx, (seen.get(cx) || 0) + 1), seen.get(cx));
              const cy = f.y0 - 7 - (n - 1) * dy;
              return (
                <circle key={i} className="dot" cx={cx} cy={cy} r={3}
                  onPointerEnter={() => f.tip(cx, cy, <b>{usd(p)}</b>)} onPointerLeave={f.untip} />
              );
            })}
            <line className="mark" x1={mx} x2={mx} y1={f.y1 - 8} y2={f.y0} />
            <circle className="pt me" cx={mx} cy={f.y1 - 8} r={5.5} />
            <text className="strong" x={Math.max(60, Math.min(f.W - 60, mx))} y={f.y1 - 20} textAnchor="middle">This car {usd(mine)}</text>
            <rect className="iqr" x={x(p25)} width={Math.max(x(p75) - x(p25), 2)} y={qy - 2} height={4} rx={2} />
            <line className="mark" x1={x(median)} x2={x(median)} y1={qy - 6} y2={qy + 6} />
            <text x={x(p25) - 6} y={qy + 4} textAnchor="end">{usd(p25)}</text>
            <text x={x(p75) + 6} y={qy + 4}>{usd(p75)}</text>
            <text className="lbl" x={Math.max(60, Math.min(f.W - 60, x(median)))} y={qy + 24} textAnchor="middle">Median {usd(median)}</text>
          </>
        );
      }}
    </Frame>
  );
}

// ── Price against mileage for a sample of cars ──
export function Scatter({ points, label }) {
  const [near, setNear] = useState(null);
  return (
    <Frame label={label} height={320} margin={{ l: 44, r: 12, t: 16, b: 44 }}>
      {(f) => {
        const xm = niceTicks(0, Math.max(...points.map((p) => p[1])), 5), ym = niceTicks(0, Math.max(...points.map((p) => p[2])), 4);
        const xmax = xm.ticks[xm.ticks.length - 1] >= Math.max(...points.map((p) => p[1])) ? xm.ticks[xm.ticks.length - 1] : xm.ticks[xm.ticks.length - 1] + xm.step;
        const ymax = ym.ticks[ym.ticks.length - 1] >= Math.max(...points.map((p) => p[2])) ? ym.ticks[ym.ticks.length - 1] : ym.ticks[ym.ticks.length - 1] + ym.step;
        const x = lin(0, xmax, f.x0, f.x1), y = lin(0, ymax, f.y0, f.y1);
        const best = near != null ? points[near] : null;
        return (
          <>
            <YAxis f={f} y={y} ticks={ym.ticks} fmt={kusd} />
            <XAxis f={f} x={x} ticks={xm.ticks} fmt={(v) => `${v / 1000}k`} />
            <text x={(f.x0 + f.x1) / 2} y={f.H - 6} textAnchor="middle">Mileage</text>
            {points.map((p, i) => <circle key={i} className="dot" cx={x(p[1])} cy={y(p[2])} r={2.6} opacity={0.7} />)}
            {best && <circle cx={x(best[1])} cy={y(best[2])} r={6} fill="none" stroke="var(--ink)" strokeWidth={1.5} />}
            <rect
              className="hit" x={f.x0} y={f.y1} width={f.x1 - f.x0} height={f.y0 - f.y1}
              onPointerMove={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                const px = e.clientX - r.left + f.x0, py = e.clientY - r.top + f.y1;
                let bi = null, bd = 400;
                points.forEach((p, i) => {
                  const d = (x(p[1]) - px) ** 2 + (y(p[2]) - py) ** 2;
                  if (d < bd) { bd = d; bi = i; }
                });
                setNear(bi);
                if (bi == null) f.untip();
                else f.tip(x(points[bi][1]), y(points[bi][2]), <><b>{usd(points[bi][2])}</b> {points[bi][0]}<br />{num(points[bi][1])} mi</>);
              }}
              onPointerLeave={() => { setNear(null); f.untip(); }}
            />
          </>
        );
      }}
    </Frame>
  );
}

// ── Median and middle half by model year, with cars listed beneath ──
export function YearRange({ years, label }) {
  const maxN = Math.max(...years.map((d) => d.n));
  return (
    <Frame label={label} height={320} margin={{ l: 44, r: 8, t: 16, b: 24 }}>
      {(f) => {
        const n = years.length, split = f.y0 - 78;
        const bw = (f.x1 - f.x0) / n, cx = (i) => f.x0 + bw * (i + 0.5);
        const top = Math.max(...years.map((d) => d.p75));
        const { ticks } = niceTicks(0, top * 1.05, 3);
        const y = lin(0, ticks[ticks.length - 1], split, f.y1), yc = lin(0, maxN, f.y0, split + 26);
        const every = bw < 26 ? 2 : 1;
        return (
          <>
            <YAxis f={f} y={y} ticks={ticks} fmt={kusd} />
            <text className="small" x={f.x0} y={split + 20}>Cars listed</text>
            <line className="base" x1={f.x0} x2={f.x1} y1={f.y0} y2={f.y0} />
            {years.map((d, i) => {
              const me = d.n === maxN, w = Math.max(4, bw - 4);
              const tip = <><b>{d.year}</b>: median {usd(d.p50)}<br />{usd(d.p25)} to {usd(d.p75)}, {d.n} cars</>;
              return (
                <g key={d.year}>
                  <line className={`whisk${me ? " me" : ""}`} x1={cx(i)} x2={cx(i)} y1={y(d.p25)} y2={y(d.p75)} />
                  <circle className={`pt${me ? " me" : ""}`} cx={cx(i)} cy={y(d.p50)} r={4} />
                  <path className={`bar${me ? " me" : ""}`} d={`M${cx(i) - w / 2},${f.y0}V${yc(d.n) + 3}q0,-3 3,-3h${w - 6}q3,0 3,3V${f.y0}z`} />
                  {i % every === 0 && <text x={cx(i)} y={f.y0 + 17} textAnchor="middle" className={me ? "strong" : ""}>{bw < 40 ? `'${String(d.year).slice(2)}` : d.year}</text>}
                  {me && <text className="strong" x={cx(i)} y={yc(d.n) - 5} textAnchor="middle">{d.n}</text>}
                  <rect {...f.hit(cx(i), y(d.p75), tip, `${d.year}: median ${usd(d.p50)}, middle half ${usd(d.p25)} to ${usd(d.p75)}, ${d.n} cars`)} x={cx(i) - bw / 2} y={f.y1} width={bw} height={f.y0 - f.y1} />
                </g>
              );
            })}
          </>
        );
      }}
    </Frame>
  );
}

// ── Asking prices in $5,000 bands ──
export function Histogram({ bins, p25, median, p75, label }) {
  return (
    <Frame label={label} height={280} margin={{ l: 34, r: 8, t: 40, b: 30 }}>
      {(f) => {
        const w5 = bins.length > 1 ? bins[1].lo - bins[0].lo : 5000;
        const maxN = Math.max(...bins.map((b) => b.n));
        const yt = niceTicks(0, maxN * 1.05, 3);
        const xmax = bins[bins.length - 1].lo + w5, bw = (f.x1 - f.x0) / bins.length;
        const x = lin(0, xmax, f.x0, f.x1), y = lin(0, yt.ticks[yt.ticks.length - 1], f.y0, f.y1);
        const xt = niceTicks(0, xmax, Math.max(2, Math.floor(f.W / 90)));
        const topBin = bins.find((b) => b.n === maxN);
        return (
          <>
            <YAxis f={f} y={y} ticks={yt.ticks} fmt={String} />
            <XAxis f={f} x={x} ticks={xt.ticks} fmt={kusd} />
            {bins.map((b, i) => {
              const me = b === topBin, w = bw - 2, bx = f.x0 + i * bw + 1, top = y(b.n), r = Math.min(4, (f.y0 - top) / 2, w / 2);
              return (
                <g key={b.lo}>
                  {b.n > 0 && <path className={`bar${me ? " me" : ""}`} d={`M${bx},${f.y0}V${top + r}q0,${-r} ${r},${-r}h${w - 2 * r}q${r},0 ${r},${r}V${f.y0}z`} />}
                  <rect {...f.hit(bx + w / 2, top, <><b>{b.n} cars</b><br />{usd(b.lo)} to {usd(b.lo + w5 - 1)}</>, `${b.n} cars from ${usd(b.lo)} to ${usd(b.lo + w5 - 1)}`)} x={bx - 1} y={f.y1} width={bw} height={f.y0 - f.y1} />
                </g>
              );
            })}
            {[p25, p75].map((q) => <line key={q} className="q" x1={x(q)} x2={x(q)} y1={f.y1 - 4} y2={f.y0} />)}
            <line className="mark" x1={x(median)} x2={x(median)} y1={f.y1 - 18} y2={f.y0} strokeDasharray="3 3" />
            <text className="lbl" x={Math.max(50, Math.min(f.W - 50, x(median)))} y={f.y1 - 24} textAnchor="middle">Median {usd(median)}</text>
            <text x={x(p25) - 5} y={f.y1 - 6} textAnchor="end">{usd(p25)}</text>
            <text x={x(p75) + 5} y={f.y1 - 6}>{usd(p75)}</text>
          </>
        );
      }}
    </Frame>
  );
}

// ── Median by month a car was first seen. Months under 5 cars are not drawn; under minN are faded. ──
const MIN_DRAWN = 5;
const monthIndex = (m) => Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7)) - 1;

export function MonthlyMedians({ rows, minN, big, title, label, height }) {
  const drawn = rows.filter((r) => r.n >= MIN_DRAWN);
  const H = height || (big ? 280 : 180);
  return (
    <Frame label={label} height={H} margin={{ l: 40, r: 6, t: title ? 30 : 16, b: big ? 42 : 24 }}>
      {(f) => {
        const first = monthIndex(drawn[0].month), last = monthIndex(drawn[drawn.length - 1].month);
        const slots = [];
        for (let i = first; i <= last; i++) slots.push(i);
        const bw = (f.x1 - f.x0) / slots.length;
        const by = new Map(drawn.map((r) => [monthIndex(r.month), r]));
        const hi = Math.max(...drawn.map((r) => (big ? r.p75 : r.p50)));
        const { ticks } = niceTicks(0, hi * 1.05, big ? 4 : 2);
        const y = lin(0, ticks[ticks.length - 1], f.y0, f.y1);
        return (
          <>
            {title && <text className="strong" x={0} y={12}>{title}</text>}
            <YAxis f={f} y={y} ticks={ticks} fmt={kusd} />
            <line className="base" x1={f.x0} x2={f.x1} y1={f.y0} y2={f.y0} />
            {big && <text className="small" x={f.x0 - 8} y={f.y0 + 34} textAnchor="end">cars</text>}
            {slots.map((s) => {
              const cx = f.x0 + bw * (s - first + 0.5), r = by.get(s), mon = MON[s % 12];
              const yr = Math.floor(s / 12);
              const tickText = bw < 26 ? mon[0] : bw < 38 ? mon.slice(0, 1) : mon;
              if (!r) return <text key={s} className={bw < 26 ? "small" : ""} x={cx} y={f.y0 + 17} textAnchor="middle">{tickText}</text>;
              const thin = r.n < minN;
              const short = "$" + (r.p50 / 1000).toFixed(1) + "k";
              return (
                <g key={s}>
                  <text className={bw < 26 ? "small" : ""} x={cx} y={f.y0 + 17} textAnchor="middle">{tickText}</text>
                  {big && <line className={`whisk${thin ? " thin" : ""}`} x1={cx} x2={cx} y1={y(r.p25)} y2={y(r.p75)} />}
                  <circle className={`pt${thin ? " thin" : " me"}`} cx={cx} cy={y(r.p50)} r={big ? 5 : 4} />
                  {big && <text className={`small${thin ? "" : " lbl"}`} x={cx} y={f.y0 + 34} textAnchor="middle">{r.n}</text>}
                  {big && !thin && <text className="lbl small" x={cx} y={y(r.p75) - 9} textAnchor="middle">{bw < 60 ? short : usd(r.p50)}</text>}
                  {!big && s === last && <text className="lbl small" x={f.x1} y={y(r.p50) - 10} textAnchor="end">{short}</text>}
                  <rect {...f.hit(cx, y(r.p50), <><b>{mon} {yr}</b>: median {usd(r.p50)}<br />{r.n} cars first seen</>, `${mon} ${yr}: median ${usd(r.p50)}, ${r.n} cars first seen`)} x={cx - bw / 2} y={f.y1} width={bw} height={f.y0 - f.y1} />
                </g>
              );
            })}
          </>
        );
      }}
    </Frame>
  );
}

// ── One price axis: a range with its median, this car, and the model's own number ──
export function RangeBar({ lo, hi, median, price, modelNumber, modelRated, label }) {
  return (
    <Frame label={label} height={(W) => (W < 440 ? 238 : 196)} margin={{ l: 2, r: 8, t: 6, b: 26 }}>
      {(f) => {
        const vals = [lo, hi, price, modelNumber].filter((v) => v != null);
        const { step } = niceTicks(Math.min(...vals), Math.max(...vals), 5);
        const dlo = Math.max(0, Math.floor(Math.min(...vals) / step) * step - step), dhi = Math.ceil(Math.max(...vals) / step) * step + step;
        const x = lin(dlo, dhi, f.x0, f.x1);
        const { ticks } = niceTicks(dlo, dhi, Math.max(2, Math.floor(f.W / 90)));
        const narrow = f.W < 440, rowH = narrow ? 64 : 52;
        const row = (i, text, value, extra) => {
          const y = f.y1 + 14 + i * rowH;
          return {
            y: y + (narrow && extra ? 32 : 18),
            node: (
              <g key={i}>
                <text x={f.x0} y={y}>{text + "  "}<tspan className="lbl">{value}</tspan>{extra && !narrow ? <tspan>{"  " + extra}</tspan> : null}</text>
                {extra && narrow && <text className="small" x={f.x0} y={y + 15}>{extra}</text>}
              </g>
            ),
          };
        };
        const rows = [];
        rows.push(row(0, "US middle half", `${usd(lo)} to ${usd(hi)}`, `median ${usd(median)}`));
        rows.push(row(1, "This car", usd(price)));
        if (modelNumber != null) rows.push(row(2, modelRated ? "Model estimate" : "Model's number", usd(modelNumber), modelRated ? null : "unverified"));
        return (
          <>
            {ticks.map((t) => <line key={t} className="grid" x1={x(t)} x2={x(t)} y1={f.y1} y2={f.y0} />)}
            <XAxis f={f} x={x} ticks={ticks} fmt={kusd} />
            {rows.map((r) => r.node)}
            <rect className="bar" x={x(lo)} width={Math.max(x(hi) - x(lo), 2)} y={rows[0].y - 3} height={6} rx={3} />
            <line className="mark" x1={x(median)} x2={x(median)} y1={rows[0].y - 7} y2={rows[0].y + 7} />
            <circle className="pt me" cx={x(price)} cy={rows[1].y} r={6} />
            {modelNumber != null && <circle className={modelRated ? "pt" : "hollow"} cx={x(modelNumber)} cy={rows[2].y} r={6} />}
          </>
        );
      }}
    </Frame>
  );
}

// ── Plain DOM figures ───────────────────────────────────────────────────────────
// rows: [{k, frac (0..1), v, small, me}]
export function Bars({ rows, label }) {
  return (
    <div className="bars" role="img" aria-label={label}>
      {rows.map((r) => (
        <Row key={r.k} r={r} />
      ))}
    </div>
  );
}
const Row = ({ r }) => (
  <>
    <span className="k">{r.k}</span>
    <span className="t"><i className={r.me ? "me" : undefined} style={{ width: `${Math.max(r.frac * 100, 0)}%` }} /></span>
    <span className="v num">{r.v}{r.small ? <> <small>{r.small}</small></> : null}</span>
  </>
);

export function GradeMix({ grades, showPct, label }) {
  const total = GRADES.reduce((s, g) => s + (grades[g.key] || 0), 0);
  const text = GRADES.map((g) => `${num(grades[g.key] || 0)} ${g.label.toLowerCase()}`).join(", ");
  return (
    <>
      <div className="mix" role="img" aria-label={`${label}: ${text}.`}>
        {GRADES.map((g) => (grades[g.key] ? <span key={g.key} className={g.key} style={{ flex: grades[g.key] }} /> : null))}
      </div>
      <ul className="legend">
        {GRADES.map((g) => (
          <li key={g.key}>
            <i className={g.key} />{g.label} <b className="num">{num(grades[g.key] || 0)}</b>
            {showPct && total ? ` ${pct(((grades[g.key] || 0) / total) * 100)}` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

// ── Tables: the same figures as a chart, in a native disclosure that renders on first open ──
export function Table({ head, rows, className, rowHead = true }) {
  return (
    <div className="scroll">
      <table className={className}>
        <thead>
          <tr>{head.map((h, i) => <th key={i} scope="col" className={h.cls}>{h.text ?? h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.cls}>
              {r.cells.map((c, j) => (rowHead && j === 0 ? <th key={j} scope="row">{c}</th> : <td key={j} className={head[j]?.cls}>{c}</td>))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function TableDisclosure({ head, rows, summary = "Show as table" }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="tbl" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && <Table head={head} rows={rows} />}
    </details>
  );
}

