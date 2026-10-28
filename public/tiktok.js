// ---------- TikTok tab (reads /api/tiktok/*, see ../tiktok.js for the definitions) ----------
// Uses the shared helpers from app.js: $, $all, esc, api, fmtNum, pctSpan, PALETTE, chartOptions.

const tt = {
  view: 'creators',
  sort: { creators: 'revenue', products: 'revenue' },
  meta: null,
  charts: {},
  loadedOnce: false,
};

const ttMoney = (n) => (n === null || n === undefined ? '—' : `฿${Math.round(n).toLocaleString()}`);
const ttPct = (x, digits = 1) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);
const ttChange = (cur, prev) => (prev ? ((cur - prev) / prev) * 100 : null);
const ttYmd = (d) => d.toISOString().slice(0, 10);
const ttAddDays = (s, n) => ttYmd(new Date(Date.parse(`${s}T00:00:00Z`) + n * 864e5));

function ttDeltaCell(cur, prev) {
  const pct = ttChange(cur, prev);
  return pct === null ? '' : `<div class="tt-delta">${pctSpan(pct)}</div>`;
}

function ttSetPeriodFromPreset() {
  const preset = $('#tt-preset').value;
  const last = tt.meta?.last_day || ttAddDays(ttYmd(new Date(Date.now() + 7 * 3600e3)), -1);
  if (preset === 'custom') return;
  let from = last;
  let to = last;
  if (preset === '7' || preset === '30') from = ttAddDays(last, -(Number(preset) - 1));
  if (preset === 'this-month') from = `${last.slice(0, 7)}-01`;
  if (preset === 'last-month') {
    to = ttAddDays(`${last.slice(0, 7)}-01`, -1);
    from = `${to.slice(0, 7)}-01`;
  }
  $('#tt-from').value = from;
  $('#tt-to').value = to;
}

function ttQuery(extra = {}) {
  const qs = new URLSearchParams({ from: $('#tt-from').value, to: $('#tt-to').value, ...extra });
  return qs.toString();
}

function ttShowError(json) {
  const el = $('#tt-error');
  el.hidden = false;
  el.textContent = json.code === 'TIKTOK_NOT_CONFIGURED'
    ? 'TikTok data is not connected yet (TIKTOK_DATABASE_URL is not set on the dashboard service).'
    : `Could not load TikTok data: ${json.message || json.error || 'unknown error'}`;
}

async function loadTikTokTab() {
  if (!tt.loadedOnce) {
    const { status, json } = await api('/tiktok/meta');
    if (status !== 200) return ttShowError(json);
    tt.meta = json;
    tt.loadedOnce = true;
    ttSetPeriodFromPreset();
    const run = json.last_run;
    $('#tt-freshness').textContent = json.last_day
      ? `Data to ${json.last_day}${run ? ` · synced ${new Date(run.finished_at).toLocaleString()}${run.ok ? '' : ' (last sync failed)'}` : ''}`
      : 'No data synced yet';
  }
  await ttRefresh();
}

async function ttRefresh() {
  $('#tt-error').hidden = true;
  const btn = $('#tt-apply-btn');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    await Promise.all([ttLoadSummary(), tt.view === 'creators' ? ttLoadCreators() : ttLoadProducts()]);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Apply';
  }
}

// ---------- summary: stat cards + charts ----------

