import { useEffect } from "react";
import { fmtN } from "../utils/format";
import { marketPath, seg, useApi } from "./api";
import { Bars, GradeMix, Histogram, MonthlyMedians, Scatter, Table, TableDisclosure, YearRange } from "./charts";
import { GRADES, MON, num, plural, usd } from "./format";
import { Crumbs, ErrorBox, Fig, KeyFacts, Link, Skeleton } from "./parts";

// Distribution charts need enough cars to mean something; below this only the figures are shown.
export const MIN_CARS = 30;
const FULL_MONTH = 100;

const bandLabel = (b) => (b === "365+" ? "Over a year" : b.replace("-", " to "));
const NUMBERS = ["no", "one", "two", "three"];

// A chart with its figures in a disclosure, or just the figures for a thin model.
function Figure({ thin, chart, head, rows }) {
  if (thin) return <Table head={head} rows={rows} className="compact" />;
  return (
    <>
      {chart}
      <TableDisclosure head={head} rows={rows} />
    </>
  );
}

export default function ModelView({ make: makeIn, model: modelIn }) {
  const { data: d, error, reload } = useApi(`/market/model/${seg(makeIn)}/${modelIn.split("/").map(seg).join("/")}`);
  useEffect(() => {
    document.title = d ? `${d.make} ${d.model} prices | Car Intel` : "Model | Car Intel";
  }, [d]);
  if (error) return <ErrorBox error={error} onRetry={reload} notFound={`We have no listings for ${makeIn} ${modelIn}.`} back={{ to: "/market", text: "See all brands" }} />;
  if (!d) return <Skeleton label="Loading the model" />;
  return <ModelPage d={d} />;
}

