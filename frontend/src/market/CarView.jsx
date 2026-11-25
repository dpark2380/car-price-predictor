import { useEffect, useState } from "react";
import { DealPill, daysOnSale } from "../components/ui";
import { fmtN } from "../utils/format";
import { getJson, marketPath, useApi } from "./api";
import { DotStrip, MilesChart, RangeBar, StepChart, Table, TableDisclosure } from "./charts";
import { day, dayMonth, dayMonthYear, kusd, num, plural, signedPct, usd } from "./format";
import { Crumbs, ErrorBox, KeyFacts, Section, Skeleton, Src } from "./parts";

const SOURCE = { scrape: "nightly scrape", ref: "dealer's earlier price", marketcheck: "MarketCheck" };

export default function CarView({ vin }) {
  const { data: car, error, reload } = useApi(`/car/${encodeURIComponent(vin)}`);
  useEffect(() => {
    document.title = car ? `${car.year} ${car.make} ${car.model} price history | Car Intel` : "Car | Car Intel";
  }, [car]);
  if (error) return <ErrorBox error={error} onRetry={reload} notFound={error.status === 404 || error.status === 400 ? "We have no current listing for this VIN." : null} back={{ to: "/market", text: "See the market" }} />;
  if (!car) return <Skeleton label="Loading the car" />;
  return <CarPage car={car} reload={reload} />;
}

