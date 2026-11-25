import { Fragment, useEffect } from "react";
import { useApi } from "./api";
import { Bars, GradeMix, Table, TableDisclosure } from "./charts";
import { GRADES, dayMonthYear, day, num, pct, signedPct, usd } from "./format";
import { ErrorBox, Fig, KeyFacts, Section, Skeleton, Src } from "./parts";

const MODEL_NAMES = { linear: "Linear", relaxed_lasso: "Relaxed lasso", rf: "Random forest", xgb: "XGBoost", blend: "Blend" };
const BAND_NAMES = { "0": "None", "1-2": "1 or 2", "3-9": "3 to 9", "10-29": "10 to 29", "30+": "30 or more" };

const INPUTS = [
  ["Age and mileage", null, ["year", "vehicle_age", "age_sq", "log_age", "mileage", "log_mileage", "miles_per_year"]],
  ["The car", null, ["make", "model", "trim", "trim_rank", "body_type", "exterior_color"]],
  ["Comparables", "other dealers only", ["cohort_median_price", "cohort_count", "comp_price"]],
  ["Segment flags", null, ["is_luxury", "is_truck", "is_sports", "lux_age", "lux_mpy"]],
  ["Location", null, ["state", "zip3"]],
  ["Not used", "results of pricing", ["ref_price", "price_change_percent", "days_listed", "dealer_name"]],
];
const EFFECTS = [
  [<>Add <code>comp_price</code></>, "−$140 to −$180", "5 of 5"],
  ["Blend three models above $10k", "−$86 to −$158", "7 of 7"],
  [<>Use <code>comp_price</code> under $10k</>, "worse", "4 of 5"],
];
const LIMITS = [
  ["Target", "Asking prices, not sale prices"],
  ["Price range", "$3,000 to $100,000"],
  ["Region", "Western states"],
  ["Not in the data", "Condition, options, accident history"],
  ["Test", "One random split, not a forecast"],
  ["Retrained", "Daily, so figures drift"],
];

const cmpLabel = (lo, hi, first) => `${hi == null ? `${lo} or more` : `${lo} to ${hi - 1}`}${first ? " comparables" : ""}`;
const priceLabel = (lo, hi) => (!lo ? `Under ${usd(hi)}` : hi == null ? `Over ${usd(lo)}` : `${usd(lo)} to ${usd(hi)}`);

export default function MethodView() {
  const { data, error, reload } = useApi("/model-card");
  useEffect(() => { document.title = "How the estimate works | Car Intel"; }, []);
  return (
    <>
      <div className="view-head solo"><h1 className="page-title">How the estimate works</h1></div>
      {error ? (
        <ErrorBox error={error} onRetry={reload} notFound="The model card isn't published yet." />
      ) : !data ? (
        <Skeleton label="Loading the model card" />
      ) : (
        <Method card={data.card} live={data.live} />
      )}
    </>
  );
}