async function ttLoadSummary() {
  const { status, json } = await api(`/tiktok/summary?${ttQuery()}`);
  if (status !== 200) return ttShowError(json);
  const c = json.current;
  const p = json.previous;
  const card = (label, value, cur, prev, sub = '') => `
    <div class="stat-card">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${prev !== undefined ? `vs prev (${pctSpan(ttChange(cur, prev))})` : ''}${sub}</div>
    </div>`;
  $('#tt-stat-cards').innerHTML = [
    card('Affiliate revenue', ttMoney(c.revenue), c.revenue, p.revenue),
    card('Commission', ttMoney(c.commission), c.commission, p.commission),
    card('Orders', fmtNum(c.orders), c.orders, p.orders, ` · ${fmtNum(c.items)} items`),
    card('AOV', ttMoney(c.aov), c.aov, p.aov),
    card('New revenue videos', fmtNum(c.new_revenue_videos), c.new_revenue_videos, p.new_revenue_videos, ` · ${fmtNum(c.posted)} posted`),
    card('Video views', fmtNum(c.views), c.views, p.views),
    card('CTR · Conv.', `${ttPct(c.ctr)} · ${ttPct(c.conversion)}`, undefined, undefined, 'product clicks ÷ impressions · orders ÷ clicks'),
    card('Return rate', ttPct(c.return_rate), c.return_rate, p.return_rate, ` · ${fmtNum(c.selling_creators)} selling creators`),
  ].join('');

  const split = Object.fromEntries(json.split.map((s) => [s.creator_group, s]));
  const gq = split.GQ || { views: 0, video_gmv: 0, active_videos: 0 };
  const aff = split.Affiliate || { views: 0, video_gmv: 0, active_videos: 0 };
  const share = (a, b) => (a + b ? `${((a / (a + b)) * 100).toFixed(0)}%` : '—');
  $('#tt-split-subtitle').textContent = `(affiliate share: GMV ${share(aff.video_gmv, gq.video_gmv)}, views ${share(aff.views, gq.views)}, videos ${share(aff.active_videos, gq.active_videos)})`;

  const labels = json.daily.map((d) => d.day.slice(5));
  ttChart('daily', '#tt-chart-daily', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Revenue', data: json.daily.map((d) => d.revenue), borderColor: PALETTE[0], backgroundColor: PALETTE[0], tension: 0.25, pointRadius: 0 },
        { label: 'Commission', data: json.daily.map((d) => d.commission), borderColor: PALETTE[2], backgroundColor: PALETTE[2], tension: 0.25, pointRadius: 0 },
      ],
    },
    options: ttChartOptions(true),
  });
  ttChart('split', '#tt-chart-split', {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Affiliate', data: json.daily.map((d) => d.gmv_affiliate), backgroundColor: PALETTE[0], stack: 'g' },
        { label: 'GQ', data: json.daily.map((d) => d.gmv_gq), backgroundColor: PALETTE[3], stack: 'g' },
      ],
    },
    options: { ...ttChartOptions(true), scales: { ...ttChartOptions(true).scales, x: { ...ttChartOptions(true).scales.x, stacked: true }, y: { ...ttChartOptions(true).scales.y, stacked: true } } },
  });
  ttChart('monthly', '#tt-chart-monthly', ttMonthlyConfig(json.monthly));
}

function ttChartOptions(legend) {
  const base = chartOptions();
  return {
    ...base,
    plugins: { legend: { display: legend, position: 'bottom', labels: { boxWidth: 10 } } },
    scales: { ...base.scales, y: { ...base.scales.y, ticks: { callback: (v) => Number(v).toLocaleString() } } },
  };
}

function ttMonthlyConfig(monthly) {
  const base = ttChartOptions(true);
  return {
    type: 'bar',
    data: {
      labels: monthly.map((m) => m.month),
      datasets: [
        { label: 'Revenue', data: monthly.map((m) => m.revenue), backgroundColor: PALETTE[0], yAxisID: 'y', order: 1 },
        { label: 'New revenue videos', data: monthly.map((m) => m.new_revenue_videos), type: 'line', borderColor: PALETTE[1], backgroundColor: PALETTE[1], pointRadius: 4, yAxisID: 'y1', order: 0 },
      ],
    },
    options: { ...base, scales: { x: base.scales.x, y: base.scales.y, y1: { position: 'right', beginAtZero: true, grid: { display: false }, ticks: { precision: 0 } } } },
  };
}

function ttChart(key, canvasSel, config) {
  if (tt.charts[key]) tt.charts[key].destroy();
  tt.charts[key] = new Chart($(canvasSel), config);
}

// ---------- tables ----------

function ttHeader(cols, view) {
  return `<tr>${cols.map((c) => {
    if (!c.sort) return `<th class="${c.num ? 'num' : ''}">${c.label}</th>`;
    const active = tt.sort[view] === c.sort;
    return `<th class="${c.num ? 'num' : ''} tt-sortable${active ? ' tt-sorted' : ''}" data-sort="${c.sort}" title="Sort by ${esc(c.label)}">${c.label}${active ? ' ▾' : ''}</th>`;
  }).join('')}</tr>`;
}

const CREATOR_COLS = [
  { label: 'Creator' },
  { label: 'Revenue', sort: 'revenue', num: true },
  { label: 'Commission', sort: 'commission', num: true },
  { label: 'Orders', sort: 'orders', num: true },
  { label: 'Items', sort: 'items', num: true },
  { label: 'AOV', num: true },
  { label: 'Return', num: true },
  { label: 'New rev. videos', sort: 'new_revenue_videos', num: true },
  { label: 'Posted', num: true },
  { label: 'Active videos', sort: 'active_videos', num: true },
  { label: 'Views', sort: 'views', num: true },
  { label: 'Eng.', num: true },
  { label: 'Clicks', sort: 'clicks', num: true },
  { label: 'CTR', num: true },
  { label: 'Conv.', num: true },
  { label: 'Video GMV', sort: 'video_gmv', num: true },
  { label: 'LIVE rev.', sort: 'live_revenue', num: true },
];

