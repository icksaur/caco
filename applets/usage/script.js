/**
 * Usage applet — hourly credit consumption for the past week.
 * Reads GET /api/usage/hourly?days=7 and renders one bar per UTC hour (labelled
 * in local time). A priced bar's height scales to credits; an all-unpriced hour
 * (credits === null but nonzero tokens) is marked distinctly so it never reads
 * as zero spend. View-only. See docs/spec-usage-metrics.md.
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

function renderChart(payload) {
  const buckets = (payload && payload.buckets) || [];
  const chart = el('usage-chart');
  chart.innerHTML = '';

  const priced = buckets.filter(b => typeof b.credits === 'number');
  const totalCredits = priced.reduce((s, b) => s + b.credits, 0);
  const maxCredits = priced.reduce((m, b) => Math.max(m, b.credits), 0);
  const anyActivity = buckets.some(b => b.pricedRequests > 0 || b.unpricedRequests > 0);

  el('usage-summary').textContent = `${fmtCredits(totalCredits)} cr over ${USAGE_DAYS}d`;

  if (!anyActivity) {
    show('empty');
    return;
  }
  show('chart');

  for (const b of buckets) {
    const col = document.createElement('div');
    col.className = 'usage-bar-col';

    const bar = document.createElement('div');
    const unpriced = (b.credits === null || b.credits === undefined) && b.unpricedRequests > 0;
    bar.className = unpriced ? 'usage-bar usage-bar-unpriced' : 'usage-bar';
    const ratio = maxCredits > 0 && typeof b.credits === 'number' ? b.credits / maxCredits : 0;
    bar.style.height = unpriced ? '100%' : `${Math.round(ratio * 100)}%`;

    const parts = [fmtHourLabel(b.hour)];
    if (typeof b.credits === 'number') parts.push(`${fmtCredits(b.credits)} cr`);
    if (unpriced) parts.push('unpriced');
    parts.push(`in ${b.inputTokens} · cache ${b.cachedTokens} · out ${b.outputTokens}`);
    col.title = parts.join(' · ');

    col.appendChild(bar);
    chart.appendChild(col);
  }

  // Bars flex-shrink to fit, but if the container is ever too narrow to fit
  // even the gaps, keep the most-recent hours (right edge) in view.
  chart.scrollLeft = chart.scrollWidth;
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
