import { useState } from "react";
import { dealTier, dealTierLabel } from "../utils/scoreColor";
import { fmt$, fmtN, normalizeBodyType } from "../utils/format";

const PILL_CLASS = ["pill-over", "pill-high", "pill-fair", "pill-good", "pill-great"];

export function DealPill({ score }) {
  if (score == null) return null;
  return <span className={`pill ${PILL_CLASS[dealTier(score) - 1]}`}>{dealTierLabel(score)}</span>;
}

// "$6,125 below market" reads the right way round; a signed "Savings" did not.
export function vsMarket(savings) {
  if (savings == null) return { text: "", cls: "at" };
  if (Math.abs(savings) < 50) return { text: "At market value", cls: "at" };
  return savings > 0
    ? { text: `${fmt$(savings)} below market`, cls: "below" }
    : { text: `${fmt$(-savings)} above market`, cls: "above" };
}

/**
 * Where the asking price sits against similar cars. deal_score is 50 at the
 * market estimate and moves 40 points per 3 typical model errors, so the
 * middle third (scores 35–65) is the "fair" band and the marker runs from
 * well below market (left) to well above (right).
 */
export function PriceBar({ score }) {
  if (score == null) return null;
  const pos = Math.min(98, Math.max(2, 50 - (score - 50)));
  return (
    <div className="pricebar" aria-hidden="true">
      <div className="pricebar-track">
        <span className="pricebar-mark" style={{ left: `${pos}%` }} />
      </div>
      <div className="pricebar-legend">
        <span>Below market</span>
        <span>Above</span>
      </div>
    </div>
  );
}

// Plain side-on car outline for listings without a photo yet.
function CarOutline() {
  return (
    <svg width="96" height="40" viewBox="0 0 96 40" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 29V22c0-2 1.5-3.4 3.5-3.8L24 15l10-8.5c1.3-1.1 3-1.5 4.6-1.5H58c2 0 3.8.8 5 2.3L72 15l13.5 2.4c2.6.5 4.5 2.7 4.5 5.3V29" />
      <path d="M6 29h8M34 29h28M82 29h8" />
      <circle cx="24" cy="30" r="7" />
      <circle cx="72" cy="30" r="7" />
      <path d="M36 15h28M48 6v9" />
    </svg>
  );
}

function Photo({ src, alt }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <CarOutline />;
  return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function ListingCard({ deal }) {
  const name = `${deal.year} ${deal.make} ${deal.model}`;
  const vm = vsMarket(deal.savings);
  const sub = [deal.trim, normalizeBodyType(deal.body_type)].filter((v) => v && v !== "Unknown").join(", ");
  const place = [deal.location_city, deal.location_state].filter(Boolean).join(", ");
  return (
    <article className="card">
      <div className="card-photo">
        <Photo src={deal.photo_url} alt={name} />
        <DealPill score={deal.deal_score} />
      </div>
      <div className="card-body">
        <h3 className="card-title">
          {deal.url ? (
            <a href={deal.url} target="_blank" rel="noopener noreferrer">
              {name}
              <span className="sr-only"> (opens the dealer's listing in a new tab)</span>
            </a>
          ) : (
            name
          )}
        </h3>
        {sub && <div className="card-sub">{sub}</div>}
        <div className="card-price num">{fmt$(deal.price)}</div>
        <div className={`card-market num ${vm.cls}`}>{vm.text}</div>
        <div className="card-value num">Market value {fmt$(deal.predicted_price)}</div>
        <PriceBar score={deal.deal_score} />
        <div className="card-specs">
          <span className="num">{fmtN(deal.mileage)} mi</span>
          {place && <span>{place}</span>}
        </div>
      </div>
    </article>
  );
}

export function CardSkeleton() {
  return (
    <div className="card" aria-hidden="true">
      <div className="card-photo skeleton" style={{ borderRadius: 0 }} />
      <div className="card-body" style={{ gap: 10 }}>
        <div className="skeleton" style={{ height: 18, width: "70%" }} />
        <div className="skeleton" style={{ height: 24, width: "40%" }} />
        <div className="skeleton" style={{ height: 14, width: "85%" }} />
      </div>
    </div>
  );
}

export function BrandMark() {
  // A speedometer needle at "fair": the product's one idea, as a mark.
  return (
    <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">
      <path d="M3 15a10 10 0 0 1 20 0" fill="none" stroke="var(--line-strong)" strokeWidth="3" strokeLinecap="round" />
      <path d="M3 15a10 10 0 0 1 6.2-9.2" fill="none" stroke="var(--deal-great)" strokeWidth="3" strokeLinecap="round" />
      <path d="M13 15 18 7" stroke="var(--ink)" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="13" cy="15" r="2.4" fill="var(--ink)" />
    </svg>
  );
}

const THEME_KEY = "carintel-theme";

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("theme-dark"));
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("theme-dark", next);
    try {
      localStorage.setItem(THEME_KEY, next ? "dark" : "light");
    } catch (e) {}
  };
  return (
    <button className="icon-btn" onClick={toggle} aria-label={dark ? "Use light theme" : "Use dark theme"} title={dark ? "Light theme" : "Dark theme"}>
      {dark ? (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
          <path d="M21 13.5A8.5 8.5 0 1 1 10.5 3a6.6 6.6 0 0 0 10.5 10.5Z" />
        </svg>
      )}
    </button>
  );
}
