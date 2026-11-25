export const usd = (v) => (v == null ? "—" : `$${Math.round(v).toLocaleString("en-US")}`);
export const kusd = (v) => `$${Math.round(v / 1000)}k`;
export const num = (v) => (v == null ? "—" : Math.round(v).toLocaleString("en-US"));
export const pct = (v, d = 1) => (v == null ? "—" : `${v.toFixed(d)}%`);
export const signedPct = (v, d = 1) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(d)}%`);
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const day = (s) => Date.parse(`${s}T00:00:00Z`);
export const dayMonth = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
export const dayMonthYear = (t) => `${dayMonth(t)} ${new Date(t).getUTCFullYear()}`;
export const monthYear = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
export const lin = (a, b, c, d) => (v) => (b === a ? (c + d) / 2 : c + ((v - a) / (b - a)) * (d - c));
// "Ram" + "Ram 1500" is "Ram 1500", not "Ram Ram 1500".
export const carName = (make, model) => (String(model).toLowerCase().startsWith(String(make).toLowerCase()) ? `${make}${String(model).slice(String(make).length)}` : `${make} ${model}`);
export const plural = (name) => (/s$/i.test(name) ? name : `${name}s`);

// Axis ticks on round values: about n of them covering lo..hi.
export function niceTicks(lo, hi, n = 4) {
  const raw = Math.max(hi - lo, 1) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || mag * 10;
  const out = [];
  const top = Math.ceil(hi / step - 1e-9) * step; // the last tick is never below hi
  for (let t = Math.ceil(lo / step) * step; t <= top + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return { ticks: out, step };
}

// The five deal tiers, best first, then unrated.
export const GRADES = [
  { key: "great", label: "Great deal" },
  { key: "good", label: "Good deal" },
  { key: "fair", label: "Fair price" },
  { key: "high", label: "High price" },
  { key: "over", label: "Overpriced" },
  { key: "nr", label: "Not rated" },
];
