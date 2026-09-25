/**
 * Builds the Profiles-tab "Export as Excel" workbook from arm-worker-v2's
 * GET /admin/profiles/export response. Two sheets, not one wide sheet with
 * per-channel columns, so a profile with several handles on the same
 * channel (e.g. two TikTok handles) doesn't need a variable-width layout —
 * every handle just gets its own row in Handles, keyed by Internal ID.
 */

import ExcelJS from 'exceljs';

// Same offset arm-worker-v2 itself uses for "today"/"this month" boundaries
// (src/index.js TZ_OFFSET_MS) — Thailand has no DST, so a fixed offset holds
// year-round.
const THAI_OFFSET_MS = 7 * 60 * 60 * 1000;

const CHANNEL_LABELS = {
  tiktok: 'TikTok',
  shopee: 'Shopee',
  lazada: 'Lazada',
  affiliate_plus: 'Affiliate+',
};

function pad2(n) {
  return String(n).padStart(2, '0');
}

// dob is stored as a plain "YYYY-MM-DD" string with no time/timezone
// component — formatted directly from the string parts rather than via
// Date(), which would reinterpret it as UTC and can shift the day.
export function formatDateOnly(dateStr) {
  const s = String(dateStr || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

// epoch-ms fields (created_at, updated_at, shopify_synced_at, handle
// registered_at) rendered in Thailand local time.
export function formatDateTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms) + THAI_OFFSET_MS);
  const hours24 = d.getUTCHours();
  const ampm = hours24 >= 12 ? 'PM' : 'AM';
  const hh = pad2(hours24);
  const mm = pad2(d.getUTCMinutes());
  const day = pad2(d.getUTCDate());
  const month = pad2(d.getUTCMonth() + 1);
  const year = d.getUTCFullYear();
  return `${hh}:${mm} ${ampm} ${day}/${month}/${year}`;
}

export function buildProfilesWorkbook(profiles) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'arm-admin-dashboard';
  workbook.created = new Date();

  const profilesSheet = workbook.addWorksheet('Profiles');
  profilesSheet.columns = [
    { header: 'Internal ID', key: 'internal_id', width: 14 },
    { header: 'Line UID', key: 'line_uid', width: 22 },
    { header: 'Email', key: 'email', width: 28 },
    { header: 'Phone', key: 'phone', width: 16 },
    { header: 'Nickname', key: 'nick_name', width: 18 },
    { header: 'Full Name', key: 'full_name', width: 24 },
    { header: 'Gender', key: 'gender', width: 12 },
    { header: 'Date of Birth', key: 'dob', width: 14 },
    { header: 'Age', key: 'age', width: 8 },
    { header: 'Shopify Customer ID', key: 'shopify_customer_id', width: 26 },
    { header: 'Shopify Synced At', key: 'shopify_synced_at', width: 22 },
    { header: 'Registered At', key: 'created_at', width: 22 },
    { header: 'Updated At', key: 'updated_at', width: 22 },
    { header: 'Handle Count', key: 'handle_count', width: 12 },
  ];
  profilesSheet.getRow(1).font = { bold: true };
  profilesSheet.autoFilter = { from: 'A1', to: 'N1' };
  profilesSheet.views = [{ state: 'frozen', ySplit: 1 }];

  const handlesSheet = workbook.addWorksheet('Handles');
  handlesSheet.columns = [
    { header: 'Internal ID', key: 'internal_id', width: 14 },
    { header: 'Nickname', key: 'nick_name', width: 18 },
    { header: 'Full Name', key: 'full_name', width: 24 },
    { header: 'Channel', key: 'channel', width: 14 },
    { header: 'Handle', key: 'value', width: 28 },
    { header: 'Registered At', key: 'registered_at', width: 22 },
    { header: 'Status', key: 'status', width: 12 },
  ];
  handlesSheet.getRow(1).font = { bold: true };
  handlesSheet.autoFilter = { from: 'A1', to: 'G1' };
  handlesSheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const p of profiles) {
    const handles = p.handles || [];
    profilesSheet.addRow({
      internal_id: p.internal_id,
      line_uid: p.line_uid,
      email: p.email,
      phone: p.phone,
      nick_name: p.nick_name || '',
      full_name: p.full_name || '',
      gender: p.gender || '',
      dob: formatDateOnly(p.dob),
      age: p.age ?? '',
      shopify_customer_id: p.shopify_customer_id || '',
      shopify_synced_at: formatDateTime(p.shopify_synced_at),
      created_at: formatDateTime(p.created_at),
      updated_at: formatDateTime(p.updated_at),
      handle_count: handles.length,
    });

    // One row per handle — a profile with, say, two TikTok handles just
    // produces two rows here rather than needing extra dynamic columns.
    for (const h of handles) {
      handlesSheet.addRow({
        internal_id: p.internal_id,
        nick_name: p.nick_name || '',
        full_name: p.full_name || '',
        channel: CHANNEL_LABELS[h.channel] || h.channel,
        value: h.value,
        registered_at: formatDateTime(h.registered_at),
        status: h.is_active ? 'Active' : 'Inactive',
      });
    }
  }

  return workbook;
}
