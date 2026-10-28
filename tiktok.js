/**
 * TikTok tab — read-only reports over the Postgres copy that arm-tiktok-cron
 * keeps of IT's TikTok Analytics API (tables tt_*, views tt_order_lines,
 * tt_video_dim, tt_products — see arm-tiktok-cron/sql).
 *
 * Definitions (keep in sync with the tab's footnotes in index.html):
 *   - Periods are Bangkok calendar days; every report also returns the
 *     previous period of the same length for comparison.
 *   - Sales (revenue, orders, items, commission, returns) come from affiliate
 *     order lines, by order create date; cancelled/unpaid lines are excluded.
 *   - Engagement (views, likes, impressions, clicks, video GMV) comes from
 *     per-video daily metrics, by metric date.
 *   - New revenue video = posted in the period AND video GMV > 0 in the period.
 *   - Creators are matched to ARM profiles by TikTok handle (case-insensitive,
 *     "@" and profile-URL prefixes stripped) from arm-worker-v2's profile export.
 */

import express from 'express';
import pg from 'pg';

const DAY_MS = 864e5;
const CACHE_TTL_MS = 10 * 60 * 1000;

const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY_MS));
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function normalizeHandle(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(www\.|vt\.|m\.)?tiktok\.com\//, '')
    .replace(/^@/, '')
    .replace(/[/?#].*$/, '');
}

// `pool` can be passed instead of databaseUrl (anything with pg's query(text, params) -> { rows }).
export function tiktokRouter({ databaseUrl, callWorker, pool }) {
  const router = express.Router();

  if (!databaseUrl && !pool) {
    router.use((req, res) => res.status(503).json({ code: 'TIKTOK_NOT_CONFIGURED', message: 'TIKTOK_DATABASE_URL is not set on arm-admin-dashboard' }));
    return router;
  }

  if (!pool) {
    pool = new pg.Pool({ connectionString: databaseUrl, max: 5, statement_timeout: 60000 });
    // numeric/bigint -> JS number for the JSON responses (amounts stay well inside double precision).
    pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
    pg.types.setTypeParser(1082, (v) => v); // date stays 'YYYY-MM-DD'
  }

  const cache = new Map();
  async function cached(key, fn) {
    const hit = cache.get(key);
    if (hit && hit.at > Date.now() - CACHE_TTL_MS) return hit.value;
    const value = await fn();
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return value;
  }
  const q = async (text, params) => (await pool.query(text, params)).rows;

  // handle -> { internal_id, name } for every ARM profile with a TikTok handle.
  // If the worker can't be reached the reports still load, just without ARM matches (not cached).
  async function armHandles() {
    const map = await cached('arm-handles', async () => {
      const { status, json } = await callWorker('/admin/profiles/export?channels=tiktok');
      if (status !== 200) {
        console.error(`tiktok: ARM profile export failed (${status})`, json);
        return null;
      }
      const map = {};
      for (const p of json.profiles || []) {
        for (const h of p.handles || []) {
          if (h.channel !== 'tiktok') continue;
          const key = normalizeHandle(h.value);
          if (key) map[key] = { internal_id: p.internal_id, name: p.nick_name || p.full_name || null };
        }
      }
      return map;
    });
    if (!map) cache.delete('arm-handles');
    return map || {};
  }

  async function latestDay() {
    const [row] = await q(`SELECT to_char(max(metric_date), 'YYYY-MM-DD') d FROM tt_sync_days`);
    return row.d || addDays(ymd(new Date(Date.now() + 7 * 3600e3)), -1);
  }

  // from/to from the query string, defaulting to the 30 days ending on the latest synced day.
  async function period(req) {
    let { from, to } = req.query;
    if (!isDate(to)) to = await latestDay();
    if (!isDate(from)) from = addDays(to, -29);
    if (from > to) [from, to] = [to, from];
    const days = Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS) + 1;
    if (days > 366) throw Object.assign(new Error('Period is limited to 366 days'), { status: 400 });
    return { from, to, days, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
  }

  const route = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (err) {
      console.error('tiktok', req.path, err);
      res.status(err.status || 500).json({ code: 'TIKTOK_QUERY_FAILED', message: err.message });
    }
  };

  // ---------- SQL building blocks ($1 = from, $2 = to, Bangkok days) ----------

  const ORDER_RANGE = `create_time >= ($1::date::timestamp AT TIME ZONE 'Asia/Bangkok')
    AND create_time < (($2::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok')`;

  const SALES_COLS = `
    count(DISTINCT order_id) FILTER (WHERE NOT is_cancelled) AS orders,
    coalesce(sum(quantity) FILTER (WHERE NOT is_cancelled), 0) AS items,
    coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled), 0) AS revenue,
    coalesce(sum(commission) FILTER (WHERE NOT is_cancelled), 0) AS commission,
    count(*) FILTER (WHERE NOT is_cancelled) AS lines,
    count(*) FILTER (WHERE NOT is_cancelled AND is_returned) AS returned_lines,
    count(*) FILTER (WHERE is_cancelled) AS cancelled_lines,
    coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled AND content_type = 'LIVE'), 0) AS live_revenue,
    coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled AND content_type = 'VIDEO'), 0) AS video_revenue`;

  const ENGAGEMENT_COLS = `
    count(DISTINCT d.video_id) FILTER (WHERE d.views > 0) AS active_videos,
    coalesce(sum(d.views), 0) AS views,
    coalesce(sum(d.likes), 0) AS likes,
    coalesce(sum(d.comments), 0) AS comments,
    coalesce(sum(d.shares), 0) AS shares,
    coalesce(sum(d.product_impressions), 0) AS impressions,
    coalesce(sum(d.product_clicks), 0) AS clicks,
    coalesce(sum(d.sku_orders), 0) AS video_sku_orders,
    coalesce(sum(d.gmv), 0) AS video_gmv`;

  // Posted in the period, with their GMV inside the period.
  const NEW_VIDEOS_CTE = `new_videos AS (
    SELECT v.video_id, v.creator_key, v.creator_group, coalesce(sum(d.gmv), 0) AS gmv
    FROM tt_video_dim v
    LEFT JOIN tt_video_daily d ON d.store_id = v.store_id AND d.video_id = v.video_id AND d.metric_date BETWEEN $1 AND $2
    WHERE v.video_post_time >= $1::date AND v.video_post_time < $2::date + 1
    GROUP BY 1, 2, 3)`;

  function withRates(r) {
    const div = (a, b) => (b ? a / b : null);
    return {
      ...r,
      aov: div(r.revenue, r.orders),
      return_rate: div(r.returned_lines, r.lines),
      ctr: div(r.clicks, r.impressions),
      conversion: div(r.video_sku_orders, r.clicks),
      engagement_rate: div((r.likes || 0) + (r.comments || 0) + (r.shares || 0), r.views),
    };
  }

  // ---------- endpoints ----------

  router.get('/meta', route(async () => {
    const [days] = await q(`SELECT to_char(min(metric_date), 'YYYY-MM-DD') first_day, to_char(max(metric_date), 'YYYY-MM-DD') last_day, count(*) days FROM tt_sync_days`);
    const [run] = await q(`SELECT started_at, finished_at, ok, error FROM tt_sync_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1`);
    return { ...days, last_run: run || null };
  }));

  router.get('/summary', route(async (req) => {
    const p = await period(req);
    return cached(`summary:${p.from}:${p.to}`, async () => {
      const totals = async (from, to) => {
        const [sales] = await q(`SELECT ${SALES_COLS}, count(DISTINCT creator_key) FILTER (WHERE NOT is_cancelled) AS selling_creators
          FROM tt_order_lines WHERE ${ORDER_RANGE}`, [from, to]);
        const [eng] = await q(`SELECT ${ENGAGEMENT_COLS} FROM tt_video_daily d WHERE d.metric_date BETWEEN $1 AND $2`, [from, to]);
        const [nv] = await q(`WITH ${NEW_VIDEOS_CTE}
          SELECT count(*) AS posted, count(*) FILTER (WHERE gmv > 0) AS new_revenue_videos,
                 count(*) FILTER (WHERE gmv > 0 AND creator_group = 'Affiliate') AS new_revenue_videos_affiliate
          FROM new_videos`, [from, to]);
        const [live] = await q(`SELECT count(*) AS live_sessions, coalesce(sum(live_attributed_gmv), 0) AS live_gmv
          FROM tt_live_sessions WHERE start_time >= $1::date AND start_time < $2::date + 1`, [from, to]);
        return withRates({ ...sales, ...eng, ...nv, ...live });
      };
      const [current, previous] = await Promise.all([totals(p.from, p.to), totals(p.prevFrom, p.prevTo)]);

      const split = await q(`SELECT v.creator_group, count(DISTINCT d.video_id) FILTER (WHERE d.views > 0) AS active_videos,
          coalesce(sum(d.views), 0) AS views, coalesce(sum(d.gmv), 0) AS video_gmv
        FROM tt_video_daily d JOIN tt_video_dim v ON v.store_id = d.store_id AND v.video_id = d.video_id
        WHERE d.metric_date BETWEEN $1 AND $2 GROUP BY 1`, [p.from, p.to]);

      const daily = await q(`WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day),
        o AS (SELECT order_date AS day, sum(gross_amount) FILTER (WHERE NOT is_cancelled) AS revenue,
                     sum(commission) FILTER (WHERE NOT is_cancelled) AS commission
              FROM tt_order_lines WHERE ${ORDER_RANGE} GROUP BY 1),
        e AS (SELECT d.metric_date AS day, sum(d.views) AS views,
                     sum(d.gmv) FILTER (WHERE v.creator_group = 'GQ') AS gmv_gq,
                     sum(d.gmv) FILTER (WHERE v.creator_group = 'Affiliate') AS gmv_affiliate
              FROM tt_video_daily d JOIN tt_video_dim v ON v.store_id = d.store_id AND v.video_id = d.video_id
              WHERE d.metric_date BETWEEN $1 AND $2 GROUP BY 1)
        SELECT to_char(days.day, 'YYYY-MM-DD') AS day, coalesce(o.revenue, 0) AS revenue, coalesce(o.commission, 0) AS commission,
               coalesce(e.views, 0) AS views, coalesce(e.gmv_gq, 0) AS gmv_gq, coalesce(e.gmv_affiliate, 0) AS gmv_affiliate
        FROM days LEFT JOIN o USING (day) LEFT JOIN e USING (day) ORDER BY 1`, [p.from, p.to]);

      const monthly = await q(`WITH o AS (
          SELECT date_trunc('month', order_date)::date AS month, sum(gross_amount) FILTER (WHERE NOT is_cancelled) AS revenue,
                 sum(commission) FILTER (WHERE NOT is_cancelled) AS commission, count(DISTINCT order_id) FILTER (WHERE NOT is_cancelled) AS orders
          FROM tt_order_lines GROUP BY 1),
        nv AS (
          SELECT date_trunc('month', v.post_date)::date AS month, count(DISTINCT v.video_id) AS new_revenue_videos
          FROM tt_video_dim v JOIN tt_video_daily d ON d.store_id = v.store_id AND d.video_id = v.video_id
            AND date_trunc('month', d.metric_date) = date_trunc('month', v.post_date)
          WHERE d.gmv > 0 GROUP BY 1)
        SELECT to_char(o.month, 'YYYY-MM') AS month, o.revenue, o.commission, o.orders, coalesce(nv.new_revenue_videos, 0) AS new_revenue_videos
        FROM o LEFT JOIN nv USING (month)
        WHERE o.month >= (SELECT date_trunc('month', min(metric_date)) FROM tt_sync_days)
        ORDER BY 1 DESC LIMIT 13`);

      return { period: p, current, previous, split, daily, monthly: monthly.reverse() };
    });
  }));

  const CREATOR_SORTS = ['revenue', 'commission', 'orders', 'items', 'views', 'video_gmv', 'new_revenue_videos', 'active_videos', 'clicks', 'live_revenue'];

  router.get('/creators', route(async (req) => {
    const p = await period(req);
    const sort = CREATOR_SORTS.includes(req.query.sort) ? req.query.sort : 'revenue';
    const armOnly = req.query.arm === '1';
    const search = normalizeHandle(req.query.q || '');
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const arm = await armHandles();

    const rows = await cached(`creators:${p.from}:${p.to}`, async () => {
      const list = await q(`WITH ${NEW_VIDEOS_CTE},
        o AS (SELECT creator_key, ${SALES_COLS}, count(DISTINCT content_id) FILTER (WHERE NOT is_cancelled AND content_type = 'VIDEO') AS selling_videos
              FROM tt_order_lines WHERE ${ORDER_RANGE} GROUP BY 1),
        po AS (SELECT creator_key, coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled), 0) AS prev_revenue
               FROM tt_order_lines WHERE create_time >= ($3::date::timestamp AT TIME ZONE 'Asia/Bangkok')
                 AND create_time < (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok') GROUP BY 1),
        e AS (SELECT v.creator_key, max(v.creator_group) AS creator_group, ${ENGAGEMENT_COLS}
              FROM tt_video_daily d JOIN tt_video_dim v ON v.store_id = d.store_id AND v.video_id = d.video_id
              WHERE d.metric_date BETWEEN $1 AND $2 GROUP BY 1),
        nv AS (SELECT creator_key, count(*) AS posted, count(*) FILTER (WHERE gmv > 0) AS new_revenue_videos FROM new_videos GROUP BY 1),
        l AS (SELECT lower(creator_user_name) AS creator_key, count(*) AS live_sessions, coalesce(sum(views), 0) AS live_views
              FROM tt_live_sessions WHERE start_time >= $1::date AND start_time < $2::date + 1 GROUP BY 1)
        SELECT k.creator_key, coalesce(e.creator_group, 'Affiliate') AS creator_group,
               coalesce(o.orders, 0) AS orders, coalesce(o.items, 0) AS items, coalesce(o.revenue, 0) AS revenue,
               coalesce(o.commission, 0) AS commission, coalesce(o.lines, 0) AS lines, coalesce(o.returned_lines, 0) AS returned_lines,
               coalesce(o.live_revenue, 0) AS live_revenue, coalesce(o.video_revenue, 0) AS video_revenue,
               coalesce(o.selling_videos, 0) AS selling_videos, coalesce(po.prev_revenue, 0) AS prev_revenue,
               coalesce(e.active_videos, 0) AS active_videos, coalesce(e.views, 0) AS views, coalesce(e.likes, 0) AS likes,
               coalesce(e.comments, 0) AS comments, coalesce(e.shares, 0) AS shares, coalesce(e.impressions, 0) AS impressions,
               coalesce(e.clicks, 0) AS clicks, coalesce(e.video_sku_orders, 0) AS video_sku_orders, coalesce(e.video_gmv, 0) AS video_gmv,
               coalesce(nv.posted, 0) AS posted, coalesce(nv.new_revenue_videos, 0) AS new_revenue_videos,
               coalesce(l.live_sessions, 0) AS live_sessions, coalesce(l.live_views, 0) AS live_views
        FROM (SELECT creator_key FROM o UNION SELECT creator_key FROM e WHERE views >= 100 OR video_gmv > 0
              UNION SELECT creator_key FROM nv UNION SELECT creator_key FROM l) k
        LEFT JOIN o USING (creator_key) LEFT JOIN po USING (creator_key) LEFT JOIN e USING (creator_key)
        LEFT JOIN nv USING (creator_key) LEFT JOIN l USING (creator_key)
        WHERE k.creator_key IS NOT NULL AND k.creator_key <> ''`, [p.from, p.to, p.prevFrom, p.prevTo]);
      return list.map(withRates);
    });

    let out = rows.map((r) => ({ ...r, arm: arm[r.creator_key] || null }));
    const totalCreators = out.length;
    const armMatched = out.filter((r) => r.arm).length;
    if (armOnly) out = out.filter((r) => r.arm);
    if (search) out = out.filter((r) => r.creator_key.includes(search) || (r.arm?.name || '').toLowerCase().includes(search));
    out.sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
    return { period: p, sort, total: out.length, total_creators: totalCreators, arm_matched: armMatched, rows: out.slice(0, limit) };
  }));

  router.get('/creators/:handle', route(async (req) => {
    const p = await period(req);
    const key = normalizeHandle(req.params.handle);
    const arm = (await armHandles())[key] || null;
    const params = [p.from, p.to, key];

    const videos = await q(`SELECT v.video_id, v.title, to_char(v.video_post_time, 'YYYY-MM-DD HH24:MI') AS posted_at,
        v.post_date BETWEEN $1 AND $2 AS is_new, ${ENGAGEMENT_COLS}
      FROM tt_video_daily d JOIN tt_video_dim v ON v.store_id = d.store_id AND v.video_id = d.video_id
      WHERE v.creator_key = $3 AND d.metric_date BETWEEN $1 AND $2
      GROUP BY 1, 2, 3, 4 ORDER BY video_gmv DESC, views DESC LIMIT 50`, params);
    const videoSales = await q(`SELECT content_id, ${SALES_COLS} FROM tt_order_lines
      WHERE creator_key = $3 AND ${ORDER_RANGE} AND content_type = 'VIDEO' GROUP BY 1`, params);
    const salesByVideo = Object.fromEntries(videoSales.map((r) => [r.content_id, r]));

    const products = await q(`WITH o AS (SELECT product_id, ${SALES_COLS} FROM tt_order_lines WHERE creator_key = $3 AND ${ORDER_RANGE} GROUP BY 1),
        e AS (SELECT pd.product_id, count(DISTINCT pd.video_id) FILTER (WHERE pd.product_impressions > 0) AS videos,
                     coalesce(sum(pd.product_impressions), 0) AS impressions, coalesce(sum(pd.product_clicks), 0) AS clicks,
                     coalesce(sum(pd.gmv), 0) AS video_gmv
              FROM tt_video_product_daily pd JOIN tt_video_dim v ON v.store_id = pd.store_id AND v.video_id = pd.video_id
              WHERE v.creator_key = $3 AND pd.metric_date BETWEEN $1 AND $2 GROUP BY 1)
      SELECT product_id, pr.product_title, pr.shopify_product_id, coalesce(o.revenue, 0) AS revenue, coalesce(o.orders, 0) AS orders,
             coalesce(o.items, 0) AS items, coalesce(o.commission, 0) AS commission, coalesce(e.videos, 0) AS videos,
             coalesce(e.impressions, 0) AS impressions, coalesce(e.clicks, 0) AS clicks, coalesce(e.video_gmv, 0) AS video_gmv
      FROM o FULL JOIN e USING (product_id) LEFT JOIN tt_products pr USING (product_id)
      ORDER BY revenue DESC, video_gmv DESC LIMIT 30`, params);

    const lives = await q(`SELECT live_id, title, to_char(start_time, 'YYYY-MM-DD HH24:MI') AS started_at,
        round(extract(epoch FROM end_time - start_time) / 60) AS minutes, views, likes, live_attributed_gmv AS live_gmv
      FROM tt_live_sessions WHERE lower(creator_user_name) = $3 AND start_time >= $1::date AND start_time < $2::date + 1
      ORDER BY start_time DESC LIMIT 30`, params);
    const liveSales = await q(`SELECT content_id, coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled), 0) AS revenue
      FROM tt_order_lines WHERE creator_key = $3 AND ${ORDER_RANGE} AND content_type = 'LIVE' GROUP BY 1`, params);
    const liveRevenue = Object.fromEntries(liveSales.map((r) => [r.content_id, r.revenue]));

    const monthly = await q(`WITH o AS (SELECT date_trunc('month', order_date)::date AS month,
            coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled), 0) AS revenue,
            coalesce(sum(commission) FILTER (WHERE NOT is_cancelled), 0) AS commission
          FROM tt_order_lines WHERE creator_key = $1 GROUP BY 1),
        e AS (SELECT date_trunc('month', d.metric_date)::date AS month, sum(d.views) AS views,
            count(DISTINCT d.video_id) FILTER (WHERE d.gmv > 0 AND date_trunc('month', v.post_date) = date_trunc('month', d.metric_date)) AS new_revenue_videos
          FROM tt_video_daily d JOIN tt_video_dim v ON v.store_id = d.store_id AND v.video_id = d.video_id
          WHERE v.creator_key = $1 GROUP BY 1)
      SELECT to_char(month, 'YYYY-MM') AS month, coalesce(o.revenue, 0) AS revenue, coalesce(o.commission, 0) AS commission,
             coalesce(e.views, 0) AS views, coalesce(e.new_revenue_videos, 0) AS new_revenue_videos
      FROM o FULL JOIN e USING (month) ORDER BY 1 DESC LIMIT 13`, [key]);

    return {
      period: p,
      creator_key: key,
      arm,
      videos: videos.map((v) => withRates({ ...v, ...(salesByVideo[v.video_id] || {}), url: `https://www.tiktok.com/@${key}/video/${v.video_id}` })),
      products,
      lives: lives.map((l) => ({ ...l, revenue: liveRevenue[l.live_id] || 0 })),
      monthly: monthly.reverse(),
    };
  }));

  const PRODUCT_SORTS = ['revenue', 'orders', 'items', 'commission', 'creators', 'videos', 'new_videos', 'impressions', 'clicks', 'video_gmv'];

  router.get('/products', route(async (req) => {
    const p = await period(req);
    const sort = PRODUCT_SORTS.includes(req.query.sort) ? req.query.sort : 'revenue';
    const search = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 100, 500);

    const rows = await cached(`products:${p.from}:${p.to}`, async () => {
      const list = await q(`WITH o AS (SELECT product_id, ${SALES_COLS}, count(DISTINCT creator_key) FILTER (WHERE NOT is_cancelled) AS creators
              FROM tt_order_lines WHERE ${ORDER_RANGE} GROUP BY 1),
        po AS (SELECT product_id, coalesce(sum(gross_amount) FILTER (WHERE NOT is_cancelled), 0) AS prev_revenue
               FROM tt_order_lines WHERE create_time >= ($3::date::timestamp AT TIME ZONE 'Asia/Bangkok')
                 AND create_time < (($4::date + 1)::timestamp AT TIME ZONE 'Asia/Bangkok') GROUP BY 1),
        e AS (SELECT pd.product_id,
                     count(DISTINCT pd.video_id) FILTER (WHERE pd.product_impressions > 0) AS videos,
                     count(DISTINCT pd.video_id) FILTER (WHERE pd.product_impressions > 0 AND v.creator_group = 'Affiliate') AS affiliate_videos,
                     count(DISTINCT pd.video_id) FILTER (WHERE v.post_date BETWEEN $1 AND $2) AS new_videos,
                     count(DISTINCT pd.video_id) FILTER (WHERE pd.gmv > 0) AS selling_videos,
                     coalesce(sum(pd.product_impressions), 0) AS impressions, coalesce(sum(pd.product_clicks), 0) AS clicks,
                     coalesce(sum(pd.sku_orders), 0) AS video_sku_orders, coalesce(sum(pd.gmv), 0) AS video_gmv
              FROM tt_video_product_daily pd JOIN tt_video_dim v ON v.store_id = pd.store_id AND v.video_id = pd.video_id
              WHERE pd.metric_date BETWEEN $1 AND $2 GROUP BY 1)
        SELECT product_id, pr.product_title, pr.product_status, pr.shopify_product_id, coalesce(pr.sku_count, 0) AS sku_count,
               coalesce(pr.skus_matched, 0) AS skus_matched,
               coalesce(o.revenue, 0) AS revenue, coalesce(o.orders, 0) AS orders, coalesce(o.items, 0) AS items,
               coalesce(o.commission, 0) AS commission, coalesce(o.lines, 0) AS lines, coalesce(o.returned_lines, 0) AS returned_lines,
               coalesce(o.creators, 0) AS creators, coalesce(po.prev_revenue, 0) AS prev_revenue,
               coalesce(e.videos, 0) AS videos, coalesce(e.affiliate_videos, 0) AS affiliate_videos, coalesce(e.new_videos, 0) AS new_videos,
               coalesce(e.selling_videos, 0) AS selling_videos, coalesce(e.impressions, 0) AS impressions, coalesce(e.clicks, 0) AS clicks,
               coalesce(e.video_sku_orders, 0) AS video_sku_orders, coalesce(e.video_gmv, 0) AS video_gmv
        FROM o FULL JOIN e USING (product_id) LEFT JOIN po USING (product_id) LEFT JOIN tt_products pr USING (product_id)
        WHERE coalesce(o.revenue, 0) > 0 OR coalesce(e.impressions, 0) > 0`, [p.from, p.to, p.prevFrom, p.prevTo]);
      return list.map(withRates);
    });

    let out = rows;
    if (search) out = out.filter((r) => String(r.product_id).includes(search) || (r.product_title || '').toLowerCase().includes(search));
    out = [...out].sort((a, b) => (b[sort] || 0) - (a[sort] || 0));
    return { period: p, sort, total: out.length, rows: out.slice(0, limit) };
  }));

  router.get('/products/:id', route(async (req) => {
    const p = await period(req);
    const id = String(req.params.id).replace(/\D/g, '');
    const params = [p.from, p.to, id];
    const arm = await armHandles();

    const [product] = await q(`SELECT * FROM tt_products WHERE product_id = $1`, [id]);
    const skus = await q(`SELECT sku_id, seller_sku, shopify_sku_matched AS shopify_sku, shopify_product_id_valid AS shopify_product_id,
        shopify_variant_id_valid AS shopify_variant_id, match_method_ours AS match_method, match_products, sku_status,
        coalesce(sale_price, tax_exclusive_price) AS price, inventory_qty
      FROM tt_sku_map WHERE product_id = $1 ORDER BY seller_sku`, [id]);

    const creators = await q(`WITH o AS (SELECT creator_key, ${SALES_COLS} FROM tt_order_lines WHERE product_id = $3 AND ${ORDER_RANGE} GROUP BY 1),
        e AS (SELECT v.creator_key, count(DISTINCT pd.video_id) FILTER (WHERE pd.product_impressions > 0) AS videos,
                     coalesce(sum(pd.product_impressions), 0) AS impressions, coalesce(sum(pd.product_clicks), 0) AS clicks,
                     coalesce(sum(pd.gmv), 0) AS video_gmv
              FROM tt_video_product_daily pd JOIN tt_video_dim v ON v.store_id = pd.store_id AND v.video_id = pd.video_id
              WHERE pd.product_id = $3 AND pd.metric_date BETWEEN $1 AND $2 GROUP BY 1)
      SELECT creator_key, coalesce(o.revenue, 0) AS revenue, coalesce(o.orders, 0) AS orders, coalesce(o.items, 0) AS items,
             coalesce(o.commission, 0) AS commission, coalesce(e.videos, 0) AS videos, coalesce(e.impressions, 0) AS impressions,
             coalesce(e.clicks, 0) AS clicks, coalesce(e.video_gmv, 0) AS video_gmv
      FROM o FULL JOIN e USING (creator_key) ORDER BY revenue DESC, video_gmv DESC LIMIT 50`, params);

    const videos = await q(`SELECT v.video_id, v.creator_key, v.title, to_char(v.video_post_time, 'YYYY-MM-DD HH24:MI') AS posted_at,
        coalesce(sum(pd.product_impressions), 0) AS impressions, coalesce(sum(pd.product_clicks), 0) AS clicks,
        coalesce(sum(pd.sku_orders), 0) AS sku_orders, coalesce(sum(pd.gmv), 0) AS video_gmv
      FROM tt_video_product_daily pd JOIN tt_video_dim v ON v.store_id = pd.store_id AND v.video_id = pd.video_id
      WHERE pd.product_id = $3 AND pd.metric_date BETWEEN $1 AND $2
      GROUP BY 1, 2, 3, 4 ORDER BY video_gmv DESC, impressions DESC LIMIT 30`, params);

    const daily = await q(`WITH days AS (SELECT generate_series($1::date, $2::date, '1 day')::date AS day),
        o AS (SELECT order_date AS day, sum(gross_amount) FILTER (WHERE NOT is_cancelled) AS revenue
              FROM tt_order_lines WHERE product_id = $3 AND ${ORDER_RANGE} GROUP BY 1),
        e AS (SELECT metric_date AS day, sum(product_impressions) AS impressions, sum(product_clicks) AS clicks
              FROM tt_video_product_daily WHERE product_id = $3 AND metric_date BETWEEN $1 AND $2 GROUP BY 1)
      SELECT to_char(day, 'YYYY-MM-DD') AS day, coalesce(o.revenue, 0) AS revenue, coalesce(e.impressions, 0) AS impressions,
             coalesce(e.clicks, 0) AS clicks
      FROM days LEFT JOIN o USING (day) LEFT JOIN e USING (day) ORDER BY 1`, params);

    return {
      period: p,
      product: product || { product_id: id },
      skus,
      creators: creators.map((c) => ({ ...c, arm: arm[c.creator_key] || null })),
      videos: videos.map((v) => ({ ...v, url: `https://www.tiktok.com/@${v.creator_key}/video/${v.video_id}` })),
      daily,
    };
  }));

  return router;
}
