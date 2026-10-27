/**
 * Pitch Lab preview page — renders a report (analysis.js) as one self-contained
 * HTML file. This is a stand-in for the website view: the website should read
 * the same report JSON and can copy this layout. No external requests.
 */

function embedJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function renderReportHtml(report) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pitch Lab Report</title>
<style>
:root { --bg:#fbfaf7; --panel:#ffffff; --ink:#1d1d1b; --muted:#6b6a65; --line:#e4e1d9; --pos:#1f7a4d; --neg:#b3362b; --neutral:#8a877f; --accent:#2c5d8f; --warn-bg:#fff4d6; --warn-ink:#6b4e00; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#161614; --panel:#1f1f1c; --ink:#ecebe6; --muted:#a09e96; --line:#34332f; --pos:#4cc38a; --neg:#f07a6e; --neutral:#8f8c84; --accent:#7fb0e0; --warn-bg:#3a3014; --warn-ink:#f3d48a; } }
:root[data-theme="dark"] { --bg:#161614; --panel:#1f1f1c; --ink:#ecebe6; --muted:#a09e96; --line:#34332f; --pos:#4cc38a; --neg:#f07a6e; --neutral:#8f8c84; --accent:#7fb0e0; --warn-bg:#3a3014; --warn-ink:#f3d48a; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:1080px; margin:0 auto; padding:24px 16px 64px; }
h1 { font-size:24px; margin:0 0 4px; } h2 { font-size:17px; margin:0 0 12px; }
.sub { color:var(--muted); margin:0 0 20px; font-size:13px; }
.banner { background:var(--warn-bg); color:var(--warn-ink); padding:10px 14px; border-radius:8px; margin-bottom:16px; font-weight:600; }
.controls { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:20px; }
label { font-size:13px; color:var(--muted); display:flex; flex-direction:column; gap:4px; }
select { font:inherit; padding:6px 8px; border-radius:6px; border:1px solid var(--line); background:var(--panel); color:var(--ink); }
.panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:18px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:14px; }
.stat .v { font-size:22px; font-weight:650; font-variant-numeric:tabular-nums; }
.stat .k { font-size:12px; color:var(--muted); }
.verdict { padding:10px 12px; border-radius:8px; border-left:4px solid var(--neutral); background:color-mix(in srgb,var(--neutral) 8%,transparent); margin-bottom:14px; }
.verdict.positive { border-color:var(--pos); background:color-mix(in srgb,var(--pos) 10%,transparent); }
.verdict.negative { border-color:var(--neg); background:color-mix(in srgb,var(--neg) 10%,transparent); }
.tablewrap { overflow-x:auto; }
table { width:100%; border-collapse:collapse; font-size:13px; font-variant-numeric:tabular-nums; }
th, td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
th { color:var(--muted); font-weight:600; font-size:12px; }
td.num, th.num { text-align:right; }
.pill { display:inline-block; padding:1px 8px; border-radius:99px; font-size:12px; font-weight:600; background:color-mix(in srgb,var(--neutral) 18%,transparent); color:var(--muted); }
.pill.positive { background:color-mix(in srgb,var(--pos) 18%,transparent); color:var(--pos); }
.pill.negative { background:color-mix(in srgb,var(--neg) 18%,transparent); color:var(--neg); }
.forest { position:relative; width:180px; height:16px; }
.forest .zero { position:absolute; left:50%; top:0; bottom:0; width:1px; background:var(--line); }
.forest .ci { position:absolute; top:7px; height:2px; background:var(--neutral); }
.forest .dot { position:absolute; top:3px; width:10px; height:10px; margin-left:-5px; border-radius:50%; background:var(--neutral); }
.forest.positive .ci, .forest.positive .dot { background:var(--pos); }
.forest.negative .ci, .forest.negative .dot { background:var(--neg); }
.bar { height:10px; background:var(--accent); border-radius:2px; min-width:1px; }
.bar.neg { background:var(--neg); }
.note { font-size:12px; color:var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Pitch Lab</h1>
  <p class="sub" id="sub"></p>
  <div id="banner"></div>
  <div class="controls">
    <label>Time period <select id="period"></select></label>
    <label>Holding period <select id="horizon"></select></label>
  </div>
  <section class="panel" id="conviction"></section>
  <section class="panel" id="trend"></section>
  <section class="panel" id="metrics"></section>
  <section class="panel" id="peermetrics"></section>
  <section class="panel" id="coverage"></section>
  <section class="panel"><h2>How to read this</h2><p class="note" id="method"></p></section>
</main>
<script>
const REPORT = ${embedJson(report)};
const $ = (id) => document.getElementById(id);
const pct = (v, d = 2) => v == null ? "—" : (v * 100).toFixed(d) + "%";
const num = (v, d = 3) => v == null ? "—" : Number(v).toFixed(d);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const LABEL = { positive: "Helps", negative: "Hurts", inconclusive: "No clear effect", insufficient_data: "Not enough data" };

$("sub").textContent = "Generated " + new Date(REPORT.generatedAt).toLocaleString() + " · " + REPORT.totals.pitches + " pitches · success = " + REPORT.assumptions.success;
if (REPORT.isSyntheticDemo) $("banner").innerHTML = '<div class="banner">DEMO DATA — synthetic pitches with planted effects. Not real results.</div>';
$("method").textContent = "Correlation is Spearman's rank correlation between the rating and excess return (−1 to +1; negative means higher ratings did worse). "
  + "Ranges are 95% intervals that account for pitches in the same week moving together (clustered by " + REPORT.options.clusterBy + "). "
  + "A verdict of Helps/Hurts needs at least " + REPORT.options.minSample + " graded pitches over " + REPORT.options.minClusters + " weeks, a p-value under " + REPORT.options.alpha
  + " for conviction, and a false-discovery-adjusted q-value under " + REPORT.options.fdr + " for metrics (because many metrics are tested at once). "
  + "Metric effects are per one standard deviation of that metric, so they can be compared with each other. Costs assumed: " + REPORT.assumptions.costPerSide.map((c) => pct(c, 2)).join(", ") + " per side.";

for (const p of REPORT.periods) $("period").insertAdjacentHTML("beforeend", '<option value="' + esc(p.id) + '">' + esc(p.label) + " (" + p.pitchCount + ")</option>");
const horizons = REPORT.periods[0]?.horizons.map((h) => h.horizonDays) ?? [];
for (const h of horizons) $("horizon").insertAdjacentHTML("beforeend", '<option value="' + h + '">' + h + " trading days</option>");

function forest(rho, ci, label) {
  const x = (v) => Math.max(0, Math.min(100, 50 + v * 100)); // rho range shown: -0.5..+0.5
  if (rho == null) return "—";
  const ciHtml = ci ? '<div class="ci" style="left:' + x(ci[0]) + "%;width:" + (x(ci[1]) - x(ci[0])) + '%"></div>' : "";
  return '<div class="forest ' + label + '"><div class="zero"></div>' + ciHtml + '<div class="dot" style="left:' + x(rho) + '%"></div></div>';
}

function render() {
  const period = REPORT.periods.find((p) => p.id === $("period").value) ?? REPORT.periods[0];
  const hd = Number($("horizon").value || horizons[0]);
  const h = period?.horizons.find((x) => x.horizonDays === hd);
  if (!h) { $("conviction").innerHTML = "<h2>Conviction</h2><p>No graded pitches yet.</p>"; $("metrics").innerHTML = ""; $("peermetrics").innerHTML = ""; renderCoverage(); return; }
  const c = h.conviction;
  const maxAbs = Math.max(0.0001, ...c.buckets.map((b) => Math.abs(b.meanExcessReturn ?? 0)));
  $("conviction").innerHTML = "<h2>Does conviction predict results?</h2>"
    + '<div class="verdict ' + c.verdict.label + '"><strong>' + LABEL[c.verdict.label] + ".</strong> " + esc(c.verdict.summary) + "</div>"
    + '<div class="stats">'
    + '<div class="stat"><div class="v">' + num(c.spearman.rho, 2) + '</div><div class="k">Correlation (range ' + (c.spearman.ci95 ? num(c.spearman.ci95[0], 2) + " to " + num(c.spearman.ci95[1], 2) : "—") + ")</div></div>"
    + '<div class="stat"><div class="v">' + pct(c.excessReturnPerPoint.estimate) + '</div><div class="k">Extra return per conviction point (range ' + (c.excessReturnPerPoint.ci95 ? pct(c.excessReturnPerPoint.ci95[0]) + " to " + pct(c.excessReturnPerPoint.ci95[1]) : "—") + ")</div></div>"
    + '<div class="stat"><div class="v">' + num(c.excessReturnPerPoint.pValue, 3) + '</div><div class="k">p-value</div></div>'
    + '<div class="stat"><div class="v">' + c.n + " / " + c.clusters + '</div><div class="k">Graded pitches / independent weeks</div></div>'
    + "</div>"
    + '<div class="tablewrap"><table><thead><tr><th>Conviction</th><th class="num">Pitches</th><th class="num">Avg vs market</th><th></th><th class="num">Median</th><th class="num">Beat market</th><th>Meaning</th></tr></thead><tbody>'
    + c.buckets.map((b) => "<tr><td>" + b.conviction + '</td><td class="num">' + b.n + '</td><td class="num">' + pct(b.meanExcessReturn) + '</td><td style="width:120px"><div class="bar' + ((b.meanExcessReturn ?? 0) < 0 ? " neg" : "") + '" style="width:' + (Math.abs(b.meanExcessReturn ?? 0) / maxAbs * 100) + '%"></div></td><td class="num">' + pct(b.medianExcessReturn) + '</td><td class="num">' + pct(b.hitRate, 0) + (b.hitRateCi95 ? ' <span class="note">(' + pct(b.hitRateCi95[0], 0) + "–" + pct(b.hitRateCi95[1], 0) + ")</span>" : "") + '</td><td class="note" style="white-space:normal">' + esc(b.meaning) + "</td></tr>").join("")
    + "</tbody></table></div>";

  const months = REPORT.periods.filter((p) => p.id.startsWith("month-"));
  $("trend").innerHTML = "<h2>Conviction over time (" + hd + "-day)</h2>"
    + '<div class="tablewrap"><table><thead><tr><th>Month</th><th class="num">Graded</th><th class="num">Correlation</th><th>Range</th><th>Verdict</th></tr></thead><tbody>'
    + months.map((m) => { const mh = m.horizons.find((x) => x.horizonDays === hd); const mc = mh?.conviction; return "<tr><td>" + esc(m.label) + '</td><td class="num">' + (mh?.graded ?? 0) + '</td><td class="num">' + num(mc?.spearman.rho, 2) + "</td><td>" + forest(mc?.spearman.rho, mc?.spearman.ci95, mc?.verdict.label) + '</td><td><span class="pill ' + (mc?.verdict.label ?? "") + '">' + (LABEL[mc?.verdict.label] ?? "—") + "</span></td></tr>"; }).join("")
    + "</tbody></table></div>";

  $("metrics").innerHTML = "<h2>Which metrics predict results?</h2>" + metricsTable(h.metrics)
    + '<p class="note">"Missing vs present" is the average result when the metric was available minus when it was missing — a large gap means missing data itself carries information.</p>';
  $("peermetrics").innerHTML = "<h2>Does being ahead of industry peers predict results?</h2>"
    + '<p class="note">Each metric is ranked against industry peers at pitch time (percentile = share of peers it beats; a lower P/E counts as better). Only pitches with enough peers are included.</p>'
    + metricsTable(h.peerMetrics ?? []);
  renderCoverage();
}

function metricsTable(list) {
  return '<div class="tablewrap"><table><thead><tr><th>Metric</th><th class="num">Have data</th><th class="num">Correlation</th><th>Range (−0.5 … +0.5)</th><th class="num">Per 1 SD</th><th class="num">q-value</th><th class="num">Missing vs present</th><th>Verdict</th></tr></thead><tbody>'
    + list.map((m) => "<tr><td>" + esc(m.label) + '</td><td class="num">' + m.coverage.present + "/" + (m.coverage.present + m.coverage.missing) + '</td><td class="num">' + num(m.spearman.rho, 2) + "</td><td>" + forest(m.spearman.rho, m.spearman.ci95, m.verdict.label) + '</td><td class="num">' + pct(m.excessReturnPerSd.estimate) + '</td><td class="num">' + num(m.excessReturnPerSd.qValue, 3) + '</td><td class="num">' + pct(m.missingVsPresent.difference) + '</td><td><span class="pill ' + m.verdict.label + '">' + LABEL[m.verdict.label] + "</span></td></tr>").join("")
    + "</tbody></table></div>";
}

function renderCoverage() {
  const c = REPORT.dataCoverage;
  if (!c) { $("coverage").innerHTML = ""; return; }
  const rows = Object.entries(c.peerRankStatus).map(([id, s]) => "<tr><td>" + esc(id) + '</td><td class="num">' + s.ranked + '</td><td class="num">' + s.thin_peers + '</td><td class="num">' + s.no_peers + '</td><td class="num">' + s.missing_value + '</td><td class="num">' + s.peer_data_unavailable + '</td><td class="num">' + s.not_recorded + '</td><td class="num">' + (s.rankedShare == null ? "—" : Math.round(s.rankedShare * 100) + "%") + "</td></tr>").join("");
  $("coverage").innerHTML = "<h2>Peer coverage</h2>"
    + '<p class="note">How often each metric could be ranked against industry peers across all ' + c.pitches + " pitches (" + c.pitchesWithPeerData + " recorded with peer data). Gaps are listed with their reason, never filled in.</p>"
    + '<div class="tablewrap"><table><thead><tr><th>Metric</th><th class="num">Ranked</th><th class="num">Thin peers</th><th class="num">No peers</th><th class="num">No value</th><th class="num">Peer data down</th><th class="num">Not recorded</th><th class="num">Ranked share</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
}
$("period").addEventListener("change", render);
$("horizon").addEventListener("change", render);
render();
</script>
</body>
</html>
`;
}