function ttCreatorCell(key, arm, group) {
  const tags = [
    arm ? `<span class="tt-tag tt-tag-arm" title="ARM ${esc(arm.internal_id)}">ARM${arm.name ? ` · ${esc(arm.name)}` : ''}</span>` : '',
    group === 'GQ' ? '<span class="tt-tag tt-tag-gq">GQ</span>' : '',
  ].join('');
  return `<a href="#" class="tt-open-creator" data-handle="${esc(key)}">@${esc(key)}</a>${tags}`;
}

async function ttLoadCreators() {
  const { status, json } = await api(`/tiktok/creators?${ttQuery({ sort: tt.sort.creators, arm: $('#tt-arm-only').checked ? '1' : '0', q: $('#tt-search').value.trim(), limit: '200' })}`);
  if (status !== 200) return ttShowError(json);
  $('#tt-table-heading').textContent = 'Creator performance';
  $('#tt-table-note').textContent = `${fmtNum(json.total)} creators shown (top 200 by the sorted column) · ${fmtNum(json.arm_matched)} of ${fmtNum(json.total_creators)} active creators are matched to ARM. Creators with under 100 views and no sales in the period are left out.`;
  $('#tt-thead').innerHTML = ttHeader(CREATOR_COLS, 'creators');
  $('#tt-tbody').innerHTML = json.rows.length ? json.rows.map((r) => `
    <tr>
      <td>${ttCreatorCell(r.creator_key, r.arm, r.creator_group)}</td>
      <td class="num">${ttMoney(r.revenue)}${ttDeltaCell(r.revenue, r.prev_revenue)}</td>
      <td class="num">${ttMoney(r.commission)}</td>
      <td class="num">${fmtNum(r.orders)}</td>
      <td class="num">${fmtNum(r.items)}</td>
      <td class="num">${ttMoney(r.aov)}</td>
      <td class="num">${ttPct(r.return_rate)}</td>
      <td class="num"><b>${fmtNum(r.new_revenue_videos)}</b></td>
      <td class="num">${fmtNum(r.posted)}</td>
      <td class="num">${fmtNum(r.active_videos)}</td>
      <td class="num">${fmtNum(r.views)}</td>
      <td class="num">${ttPct(r.engagement_rate)}</td>
      <td class="num">${fmtNum(r.clicks)}</td>
      <td class="num">${ttPct(r.ctr)}</td>
      <td class="num">${ttPct(r.conversion)}</td>
      <td class="num">${ttMoney(r.video_gmv)}</td>
      <td class="num">${r.live_revenue ? ttMoney(r.live_revenue) : '—'}</td>
    </tr>`).join('') : `<tr><td colspan="${CREATOR_COLS.length}" class="muted">No creators in this period.</td></tr>`;
}

const PRODUCT_COLS = [
  { label: 'Product' },
  { label: 'Revenue', sort: 'revenue', num: true },
  { label: 'Orders', sort: 'orders', num: true },
  { label: 'Items', sort: 'items', num: true },
  { label: 'Commission', sort: 'commission', num: true },
  { label: 'Return', num: true },
  { label: 'Selling creators', sort: 'creators', num: true },
  { label: 'Videos (aff.)', sort: 'videos', num: true },
  { label: 'New videos', sort: 'new_videos', num: true },
  { label: 'Impressions', sort: 'impressions', num: true },
  { label: 'Clicks', sort: 'clicks', num: true },
  { label: 'CTR', num: true },
  { label: 'Conv.', num: true },
  { label: 'Video GMV', sort: 'video_gmv', num: true },
  { label: 'Samples', num: true },
];

// shopifyStoreDomain comes from app.js's loadConfig() (SHOPIFY_STORE_DOMAIN = the KOL store).
function ttShopifyProductLink(productId, label) {
  return shopifyStoreDomain
    ? `<a href="https://${esc(shopifyStoreDomain)}/admin/products/${esc(productId)}" target="_blank" rel="noopener">${esc(label)}</a>`
    : esc(label);
}