function CarPage({ car, reload }) {
  const [full, setFull] = useState("idle"); // idle | loading | unavailable | error
  const loadFull = async () => {
    setFull("loading");
    try {
      const h = await getJson(`/history?vin=${encodeURIComponent(car.vin)}`);
      if (h?.available === false) return setFull("unavailable");
      reload();
      setFull("idle");
    } catch {
      setFull("error");
    }
  };

  const name = `${car.year} ${car.make} ${car.model}`;
  const rated = car.deal_score != null;
  const national = car.rating_basis === "national";
  const points = car.history.map((h) => ({ t: day(h.date), price: h.price, miles: h.miles, seller: h.seller, source: h.source }));
  const first = points[0], last = points[points.length - 1];
  const endT = Math.max(Date.now(), last ? last.t : 0);
  const one = points.length < 2;
  const err = car.typical_error_pct;
  const estimate = rated && !national ? car.predicted_price : null;
  const diff = !one ? car.price - first.price : null;
  const milesDiff = !one && first.miles != null && last.miles != null ? last.miles - first.miles : null;
  const since = last ? dayMonth(last.t) : car.first_seen ? dayMonth(day(car.first_seen)) : null;
  const dom = car.days_on_market != null ? daysOnSale({ days_listed: car.days_on_market, last_seen: car.last_seen }) : null; // same count as the listing page
  const atDealer = car.dos_active != null && dom != null && Math.abs(dom - car.dos_active) >= 7 ? car.dos_active : null;
  const m = car.market;
  const hasMiles = new Set(points.filter((p) => p.miles != null).map((p) => p.miles)).size > 1;
  const sources = [...new Set(points.map((p) => p.source))];
  const meta = [car.mileage != null && `${fmtN(car.mileage)} mi`, [car.dealer_name, [car.location_city, car.location_state].filter(Boolean).join(", ")].filter(Boolean).join(", "), `VIN ${car.vin}`].filter(Boolean);
  const cohort = car.cohort;

  const facts = [
    { k: "Asking price", v: usd(car.price), s: since && `since ${since}` },
    rated
      ? national
        ? { k: "US median", v: usd(car.predicted_price), s: m && `${num(m.count)} listed across the US` }
        : { k: "Model estimate", v: usd(car.predicted_price), s: err != null && `usual error ±${err.toFixed(1)}%` }
      : car.model_number != null && { k: "Model's number", v: usd(car.model_number), cls: "unv", s: <span className="pill pill-high">Unverified</span> },
    !rated && m && { k: "US middle half", v: `${kusd(m.p25)} to ${kusd(m.p75)}`, s: `${num(m.count)} listed, median ${usd(m.median)}` },
    !one && {
      k: "Since first seen",
      v: diff === 0 ? "No change" : `${diff < 0 ? "−" : "+"}${usd(Math.abs(diff))}`,
      cls: diff < 0 ? "down" : "",
      s: `${signedPct((diff / first.price) * 100)} since ${dayMonth(first.t)}${milesDiff ? `, ${milesDiff > 0 ? "+" : "−"}${num(Math.abs(milesDiff))} mi` : ""}`,
    },
    dom != null && { k: "On the market", v: `${num(dom)} days`, s: atDealer != null ? `${num(atDealer)} at this dealer` : null },
  ];
  // Four tiles at most: drop the last when a rated, unrated and market combination gives five.
  const tiles = facts.filter(Boolean).slice(0, 4);

  const chartLabel = `Step chart of asking price for one ${name} from ${first ? dayMonthYear(first.t) : ""} to ${dayMonthYear(endT)}: ${points.map((p) => `${usd(p.price)} on ${dayMonth(p.t)}`).join(", ")}.${estimate != null ? ` Model estimate ${usd(estimate)}${err != null ? ` with a usual error of ${err.toFixed(1)}%` : ""}.` : ""}`;

  const rows = [...points].reverse().map((p, i, arr) => {
    const prev = arr[i + 1];
    const ch = prev ? ((p.price - prev.price) / prev.price) * 100 : null;
    return { cells: [dayMonthYear(p.t), usd(p.price), ch == null ? "" : <span className={ch < 0 ? "down" : ""}>{signedPct(ch)}</span>, p.miles != null ? num(p.miles) : "", <span className="src">{SOURCE[p.source] || p.source}</span>] };
  });

  const stripSorted = cohort?.prices || [];
  const strip = cohort && cohort.n >= 5 && stripSorted.length >= 5;
  const nCoh = cohort?.n;

  return (
    <>
      <Crumbs items={[{ text: car.make, to: marketPath(car.make) }, { text: car.model, to: marketPath(car.make, car.model) }, { text: [car.year, car.trim].filter(Boolean).join(" ") }]} />
      <div className="view-head">
        <div>
          <h1 className="page-title">{name}{car.trim ? ` ${car.trim}` : ""}</h1>
          <p className="meta num">{meta.map((t, i) => <span key={i}>{i > 0 && <i />}{t}</span>)}</p>
        </div>
        {/^https?:\/\//i.test(car.url || "") && (
          <a className="btn-quiet" href={car.url} target="_blank" rel="noopener noreferrer">
            View listing<span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </div>

      <section className="panel section first" aria-label="Summary">
        <DealPill score={car.deal_score} />
        {national && <p className="note">Rough rating</p>}
        <KeyFacts items={tiles} />
      </section>

      <Section id="car-h1" title="Price history" src={sources.includes("marketcheck") ? "own DB, MarketCheck" : "own DB"}>
        <div className="panel fig">
          {one ? (
            <div className="empty-inline">
              <strong>{usd(car.price)}{since ? ` since ${since}` : ""}</strong>
              We have seen this car once.{!car.has_full_history && " Load full history to check for earlier listings."}
            </div>
          ) : (
            <>
              <StepChart points={points} endT={endT} estimate={estimate} errPct={err} label={chartLabel} />
              {hasMiles && <MilesChart points={points} endT={endT} label={`Odometer reading at each recorded price, from ${num(first.miles ?? points.find((p) => p.miles != null).miles)} to ${num(last.miles)} miles.`} />}
              <Table className="pts" head={[{ text: "Date" }, { text: "Price" }, { text: "Change" }, { text: "Miles" }, { text: "Source", cls: "l" }]} rows={rows} />
            </>
          )}
          <div className="ctl">
            {car.has_full_history ? (
              <Src>full history stored</Src>
            ) : full === "unavailable" ? (
              <div className="alert" role="alert">Full history isn't available today. {one ? "The price we recorded is shown." : `The ${points.length} prices we recorded are shown.`}</div>
            ) : (
              <>
                <button type="button" className="btn-quiet" onClick={loadFull} disabled={full === "loading"}>{full === "loading" ? "Loading…" : "Load full history"}</button>
                <span>Earlier listings from MarketCheck. Fetched once, then stored.</span>
                {full === "error" && <span className="alert" role="alert">Couldn't load full history. Try again.</span>}
              </>
            )}
          </div>
        </div>
      </Section>

      {strip && (
        <Section id="car-h2" title={`${car.year} ${car.model} asking prices`} src="own DB">
          <div className="panel fig">
            <ul className="legend top">
              <li><i className="dotk" />One of {num(nCoh)} cars listed</li>
              {estimate != null && err != null && <li><i className="bandk" />Model estimate ±{err.toFixed(1)}%</li>}
              <li><i className="iqrk" />Middle half</li>
            </ul>
            <DotStrip
              prices={stripSorted} median={cohort.p50} p25={cohort.p25} p75={cohort.p75} mine={car.price}
              band={estimate != null && err != null ? [estimate * (1 - err / 100), estimate * (1 + err / 100)] : null}
              label={`Dot plot of asking prices for ${num(nCoh)} listed ${plural(name)}. Median ${usd(cohort.p50)}, middle half ${usd(cohort.p25)} to ${usd(cohort.p75)}. This car is at ${usd(car.price)}.`}
            />
            <TableDisclosure
              head={[{ text: "Figure" }, { text: "Asking price" }]}
              rows={[
                { cells: ["Cars we hold, this one included", num(nCoh)] },
                { cells: ["Lowest", usd(stripSorted[0])] },
                { cells: ["Middle half, low", usd(cohort.p25)] },
                { cells: ["Median asking price", usd(cohort.p50)] },
                { cells: ["Middle half, high", usd(cohort.p75)] },
                { cells: ["Highest", usd(stripSorted[stripSorted.length - 1])] },
                { cells: ["This car", usd(car.price)] },
              ]}
            />
          </div>
        </Section>
      )}

      {m && (
        <Section id="car-h3" title="Where the asking price sits" src="MarketCheck">
          <div className="panel fig">
            <RangeBar
              lo={m.p25} hi={m.p75} median={m.median} price={car.price}
              modelNumber={car.model_number} modelRated={rated && !national}
              label={`One price axis: the US middle half for used ${plural(name)}, ${usd(m.p25)} to ${usd(m.p75)} with median ${usd(m.median)}; this car at ${usd(car.price)}${car.model_number != null ? `; the model's ${rated && !national ? "estimate" : "unverified number"} at ${usd(car.model_number)}` : ""}.`}
            />
            <dl className="facts tight">
              <dt>{plural(name)} at other dealers, our data</dt><dd className="num">{num(car.comparables ?? 0)}</dd>
              <dt>{plural(name)} we hold</dt><dd className="num">{num(nCoh ?? 1)}</dd>
              <dt>{plural(name)} listed in the US</dt><dd className="num">{num(m.count)}</dd>
            </dl>
          </div>
        </Section>
      )}
    </>
  );
}
