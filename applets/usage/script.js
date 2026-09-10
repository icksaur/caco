/**
 * Usage applet — hourly credit consumption for the past week.
 * Reads GET /api/usage/hourly?days=7 and renders one bar per UTC hour (labelled
 * in local time). A priced bar's height scales to credits and splits into
 * per-model segments when the hour ran more than one model; an all-unpriced hour
 * (credits === null but nonzero tokens) is marked distinctly so it never reads
 * as zero spend, and an hour that priced only some turns carries a partial mark.
 * View-only. See docs/spec-usage-metrics.md.
 */

const USAGE_DAYS = 7;

function el(id) { return document.getElementById(id); }

function show(which) {
  el('usage-loading').style.display = which === 'loading' ? 'block' : 'none';
  el('usage-error').style.display = which === 'error' ? 'block' : 'none';
  el('usage-empty').style.display = which === 'empty' ? 'block' : 'none';
  el('usage-chart-wrap').style.display = which === 'chart' ? 'block' : 'none';
}

function fmtCredits(n) {
  if (n === null || n === undefined) return '—';
  if (n === 0) return '0';
  if (n < 0.01) return n.toFixed(4);
  return n.toFixed(2);
}

function fmtHourLabel(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' });
}

/** Stable per-model colour: hash the id onto the theme's chart hue ramp so the
 *  same model keeps its colour across refreshes without a hard-coded palette. */
function modelHue(model) {
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) % 360;
  return h;
}

/** Priced credits per model for an hour, largest first. Unpriced model keys
 *  (credits === null) are excluded from the segments — their spend is unknown,
 *  and the partial mark is what reports them. */
function modelSegments(bucket) {
  const perModel = bucket.perModelCredits;
  if (!perModel) return [];
  return Object.entries(perModel)
    .filter(([, credits]) => typeof credits === 'number' && credits > 0)
    .sort((a, b) => b[1] - a[1]);
}

function renderChart(payload) {
  const buckets = (payload && payload.buckets) || [];
  const chart = el('usage-chart');
  chart.innerHTML = '';

  const priced = buckets.filter(b => typeof b.credits === 'number');
  const totalCredits = priced.reduce((s, b) => s + b.credits, 0);
  const maxCredits = priced.reduce((m, b) => Math.max(m, b.credits), 0);
  const anyActivity = buckets.some(b => b.pricedRequests > 0 || b.unpricedRequests > 0);
  const totalNanoAiu = buckets.reduce(
    (s, b) => (typeof b.sdkNanoAiu === 'number' ? s + b.sdkNanoAiu : s), 0);
  const anyNanoAiu = buckets.some(b => typeof b.sdkNanoAiu === 'number');
  const anyPartial = buckets.some(b => (b.partialRequests || 0) > 0);

  // nano-AIU is CAPI's own billing unit, NOT credits — labelled separately so the
  // two are never read as the same quantity.
  el('usage-summary').textContent = anyNanoAiu
    ? `${fmtCredits(totalCredits)} cr · ${totalNanoAiu.toLocaleString()} nano-AIU over ${USAGE_DAYS}d`
    : `${fmtCredits(totalCredits)} cr over ${USAGE_DAYS}d`;

  if (!anyActivity) {
    show('empty');
    return;
  }
  show('chart');

  const seenModels = new Map();

  for (const b of buckets) {
    const col = document.createElement('div');
    col.className = 'usage-bar-col';

    const bar = document.createElement('div');
    const unpriced = (b.credits === null || b.credits === undefined) && b.unpricedRequests > 0;
    const partial = (b.partialRequests || 0) > 0;
    bar.className = 'usage-bar'
      + (unpriced ? ' usage-bar-unpriced' : '')
      + (partial ? ' usage-bar-partial' : '');
    const ratio = maxCredits > 0 && typeof b.credits === 'number' ? b.credits / maxCredits : 0;
    bar.style.height = unpriced ? '100%' : `${Math.round(ratio * 100)}%`;

    // Split the bar by model when the hour ran more than one.
    const segments = modelSegments(b);
    if (!unpriced && segments.length > 1 && typeof b.credits === 'number' && b.credits > 0) {
      for (const [model, credits] of segments) {
        const seg = document.createElement('div');
        seg.className = 'usage-bar-seg';
        seg.style.height = `${(credits / b.credits) * 100}%`;
        seg.style.background = `hsl(${modelHue(model)} 55% 55%)`;
        seg.title = `${model}: ${fmtCredits(credits)} cr`;
        bar.appendChild(seg);
        seenModels.set(model, modelHue(model));
      }
    } else if (segments.length === 1) {
      seenModels.set(segments[0][0], modelHue(segments[0][0]));
    }

    const parts = [fmtHourLabel(b.hour)];
    if (typeof b.credits === 'number') parts.push(`${fmtCredits(b.credits)} cr`);
    if (unpriced) parts.push('unpriced');
    if (partial) parts.push(`${b.partialRequests} partial request${b.partialRequests !== 1 ? 's' : ''}`);
    for (const [model, credits] of segments) parts.push(`${model} ${fmtCredits(credits)} cr`);
    if (typeof b.sdkNanoAiu === 'number') parts.push(`${b.sdkNanoAiu.toLocaleString()} nano-AIU`);
    if (b.subAgentTurns) parts.push(`${b.subAgentTurns} sub-agent turn${b.subAgentTurns !== 1 ? 's' : ''}`);
    parts.push(`in ${b.inputTokens} · cache ${b.cachedTokens} · out ${b.outputTokens}`);
    col.title = parts.join(' · ');

    col.appendChild(bar);
    chart.appendChild(col);
  }

  renderLegend(seenModels, anyPartial);

  // Bars flex-shrink to fit, but if the container is ever too narrow to fit
  // even the gaps, keep the most-recent hours (right edge) in view.
  chart.scrollLeft = chart.scrollWidth;
}

function renderLegend(seenModels, anyPartial) {
  const legend = el('usage-legend');
  legend.innerHTML = '';
  for (const [model, hue] of [...seenModels.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const item = document.createElement('span');
    item.className = 'usage-legend-item';
    const swatch = document.createElement('span');
    swatch.className = 'usage-legend-swatch';
    swatch.style.background = `hsl(${hue} 55% 55%)`;
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(model));
    legend.appendChild(item);
  }
  if (anyPartial) {
    const note = document.createElement('span');
    note.className = 'usage-legend-note';
    note.textContent = 'hatched = some turns unpriced (credits under-report)';
    legend.appendChild(note);
  }
  legend.style.display = legend.childElementCount > 0 ? 'flex' : 'none';
}

async function loadUsage() {
  show('loading');
  try {
    const res = await fetch(`/api/usage/hourly?days=${USAGE_DAYS}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    renderChart(payload);
  } catch (err) {
    show('error');
    el('usage-error').textContent = `Failed to load usage: ${err.message}`;
  }
}

function init() {
  el('usage-refresh').addEventListener('click', loadUsage);
  loadUsage();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