function ttShopifyBadge(r) {
  if (!r.sku_count) return '<span class="tt-tag">not in catalogue</span>';
  const cls = r.skus_matched === r.sku_count ? 'tt-tag-ok' : r.skus_matched ? 'tt-tag-warn' : 'tt-tag-bad';
  return `<span class="tt-tag ${cls}" title="TikTok SKUs mapped to a Shopify variant">Shopify ${r.skus_matched}/${r.sku_count}</span>`;
}

async function ttLoadProducts() {
  const { status, json } = await api(`/tiktok/products?${ttQuery({ sort: tt.sort.products, q: $('#tt-search').value.trim(), limit: '200' })}`);
  if (status !== 200) return ttShowError(json);
  $('#tt-table-heading').textContent = 'Product performance';
  $('#tt-table-note').textContent = `${fmtNum(json.total)} products with sales or video impressions in the period (top 200 shown). Samples and sample ROI arrive with the Shopify sample data.`;
  $('#tt-thead').innerHTML = ttHeader(PRODUCT_COLS, 'products');
  $('#tt-tbody').innerHTML = json.rows.length ? json.rows.map((r) => `
    <tr>
      <td class="tt-product-cell">
        <a href="#" class="tt-open-product" data-id="${esc(r.product_id)}" title="${esc(r.product_title || '')}">${esc(r.product_title || r.product_id)}</a>
        <div class="tt-sub">${esc(r.product_id)} ${ttShopifyBadge(r)}</div>
      </td>
      <td class="num">${ttMoney(r.revenue)}${ttDeltaCell(r.revenue, r.prev_revenue)}</td>
      <td class="num">${fmtNum(r.orders)}</td>
      <td class="num">${fmtNum(r.items)}</td>
      <td class="num">${ttMoney(r.commission)}</td>
      <td class="num">${ttPct(r.return_rate)}</td>
      <td class="num">${fmtNum(r.creators)}</td>
      <td class="num">${fmtNum(r.videos)} <span class="tt-sub">(${fmtNum(r.affiliate_videos)})</span></td>
      <td class="num">${fmtNum(r.new_videos)}</td>
      <td class="num">${fmtNum(r.impressions)}</td>
      <td class="num">${fmtNum(r.clicks)}</td>
      <td class="num">${ttPct(r.ctr)}</td>
      <td class="num">${ttPct(r.conversion)}</td>
      <td class="num">${ttMoney(r.video_gmv)}</td>
      <td class="num muted">—</td>
    </tr>`).join('') : `<tr><td colspan="${PRODUCT_COLS.length}" class="muted">No products in this period.</td></tr>`;
}

// ---------- drill-down modal ----------

function ttOpenModal(title, sub) {
  $('#tt-modal-title').textContent = title;
  $('#tt-modal-sub').textContent = sub;
  $('#tt-modal-body').innerHTML = '<p class="muted">Loading…</p>';
  $('#tt-modal').hidden = false;
}

function ttCloseModal() {
  $('#tt-modal').hidden = true;
  if (tt.charts.modal) { tt.charts.modal.destroy(); tt.charts.modal = null; }
}