function Method({ card, live }) {
  const { rows, test } = card;
  const share = (n) => Math.round((n / rows.pool) * 100);
  const date = dayMonthYear(day(card.date));
  const maxMae = Math.max(...Object.values(card.candidates).map((c) => c.test_mae));
  const cands = Object.entries(card.candidates).sort((a, b) => b[1].test_mae - a[1].test_mae);
  const groups = [...card.importance.groups].sort((a, b) => b.relative - a.relative);
  const seg = card.segment_errors;
  const cols = seg[0]?.cells || [];
  const cheapTop = cols[cols.length - 1], cheapPrev = cols[cols.length - 2];
  const reasons = [
    ["No comparables at other dealers", live.not_rated.no_comparables],
    ["1 or 2 comparables and a top or bottom score", live.not_rated.thin_extreme_score],
    live.not_rated.unknown ? ["Other", live.not_rated.unknown] : null,
  ].filter(Boolean);
  const gapMax = Math.max(...live.gap_by_comparables.map((g) => g.median_abs_gap_pct), 1);

  const flow = [
    ["Collect", "Dealer listings, scraped nightly"],
    ["Filter", `Latest row per VIN, $3k to $100k: ${num(rows.pool)} training rows`],
    ["Split by VIN", `${share(rows.train)} / ${share(rows.val)} / ${share(rows.test)}, no VIN in two splits`],
    ["Add comparables", "Same make and model at other dealers"],
    ["Predict", "XGBoost under $10k, a three-model blend above"],
    ["Calibrate", "Remove the median validation error"],
    ["Score", "Price gap ÷ usual error. 50 is fair."],
    ["Grade", "One of five grades, or Not rated"],
  ];

  return (
    <>
      <Section id="me-h1" title="From listing to grade" first>
        <div className="panel">
          <ol className="flow">
            {flow.map(([h, p], i) => <li key={h} className={i === flow.length - 1 ? "end" : undefined}><h3>{h}</h3><p>{p}</p></li>)}
          </ol>
          <div className="formula" tabIndex={0} role="group" aria-label="The scoring formula with an example">{`gap %  = (estimate − asking) / estimate × 100
z      = gap % / usual error %
score  = clamp(50 + 40 × z / 3, 0, 100)
`}<span className="c"># 90+ is a Great deal: a discount of 3× the usual error</span>{`

`}<span className="c"># Example: estimate $20,000, asking $18,200, usual error 6%</span>{`
gap %  = (20,000 − 18,200) / 20,000 = 9.0%
z      = 9.0 / 6 = 1.5
score  = 50 + 40 × 1.5 / 3 = 70.0
`}<span className="c"># Good deal (65 to 89)</span></div>
        </div>
      </Section>

      <Section id="me-h2" title="Inputs">
        <div className="panel">
          <div className="inputs">
            {INPUTS.map(([h, small, items]) => (
              <div key={h} className={h === "Not used" ? "off-group" : undefined}>
                <h3>{h}{small && <small> {small}</small>}</h3>
                <ul className={h === "Not used" ? "off" : undefined}>{items.map((i) => <li key={i}>{i}</li>)}</ul>
              </div>
            ))}
          </div>
          <div className="two split">
            <div className="fig">
              <div className="fig-head"><h3>Importance by group</h3><Src>permutation, {num(card.importance.rows)} validation rows</Src></div>
              <Bars
                label={`Importance by group: ${groups.map((g) => `${g.group} adds ${usd(g.mae_added)} of error when shuffled`).join(", ")}.`}
                rows={groups.map((g) => ({ k: g.group, frac: g.relative, v: `+${usd(g.mae_added)}` }))}
              />
              <TableDisclosure head={["Group", "Error added when shuffled", "Relative"]} rows={groups.map((g) => ({ cells: [g.group, usd(g.mae_added), pct(g.relative * 100, 0)] }))} />
            </div>
            <div className="fig">
              <div className="fig-head"><h3>Measured effects</h3><Src>research notes</Src></div>
              <Table className="compact" head={["Change", "Mean error", "Splits"]} rows={EFFECTS.map((r) => ({ cells: r }))} />
            </div>
          </div>
        </div>
      </Section>

      <Section id="me-h3" title="Accuracy">
        <div className="two">
          <Fig title="Usual error by price and comparables" src={`training log, ${date}`}>
            <div className="scroll">
              <table className="heat">
                <thead>
                  <tr>
                    <th scope="col">Asking price</th>
                    {cols.map((c, i) => <th key={i} scope="col" className="c">{cmpLabel(c.comparables_lo, c.comparables_hi, i === 0)}</th>)}
                    <th scope="col">All</th>
                  </tr>
                </thead>
                <tbody>
                  {seg.map((r) => (
                    <tr key={r.lo}>
                      <th scope="row">{priceLabel(r.lo, r.hi)}</th>
                      {cols.map((c, i) => {
                        const cell = r.cells.find((x) => x.comparables_lo === c.comparables_lo);
                        return cell ? <td key={i} className="c" style={{ background: `color-mix(in srgb, var(--accent) ${Math.min(60, Math.max(0, Math.round((cell.error_pct - 5) * 2.2)))}%, var(--surface))` }}>{pct(cell.error_pct)}</td> : <td key={i} className="c">—</td>;
                      })}
                      <td>{pct(r.error_pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="note">Median absolute error as a share of the asking price.{cheapTop && cheapTop.error_pct > cheapPrev.error_pct && ` Cars under ${usd(seg[0].hi)} vary more in condition than the data records, so more comparables help less there. The cell with ${cheapTop.comparables_lo} or more comparables rests on ${num(cheapTop.n)} cars.`}</p>
          </Fig>
          <div className="stack">
            <Fig title="Test error by model" src={`training log, ${num(test.n)} held-out rows`}>
              <Bars
                label={`Test error by model: ${cands.map(([k, c]) => `${MODEL_NAMES[k] || k} ${usd(c.test_mae)}`).join(", ")}.`}
                rows={cands.map(([k, c]) => ({ k: (MODEL_NAMES[k] || k) + (k === card.selected_model ? ", in use" : ""), frac: c.test_mae / maxMae, v: usd(c.test_mae), me: k === card.selected_model }))}
              />
              <TableDisclosure head={["Model", "Test error", "Validation error"]} rows={cands.map(([k, c]) => ({ cells: [(MODEL_NAMES[k] || k) + (k === card.selected_model ? ", in use" : ""), usd(c.test_mae), usd(c.val_mae)] }))} />
            </Fig>
            <div className="panel fig slot">
              <div className="fig-head"><h3>Latest audit</h3><Src>{`retrained and tested, ${date}`}</Src></div>
              <KeyFacts
                three
                items={[
                  { k: "Median error", v: pct(test.median_ape), s: test.ci95 ? `95% interval ${test.ci95[0].toFixed(1)} to ${test.ci95[1].toFixed(1)}` : null },
                  { k: "Held-out rows", v: num(test.n), s: `${Math.round(test.within10)}% within 10%` },
                  { k: "Mean error", v: usd(test.mae), s: `bias ${signedPct(test.bias_pct)}` },
                ]}
              />
            </div>
          </div>
        </div>
      </Section>

      <Section id="me-h4" title={`Grades across ${num(live.cars_listed)} active listings`} src="own DB">
        <div className="panel fig">
          <GradeMix grades={live.grades} showPct label={`Grades across ${num(live.cars_listed)} active listings`} />
          <TableDisclosure
            head={["Grade", "Cars", "Share"]}
            rows={GRADES.map((g) => ({ cells: [g.label, num(live.grades[g.key] || 0), pct(((live.grades[g.key] || 0) / live.cars_listed) * 100)] }))}
          />
          <div className="two split">
            <div className="fig">
              <h3>Why a car is not rated</h3>
              <Table className="compact" head={["Reason", "Cars"]} rows={reasons.map((r) => ({ cells: [r[0], num(r[1])] }))} />
              <h3 className="gapped">Gap to estimate by comparables</h3>
              <Bars
                label={`Median gap to the estimate by number of comparables: ${live.gap_by_comparables.map((g) => `${BAND_NAMES[g.band] || g.band}, ${pct(g.median_abs_gap_pct)} across ${num(g.n)} cars`).join("; ")}.`}
                rows={live.gap_by_comparables.map((g, i) => ({ k: BAND_NAMES[g.band] || g.band, frac: g.median_abs_gap_pct / gapMax, v: pct(g.median_abs_gap_pct), small: i === 0 ? `${num(g.n)} cars` : num(g.n) }))}
              />
            </div>
            <div className="fig">
              <h3>Known limits</h3>
              <dl className="facts tight wide">
                {LIMITS.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}
              </dl>
            </div>
          </div>
        </div>
      </Section>
    </>
  );
}
