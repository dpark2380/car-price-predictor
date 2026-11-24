import { useEffect } from "react";
import { marketPath, seg, useApi } from "./api";
import { MonthlyMedians, TableDisclosure } from "./charts";
import { MON, kusd, num, plural, signedPct, usd } from "./format";
import { Crumbs, ErrorBox, KeyFacts, Link, Section, Skeleton } from "./parts";

const MODEL_MIN = 40; // a model row needs this many cars to be worth a line
const BRAND_MIN = 10;
const SMALL_MIN = 50;

const gapHead = { text: "Gap to estimate" };

export function BrandsTable({ rows, current }) {
  return (
    <div className="scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Brand</th><th scope="col">Cars</th><th scope="col">Median price</th><th scope="col">{gapHead.text}</th><th scope="col">Days on market</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.make} className={m.make === current ? "me" : undefined}>
              <th scope="row"><Link to={marketPath(m.make)}>{m.make}</Link></th>
              <td>{num(m.n)}</td><td>{usd(m.median_price)}</td><td>{signedPct(m.median_gap_pct)}</td><td>{num(m.median_dom)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BrandIndex() {
  const { data, error, reload } = useApi("/market/makes");
  useEffect(() => { document.title = "Used car market by brand | Car Intel"; }, []);
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  if (!data) return <Skeleton label="Loading brands" />;
  const rows = data.filter((m) => m.n >= BRAND_MIN);
  return (
    <>
      <div className="view-head solo"><h1 className="page-title">Brands</h1></div>
      <Section id="idx-h1" title="All brands" src={`own DB, ${rows.length} of ${data.length}`} first>
        <div className="panel">
          {rows.length ? <BrandsTable rows={rows} /> : <p className="empty-inline">No brand has enough cars yet.</p>}
        </div>
      </Section>
    </>
  );
}

export function BrandView({ make: makeIn }) {
  const { data: d, error, reload } = useApi(`/market/make/${seg(makeIn)}`);
  const { data: makes } = useApi("/market/makes");
  useEffect(() => { document.title = d ? `${d.make} used car prices | Car Intel` : "Brand | Car Intel"; }, [d]);
  if (error) return <ErrorBox error={error} onRetry={reload} notFound={`We have no listings for ${makeIn}.`} back={{ to: "/market", text: "See all brands" }} />;
  if (!d) return <Skeleton label="Loading the brand" />;

  const { make, summary: s } = d;
  let models = d.models.filter((m) => m.n >= MODEL_MIN);
  const big = models.length;
  if (!models.length) models = d.models.slice(0, 10);
  const top = d.models[0];
  const scaleMax = Math.max(10000, Math.ceil(Math.max(...models.map((m) => m.p75)) / 10000) * 10000);
  const monthly = d.monthly.filter((m) => m.months.filter((x) => x.n >= 5).length >= 2);
  let brands = makes ? makes.filter((m) => m.n >= BRAND_MIN).slice(0, 10) : [];
  if (makes && !brands.some((m) => m.make === make)) {
    const cur = makes.find((m) => m.make === make);
    if (cur) brands = [...brands, cur];
  }
  const mon = (m) => `${MON[Number(m.month.slice(5)) - 1]} ${m.month.slice(0, 4)}`;

  return (
    <>
      <Crumbs items={[{ text: "All brands", to: "/market" }, { text: make }]} />
      <div className="view-head"><h1 className="page-title">{make}</h1></div>
      <section className="panel section first" aria-label="Summary">
        <KeyFacts
          items={[
            { k: "Cars listed", v: num(s.n), s: top && s.n > 0 && d.models.length > 1 ? `${Math.round((top.n / s.n) * 100)}% are ${plural(top.model)}` : null },
            { k: "Models", v: num(s.models), s: `${big} with ${MODEL_MIN}+ cars` },
            { k: "Median asking price", v: usd(s.median_price) },
            { k: "Median days on market", v: num(s.median_dom) },
          ]}
        />
      </section>

      <Section id="br-h1" title="Models" src="own DB">
        <div className="panel">
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Model</th><th scope="col">Cars</th><th scope="col">Median price</th>
                  <th scope="col" className="rangecell l">Middle half, $0 to {kusd(scaleMax)}</th>
                  <th scope="col">{gapHead.text}</th><th scope="col">Days on market</th><th scope="col">Usual error</th><th scope="col">Not rated</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model}>
                    <th scope="row"><Link to={marketPath(make, m.model)}>{m.model}</Link></th>
                    <td>{num(m.n)}</td><td>{usd(m.p50)}</td>
                    <td className="rangecell l">
                      <div className="rng" role="img" aria-label={`${usd(m.p25)} to ${usd(m.p75)}`}>
                        <i style={{ left: `${(m.p25 / scaleMax) * 100}%`, width: `${((m.p75 - m.p25) / scaleMax) * 100}%` }} />
                        <b style={{ left: `${(m.p50 / scaleMax) * 100}%` }} />
                      </div>
                    </td>
                    <td>{signedPct(m.median_gap_pct)}</td><td>{num(m.median_dom)}</td>
                    <td>{m.usual_error_pct != null ? `${m.usual_error_pct.toFixed(1)}%` : "—"}</td><td>{num(m.unrated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="note">Gap is the median asking price against the model estimate. A minus means listed above it.</p>
        </div>
      </Section>

      {monthly.length > 0 && (
        <Section id="br-h2" title="Median price by month first seen" src="own DB">
          <div className="panel fig">
            <ul className="legend top" style={{ marginTop: 0 }}><li><i className="medk a" />{SMALL_MIN} or more cars</li><li><i className="medk thin" />Under {SMALL_MIN} cars</li></ul>
            <div className="four">
              {monthly.map((m) => {
                const drawn = m.months.filter((x) => x.n >= 5);
                return (
                  <figure key={m.model}>
                    <MonthlyMedians rows={m.months} minN={SMALL_MIN} title={m.model} label={`${m.model} monthly median asking price, ${mon(drawn[0])} to ${mon(drawn[drawn.length - 1])}, latest ${usd(drawn[drawn.length - 1].p50)}.`} />
                  </figure>
                );
              })}
            </div>
            <TableDisclosure
              head={[{ text: "Model" }, { text: "Month" }, { text: "Cars" }, { text: "Median" }]}
              rows={monthly.flatMap((m) => m.months.map((x) => ({ cells: [m.model, mon(x), num(x.n), usd(x.p50)] })))}
            />
          </div>
        </Section>
      )}

      {brands.length > 1 && makes && (
        <Section id="br-h3" title="Brands" src={`own DB, top ${Math.min(10, brands.length)} of ${makes.length}`}>
          <div className="panel"><BrandsTable rows={brands} current={make} /></div>
        </Section>
      )}
    </>
  );
}