function ttMiniTable(cols, rows) {
  if (!rows.length) return '<p class="muted">None in this period.</p>';
  return `<div class="tt-table-wrap"><table class="data-table tt-table"><thead><tr>${cols.map((c) => `<th class="${c.num ? 'num' : ''}">${c.label}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td class="${c.num ? 'num' : ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

const ttTitle = (s, n = 70) => esc(s && s.length > n ? `${s.slice(0, n)}…` : s || '');

async function ttOpenCreator(handle) {
  ttOpenModal(`@${handle}`, `${$('#tt-from').value} – ${$('#tt-to').value}`);
  const { status, json } = await api(`/tiktok/creators/${encodeURIComponent(handle)}?${ttQuery()}`);
  if (status !== 200) { $('#tt-modal-body').innerHTML = `<p class="result-msg err">${esc(json.message)}</p>`; return; }
  if (json.arm) $('#tt-modal-sub').textContent += ` · ARM ${json.arm.internal_id}${json.arm.name ? ` (${json.arm.name})` : ''}`;
  else $('#tt-modal-sub').textContent += ' · not matched to an ARM profile';

  $('#tt-modal-body').innerHTML = `
    <div class="chart-card"><h3>Monthly trend</h3><div class="chart-wrap"><canvas id="tt-modal-chart"></canvas></div></div>
    <h3>Top videos <span class="chart-subtitle">(by video GMV in the period)</span></h3>
    ${ttMiniTable([
      { label: 'Video', cell: (v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${ttTitle(v.title) || esc(v.video_id)}</a>${v.is_new ? '<span class="tt-tag tt-tag-ok">new</span>' : ''}` },
      { label: 'Posted', cell: (v) => esc(v.posted_at) },
      { label: 'Views', num: true, cell: (v) => fmtNum(v.views) },
      { label: 'Eng.', num: true, cell: (v) => ttPct(v.engagement_rate) },
      { label: 'Clicks', num: true, cell: (v) => fmtNum(v.clicks) },
      { label: 'CTR', num: true, cell: (v) => ttPct(v.ctr) },
      { label: 'Video GMV', num: true, cell: (v) => ttMoney(v.video_gmv) },
      { label: 'Order revenue', num: true, cell: (v) => (v.revenue ? ttMoney(v.revenue) : '—') },
      { label: 'Orders', num: true, cell: (v) => fmtNum(v.orders || 0) },
    ], json.videos)}
    <h3>Top products</h3>
    ${ttMiniTable([
      { label: 'Product', cell: (p) => `<a href="#" class="tt-open-product" data-id="${esc(p.product_id)}">${ttTitle(p.product_title || p.product_id, 60)}</a>` },
      { label: 'Revenue', num: true, cell: (p) => ttMoney(p.revenue) },
      { label: 'Orders', num: true, cell: (p) => fmtNum(p.orders) },
      { label: 'Items', num: true, cell: (p) => fmtNum(p.items) },
      { label: 'Commission', num: true, cell: (p) => ttMoney(p.commission) },
      { label: 'Videos', num: true, cell: (p) => fmtNum(p.videos) },
      { label: 'Impressions', num: true, cell: (p) => fmtNum(p.impressions) },
      { label: 'Clicks', num: true, cell: (p) => fmtNum(p.clicks) },
    ], json.products)}
    <h3>LIVE sessions</h3>
    ${ttMiniTable([
      { label: 'Title', cell: (l) => ttTitle(l.title, 60) },
      { label: 'Started', cell: (l) => esc(l.started_at) },
      { label: 'Minutes', num: true, cell: (l) => fmtNum(l.minutes) },
      { label: 'Views', num: true, cell: (l) => fmtNum(l.views) },
      { label: 'Order revenue', num: true, cell: (l) => ttMoney(l.revenue) },
    ], json.lives)}`;
  tt.charts.modal = new Chart($('#tt-modal-chart'), ttMonthlyConfig(json.monthly));
}

async function ttOpenProduct(id) {
  ttOpenModal(`Product ${id}`, `${$('#tt-from').value} – ${$('#tt-to').value}`);
  const { status, json } = await api(`/tiktok/products/${encodeURIComponent(id)}?${ttQuery()}`);
  if (status !== 200) { $('#tt-modal-body').innerHTML = `<p class="result-msg err">${esc(json.message)}</p>`; return; }
  const p = json.product;
  $('#tt-modal-title').textContent = p.product_title || `Product ${id}`;
  $('#tt-modal-sub').innerHTML = `${esc($('#tt-modal-sub').textContent)} · TikTok ${esc(id)}${p.shopify_product_id
    ? ` · Shopify ${ttShopifyProductLink(p.shopify_product_id, p.shopify_product_title || p.shopify_product_id)}` : ''} · ${p.skus_matched ?? 0}/${p.sku_count ?? 0} SKUs mapped to Shopify`;

  $('#tt-modal-body').innerHTML = `
    <div class="chart-card"><h3>Daily revenue &amp; product clicks</h3><div class="chart-wrap"><canvas id="tt-modal-chart"></canvas></div></div>
    <h3>Top creators</h3>
    ${ttMiniTable([
      { label: 'Creator', cell: (c) => ttCreatorCell(c.creator_key, c.arm) },
      { label: 'Revenue', num: true, cell: (c) => ttMoney(c.revenue) },
      { label: 'Orders', num: true, cell: (c) => fmtNum(c.orders) },
      { label: 'Items', num: true, cell: (c) => fmtNum(c.items) },
      { label: 'Commission', num: true, cell: (c) => ttMoney(c.commission) },
      { label: 'Videos', num: true, cell: (c) => fmtNum(c.videos) },
      { label: 'Impressions', num: true, cell: (c) => fmtNum(c.impressions) },
      { label: 'Clicks', num: true, cell: (c) => fmtNum(c.clicks) },
    ], json.creators)}
    <h3>Top videos for this product</h3>
    ${ttMiniTable([
      { label: 'Video', cell: (v) => `<a href="${esc(v.url)}" target="_blank" rel="noopener">${ttTitle(v.title) || esc(v.video_id)}</a>` },
      { label: 'Creator', cell: (v) => `@${esc(v.creator_key)}` },
      { label: 'Posted', cell: (v) => esc(v.posted_at) },
      { label: 'Impressions', num: true, cell: (v) => fmtNum(v.impressions) },
      { label: 'Clicks', num: true, cell: (v) => fmtNum(v.clicks) },
      { label: 'SKU orders', num: true, cell: (v) => fmtNum(v.sku_orders) },
      { label: 'Video GMV', num: true, cell: (v) => ttMoney(v.video_gmv) },
    ], json.videos)}
    <details class="tt-definitions"><summary>SKUs and Shopify mapping (${json.skus.length})</summary>
    ${ttMiniTable([
      { label: 'Seller SKU', cell: (s) => esc(s.seller_sku) },
      { label: 'Shopify SKU', cell: (s) => (s.shopify_product_id
        ? ttShopifyProductLink(s.shopify_product_id, s.shopify_sku || `product ${s.shopify_product_id}`)
        : '<span class="tt-tag tt-tag-bad">unmatched</span>') },
      { label: 'Match', cell: (s) => `${esc(s.match_method || '')}${s.match_products > 1 ? ` <span class="tt-tag tt-tag-warn" title="This EAN is on ${s.match_products} Shopify products; the active / newest one is used">${s.match_products} products</span>` : ''}` },
      { label: 'Status', cell: (s) => esc(s.sku_status || '') },
      { label: 'Price', num: true, cell: (s) => ttMoney(s.price) },
      { label: 'Stock', num: true, cell: (s) => fmtNum(s.inventory_qty) },
    ], json.skus)}
    </details>`;
  const base = ttChartOptions(true);
  tt.charts.modal = new Chart($('#tt-modal-chart'), {
    type: 'bar',
    data: {
      labels: json.daily.map((d) => d.day.slice(5)),
      datasets: [
        { label: 'Revenue', data: json.daily.map((d) => d.revenue), backgroundColor: PALETTE[0], yAxisID: 'y' },
        { label: 'Product clicks', data: json.daily.map((d) => d.clicks), type: 'line', borderColor: PALETTE[2], backgroundColor: PALETTE[2], pointRadius: 0, yAxisID: 'y1' },
      ],
    },
    options: { ...base, scales: { x: base.scales.x, y: base.scales.y, y1: { position: 'right', beginAtZero: true, grid: { display: false } } } },
  });
}

// ---------- wiring ----------

$all('.tt-view-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('.tt-view-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    tt.view = btn.dataset.view;
    $('#tt-arm-only-wrap').hidden = tt.view !== 'creators';
    $('#tt-search').value = '';
    (tt.view === 'creators' ? ttLoadCreators() : ttLoadProducts());
  });
});

$('#tt-preset').addEventListener('change', () => {
  ttSetPeriodFromPreset();
  if ($('#tt-preset').value !== 'custom') ttRefresh();
});
['#tt-from', '#tt-to'].forEach((sel) => $(sel).addEventListener('change', () => { $('#tt-preset').value = 'custom'; }));
$('#tt-apply-btn').addEventListener('click', ttRefresh);
$('#tt-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') (tt.view === 'creators' ? ttLoadCreators() : ttLoadProducts()); });
$('#tt-arm-only').addEventListener('change', ttLoadCreators);

$('#tt-thead').addEventListener('click', (e) => {
  const th = e.target.closest('.tt-sortable');
  if (!th) return;
  tt.sort[tt.view] = th.dataset.sort;
  (tt.view === 'creators' ? ttLoadCreators() : ttLoadProducts());
});

document.addEventListener('click', (e) => {
  const creator = e.target.closest('.tt-open-creator');
  const product = e.target.closest('.tt-open-product');
  if (creator) { e.preventDefault(); ttOpenCreator(creator.dataset.handle); }
  if (product) { e.preventDefault(); ttOpenProduct(product.dataset.id); }
});

$('#tt-modal').addEventListener('click', (e) => { if (e.target === $('#tt-modal')) ttCloseModal(); });
$('#tt-modal-close').addEventListener('click', ttCloseModal);
$('#tt-modal-close-btn').addEventListener('click', ttCloseModal);

$('.tab-btn[data-tab="tiktok"]').addEventListener('click', loadTikTokTab);
