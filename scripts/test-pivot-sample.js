// ============================================================
// scripts/test-pivot-sample.js — 產生 sample_pivot.xlsx 供人工驗證
//
// 連線 Supabase（用 .env），對指定日期範圍跑 buildBetExportPivot，
// 把真 .xlsx 寫到專案根目錄 sample_pivot.xlsx（已列入 .gitignore，不入版控）。
//
// 用法：
//   node scripts/test-pivot-sample.js            # 預設 6/12-6/13
//   node scripts/test-pivot-sample.js 6/12-6/13  # 自訂範圍
//   node scripts/test-pivot-sample.js all        # 全部
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const { buildBetExportPivot } = require('../betExportPivot');

const YEAR = 2026;
const OUT_PATH = path.join(__dirname, '..', 'sample_pivot.xlsx');

// 與 index.js parseExportDateRange 同邏輯（精簡版，供 CLI 驗證用）
function parseRange(input) {
  const t = String(input || '6/12-6/13').trim().toLowerCase();
  if (t === 'all' || t === '全部') {
    return { start: `${YEAR}-01-01 00:00`, end: `${YEAR}-12-31 23:59` };
  }
  const toIso = (md) => {
    const m = md.trim().match(/^(\d{1,2})\s*[\/月]\s*(\d{1,2})/);
    return m ? `${YEAR}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}` : null;
  };
  const parts = t.split(/[-~到]/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) {
    const d = toIso(parts[0]);
    return d ? { start: `${d} 00:00`, end: `${d} 23:59` } : null;
  }
  const d1 = toIso(parts[0]), d2 = toIso(parts[1]);
  return (d1 && d2) ? { start: `${d1} 00:00`, end: `${d2} 23:59` } : null;
}

async function main() {
  const dateRange = parseRange(process.argv[2]);
  if (!dateRange) throw new Error('日期格式錯誤，例：6/12 或 6/12-6/13 或 all');

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const { buffer, rowCount, members, cols } = await buildBetExportPivot({ supabase, dateRange });

  fs.writeFileSync(OUT_PATH, buffer);
  console.log(`✅ 已產出 ${OUT_PATH}`);
  console.log(`   範圍：${dateRange.start} ~ ${dateRange.end}`);
  console.log(`   會員（${members.length}）：${members.join('、')}`);
  console.log(`   欄位：${cols.join(' | ')}`);
  console.log(`   資料列數（含 header）：${rowCount}`);
}

main().catch(e => { console.error('❌ 產生失敗：', e.message || e); process.exit(1); });