function ModelPage({ d }) {
  const { make, model, summary: s, by_drivetrain = [], by_color = [], certified } = d;
  const topDrive = Math.max(...by_drivetrain.map((r) => r.median_price), 1);
  const name = `${make} ${model}`;
  const thin = s.n < MIN_CARS;
  const maxYear = d.by_year.reduce((a, b) => (b.n > a.n ? b : a), d.by_year[0]);
  const chartYears = d.by_year.filter((y) => y.year >= 2010);
  const domMax = Math.max(...d.dom_bands.map((b) => b.n), 1);
  const topBin = d.histogram.reduce((a, b) => (b.n > a.n ? b : a), d.histogram[0]);
  const pc = d.price_changes;
  const drawnMonths = d.monthly.filter((m) => m.n >= 5);
  const fullMonths = d.monthly.filter((m) => m.n >= FULL_MONTH).length;
  const pts = d.points;
  const listings = `/listings?make=${encodeURIComponent(make.toLowerCase())}&model=${encodeURIComponent(model.toLowerCase())}`;
  const mon = (m) => `${MON[Number(m.month.slice(5)) - 1]} ${m.month.slice(0, 4)}`;

  return (
    <>
      <Crumbs items={[{ text: make, to: marketPath(make) }, { text: model }]} />
      <div className="view-head">
        <h1 className="page-title">{name}</h1>
        <Link className="btn-quiet" to={listings}>View {fmtN(s.n)} {s.n === 1 ? "listing" : "listings"}</Link>
      </div>
      <section className="panel section first" aria-label="Summary">
        <KeyFacts
          items={[
            { k: "Cars listed", v: num(s.n) },
            { k: "Median asking price", v: usd(s.price_p50), s: s.n > 1 ? `${usd(s.price_p25)} to ${usd(s.price_p75)}` : null },
            { k: "Median mileage", v: s.median_miles != null ? `${num(s.median_miles)} mi` : "—" },
            { k: "Median days on market", v: s.dom_p50 != null ? num(s.dom_p50) : "—", s: s.dom_p25 != null && s.n > 1 ? `${num(s.dom_p25)} to ${num(s.dom_p75)}` : null },
          ]}
        />
      </section>

      {(by_drivetrain.length >= 2 || by_color.length >= 2) && (
        <section className="section">
          <Fig title="What splits the price" src="own DB">
            {by_drivetrain.length >= 2 && (
              <>
                <h3 className="gapped">Drivetrain</h3>
                <Bars
                  label={`Median asking price by drivetrain: ${by_drivetrain.map((r) => `${r.drivetrain} ${usd(r.median_price)} from ${num(r.n)} cars`).join(", ")}.`}
                  rows={by_drivetrain.map((r) => ({ k: r.drivetrain, frac: r.median_price / topDrive, v: usd(r.median_price), small: `${num(r.n)} cars` }))}
                />
                <TableDisclosure head={[{ text: "Drivetrain" }, { text: "Cars" }, { text: "Median price" }]} rows={by_drivetrain.map((r) => ({ cells: [r.drivetrain, num(r.n), usd(r.median_price)] }))} />
                <p className="note">Drivetrains with fewer than 15 cars are left out.</p>
              </>
            )}
            {by_color.length >= 2 && (
              <>
                <h3 className="gapped">Colour</h3>
                <div className="mix" role="img" aria-label={`Colour share: ${by_color.map((c) => `${c.color} ${Math.round(c.share * 100)}%`).join(", ")}.`}>
                  {by_color.map((c) => <span key={c.color} style={{ flex: c.n, background: `var(--c-${c.color})`, boxShadow: "inset 0 0 0 1px var(--rule)" }} />)}
                </div>
                <ul className="legend">
                  {by_color.map((c) => <li key={c.color}><i style={{ background: `var(--c-${c.color})`, boxShadow: "inset 0 0 0 1px var(--control)" }} />{c.color.charAt(0).toUpperCase() + c.color.slice(1)} <b className="num">{Math.round(c.share * 100)}%</b></li>)}
                </ul>
              </>
            )}
          </Fig>
        </section>
      )}

      {certified && (
        <section className="section">
          <Fig title="Certified against not certified" src="own DB">
            <Table
              className="compact"
              head={[{ text: "Group" }, { text: "Cars" }, { text: "Median price" }]}
              rows={[["Certified", certified.certified], ["Not certified", certified.other]].map(([k, g]) => ({ cells: [k, num(g.n), usd(g.median_price)] }))}
            />
          </Fig>
        </section>
      )}

      {!thin && pts.length > 0 && (
        <section className="section">
          <div className="two">
            <Fig title="Price vs mileage" src={`own DB, ${pts.length < d.points_total ? `${num(pts.length)} of ${num(d.points_total)}` : num(pts.length)}`}>
              <Figure
                chart={<Scatter points={pts} label={`Scatter plot of asking price against mileage for ${num(pts.length)} ${plural(name)}.`} />}
                head={[{ text: "Model year" }, { text: "Miles" }, { text: "Asking price" }]}
                rows={pts.map((p) => ({ cells: [p[0], num(p[1]), usd(p[2])] }))}
              />
            </Fig>
            <Fig title="Price by model year" src="own DB">
              <ul className="legend top"><li><i className="medk" />Median</li><li><i className="iqrk v" />Middle half</li><li><i className="bark" />Cars listed</li></ul>
              <Figure
                chart={
                  <YearRange
                    years={chartYears.length >= 3 ? chartYears : d.by_year}
                    label={`Median and middle half of ${model} asking price by model year ${(chartYears.length >= 3 ? chartYears : d.by_year)[0].year} to ${d.by_year[d.by_year.length - 1].year}, with cars listed per year beneath. ${maxYear.year} has the most at ${maxYear.n}.`}
                  />
                }
                head={[{ text: "Model year" }, { text: "Cars" }, { text: "Low" }, { text: "Median" }, { text: "High" }]}
                rows={d.by_year.map((y) => ({ cells: [y.year, num(y.n), usd(y.p25), usd(y.p50), usd(y.p75)] }))}
              />
            </Fig>
          </div>
        </section>
      )}

      {thin && (
        <section className="section">
          <Fig title="Price by model year" src="own DB">
            <Table
              className="compact"
              head={[{ text: "Model year" }, { text: "Cars" }, { text: "Low" }, { text: "Median" }, { text: "High" }]}
              rows={d.by_year.map((y) => ({ cells: [y.year, num(y.n), usd(y.p25), usd(y.p50), usd(y.p75)] }))}
            />
          </Fig>
        </section>
      )}

      <section className="section">
        <div className={thin ? "stack" : "two"}>
          {!thin && (
            <Fig title="Asking price" src="own DB">
              <Figure
                chart={<Histogram bins={d.histogram} p25={s.price_p25} median={s.price_p50} p75={s.price_p75} label={`Histogram of ${model} asking prices in $5,000 bands, peaking at ${num(topBin.n)} cars between ${usd(topBin.lo)} and ${usd(topBin.lo + 5000)}. Median ${usd(s.price_p50)}, middle half ${usd(s.price_p25)} to ${usd(s.price_p75)}.`} />}
                head={[{ text: "Asking price" }, { text: "Cars" }]}
                rows={d.histogram.map((b) => ({ cells: [`${usd(b.lo)} to ${usd(b.lo + 4999)}`, num(b.n)] }))}
              />
            </Fig>
          )}
          <Fig title="Days on market" src="own DB">
            {thin ? (
              <Table className="compact" head={[{ text: "Days" }, { text: "Cars" }]} rows={d.dom_bands.map((b) => ({ cells: [bandLabel(b.band), num(b.n)] }))} />
            ) : (
              <>
                <Bars
                  label={`Days on market: ${d.dom_bands.map((b) => `${num(b.n)} cars at ${bandLabel(b.band).toLowerCase()}`).join(", ")}.`}
                  rows={d.dom_bands.map((b) => ({ k: bandLabel(b.band), frac: b.n / domMax, v: num(b.n) }))}
                />
                <TableDisclosure head={[{ text: "Days" }, { text: "Cars" }]} rows={d.dom_bands.map((b) => ({ cells: [bandLabel(b.band), num(b.n)] }))} />
              </>
            )}
            <h3 className="gapped">Price changes</h3>
            <dl className="facts tight">
              <dt>Price cut</dt><dd className="num">{num(pc.cut_n)} {pc.cut_n === 1 ? "car" : "cars"} ({Math.round((pc.cut_n / s.n) * 100)}%)</dd>
              {pc.median_cut_pct != null && <><dt>Median cut</dt><dd className="num">{pc.median_cut_pct.toFixed(1)}%</dd></>}
              <dt>Price raised</dt><dd className="num">{num(pc.raised_n)} {pc.raised_n === 1 ? "car" : "cars"}</dd>
            </dl>
          </Fig>
        </div>
      </section>

      <section className="section">
        <Fig title="Grades" src="own DB">
          <GradeMix grades={d.grades} label="Grades" />
          <TableDisclosure head={[{ text: "Grade" }, { text: "Cars" }]} rows={GRADES.map((g) => ({ cells: [g.label, num(d.grades[g.key] || 0)] }))} />
        </Fig>
      </section>

      {!thin && drawnMonths.length >= 2 && (
        <section className="section">
          <Fig title="Median price by month first seen" src="own DB">
            <ul className="legend top"><li><i className="medk a" />Median</li><li><i className="iqrk v" />Middle half</li><li><i className="medk thin" />Under {FULL_MONTH} cars</li></ul>
            <Figure
              chart={<MonthlyMedians rows={d.monthly} minN={FULL_MONTH} big label={`Median ${model} asking price by month first seen, ${mon(drawnMonths[0])} to ${mon(drawnMonths[drawnMonths.length - 1])}: ${drawnMonths.map((m) => `${mon(m)} ${usd(m.p50)} from ${m.n} cars`).join("; ")}.`} />}
              head={[{ text: "Month" }, { text: "Cars" }, { text: "Low" }, { text: "Median" }, { text: "High" }]}
              rows={d.monthly.map((m) => ({ cells: [mon(m), num(m.n), usd(m.p25), usd(m.p50), usd(m.p75)] }))}
            />
            {fullMonths < 4 && <p className="note">We have {NUMBERS[fullMonths]} {fullMonths === 1 ? "month" : "months"} at full volume so far, so this is not yet a trend.</p>}
          </Fig>
        </section>
      )}
    </>
  );
}
