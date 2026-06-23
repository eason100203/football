// ============================================================
// betExportPivot.js — 下注 pivot 匯出（真 .xlsx，使用 exceljs）
//
// 產出標準 OOXML .xlsx，Excel 開啟無「格式與附檔名不符」警告，支援：
//   合併儲存格 / 背景色 / 字色 / 粗體 / 框線。
//
// ── 所有可調設定集中在下方常數，日後改色 / 改欄序 / 改格式只動這裡 ──
// ============================================================

const ExcelJS = require('exceljs');
const { getTeamNameZh } = require('./teamName.js');

// 顏色（以 #RRGGBB 維護；輸出至 exceljs 時自動補成 ARGB 8 碼）
const STYLE = {
  headerBg:        '#D3D3D3',  // Header 灰底
  matchBg:         '#DDEBF7',  // 賽程 cell 淡藍
  todayBg:         '#E2EFDA',  // Today Result 淡綠
  ttlBg:           '#FFE699',  // Total Result 金色（輔色4 較淺60%，ARGB FFFFE699）
  payoutPositive:  '#FF0000',  // 正數紅字
  payoutNegative:  '#FF0000',  // 負數紅字（結算列全紅）
  ttlLabelColor:   '#FF0000',  // 結算列 label 也紅
  matchBold:       true,       // 賽程粗體
  borderColor:     '#000000',
  borderWeight:    1,          // thin
};

// 字體（套用到所有 cell）
const FONT = {
  name: 'Microsoft JhengHei',  // 微軟正黑體
  size: 10,
};

// 欄寬自動 fit 參數（單位 points）
const WIDTH = {
  cjkCharPt:   9,   // 中文/全形字寬估算
  asciiCharPt: 5,   // ASCII 字寬估算
  paddingPt:   10,  // 每欄額外留白
  minPt:       40,  // 最小欄寬
  pointsPerChar: 5.5, // points → exceljs 欄寬（字元數）換算：xlsx 欄寬單位約等於預設字型一個字元寬
};

// 欄位設定
const COLUMNS = {
  fixed: ['日期', '賽程', '賽果'],
  membersFixed: ['下巴老長', '帥蛋餃', '田田', '禿頭', '純平', '阿向'],
  membersDynamic: true,        // true = 撈 DB 動態決定會員欄；false = 用 membersFixed
  // 動態會員欄排序：
  //   'first_bet' = 依該會員「全表第一筆 bet」的 created_at（先下注在左、新會員往右疊）
  //   'alphabet'  = 依暱稱字母/筆畫
  //   'frequency' = 依下注筆數多寡（多的在左）
  memberSort: 'first_bet',
};

// 文字格式（cell 內容組法）
const FORMAT = {
  // 冒號統一半形；空格保留原始輸入
  normColon: (s) => String(s || '').replace(/：/g, ':'),
  betCell:   (label, odds, amount) => `${label}(${odds ?? '?'})(${amount ?? '?'})`,
  matchCell: (homeZh, awayZh) => `${homeZh}[主] vs ${awayZh}`,
  scoreCell: (homeZh, awayZh, sf, sh) =>
    sf
      ? `${homeZh} ${sf.home}:${sf.away} ${awayZh}` +
        (sh ? `（半場 ${sh.home}:${sh.away}）` : '')
      : '未結算',
  // 正數帶 +、負數帶 -、零顯示 0（不帶符號）
  ttlNum:    (v) => v > 0 ? `+${v}` : (v < 0 ? `${v}` : '0'),
};

// 結算列標籤（方便日後改文字）
const LABELS = {
  todayResult: 'Today Result',  // 當日結算
  totalResult: 'Total Result',  // 跨日累計
};

const SHEET_NAME = '下注總表';

// 估算單格文字顯示寬度（points）
function textWidthPt(s) {
  let w = 0;
  for (const ch of String(s == null ? '' : s)) {
    w += ch.charCodeAt(0) > 255 ? WIDTH.cjkCharPt : WIDTH.asciiCharPt;
  }
  return w;
}

// 依 grid + header 算各欄最大寬度（不換行，取最長內容）
function computeColWidths(grid, COLS) {
  const widths = COLS.map(name => textWidthPt(name));
  for (const row of grid) {
    for (let c = 0; c < COLS.length; c++) {
      const cell = row[c];
      if (cell && cell.v != null) widths[c] = Math.max(widths[c], textWidthPt(cell.v));
    }
  }
  return widths.map(w => Math.max(WIDTH.minPt, w + WIDTH.paddingPt));
}

// ── exceljs 樣式 helpers ──
// #RRGGBB → exceljs 需要的 ARGB 8 碼（補上不透明 alpha FF）
const toArgb = (hex) => 'FF' + String(hex || '000000').replace('#', '').toUpperCase();

// 框線：borderWeight <= 1 視為 thin，其餘 medium
const borderStyle = () => {
  const side = {
    style: STYLE.borderWeight <= 1 ? 'thin' : 'medium',
    color: { argb: toArgb(STYLE.borderColor) },
  };
  return { top: side, left: side, right: side, bottom: side };
};

// font（name + size，可選 bold / color）
const fontDef = ({ bold = false, color = null } = {}) => ({
  name: FONT.name,
  size: FONT.size,
  bold,
  ...(color ? { color: { argb: toArgb(color) } } : {}),
});

const fillDef = (hex) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: toArgb(hex) } });

// 所有 cell 橫向 + 垂直置中、不換行
const ALIGN_CENTER = { horizontal: 'center', vertical: 'middle', wrapText: false };

// 預定義 styles（字體微軟正黑體、字級 10、全置中、全框線）
function buildStyles() {
  const border = borderStyle();
  const make = (font, fillHex) => ({
    font,
    alignment: ALIGN_CENTER,
    border,
    ...(fillHex ? { fill: fillDef(fillHex) } : {}),
  });
  return {
    header:      make(fontDef({ bold: true }), STYLE.headerBg),
    dateCell:    make(fontDef()),
    fixtureCell: make(fontDef({ bold: STYLE.matchBold }), STYLE.matchBg),
    matchCell:   make(fontDef()),
    betCell:     make(fontDef()),
    todayLabel:  make(fontDef({ bold: true, color: STYLE.ttlLabelColor }), STYLE.todayBg),
    todayPos:    make(fontDef({ bold: true, color: STYLE.payoutPositive }), STYLE.todayBg),
    todayNeg:    make(fontDef({ bold: true, color: STYLE.payoutNegative }), STYLE.todayBg),
    ttlLabel:    make(fontDef({ bold: true, color: STYLE.ttlLabelColor }), STYLE.ttlBg),
    ttlPos:      make(fontDef({ bold: true, color: STYLE.payoutPositive }), STYLE.ttlBg),
    ttlNeg:      make(fontDef({ bold: true, color: STYLE.payoutNegative }), STYLE.ttlBg),
  };
}

// ── 主函式 ──
// opts: { supabase, dateRange: { start, end }, memberFilter?: 'all' | string[] }
// 回傳：{ buffer, rowCount, members, sheetName }
async function buildBetExportPivot({ supabase, dateRange, memberFilter = 'all' }) {
  const { start, end } = dateRange;

  const { data: matches, error: mErr } = await supabase
    .from('matches')
    .select('id, seq_no, home_team_name, away_team_name, match_date, score_full, score_half')
    .gte('match_date', start)
    .lte('match_date', end)
    .order('match_date', { ascending: true });
  if (mErr) throw new Error(`撈場次失敗：${mErr.message}`);

  const matchIds = (matches || []).map(m => m.id);
  let betsQuery = supabase
    .from('bets')
    .select('match_id, user_name, condition, odds, amount, payout, ticket_id')
    .in('match_id', matchIds.length ? matchIds : ['_none_']);
  const { data: betsRaw, error: bErr } = await betsQuery;
  if (bErr) throw new Error(`撈下注失敗：${bErr.message}`);

  // 排除串關（pivot 以場次為主軸）
  const bets = (betsRaw || []).filter(b => !b.ticket_id?.startsWith('P'));

  // 決定會員欄
  let members;
  if (COLUMNS.membersDynamic) {
    // 只有「此範圍內有 bet」的會員才有欄
    const inRange = new Set(bets.map(b => b.user_name).filter(Boolean));

    if (COLUMNS.memberSort === 'frequency') {
      const cnt = {};
      for (const b of bets) if (b.user_name) cnt[b.user_name] = (cnt[b.user_name] || 0) + 1;
      members = [...inRange].sort((a, b) => (cnt[b] - cnt[a]) || a.localeCompare(b));
    } else if (COLUMNS.memberSort === 'alphabet') {
      members = [...inRange].sort((a, b) => a.localeCompare(b));
    } else {
      // 'first_bet'（預設）：依「全表第一筆 bet」的 created_at；先下注在左
      const { data: orderRows } = await supabase
        .from('bets')
        .select('user_name, created_at, ticket_id')
        .order('created_at', { ascending: true });
      const firstSeen = [];
      const seenSet = new Set();
      for (const r of orderRows || []) {
        if (!r.user_name || r.ticket_id?.startsWith('P')) continue;
        if (!seenSet.has(r.user_name)) { seenSet.add(r.user_name); firstSeen.push(r.user_name); }
      }
      // 依全表先後順序，過濾出此範圍有 bet 的會員；範圍內有但全表查不到的補在最後
      members = [
        ...firstSeen.filter(m => inRange.has(m)),
        ...[...inRange].filter(m => !seenSet.has(m)),
      ];
    }
  } else {
    members = [...COLUMNS.membersFixed];
  }
  if (Array.isArray(memberFilter)) {
    members = members.filter(m => memberFilter.includes(m));
  }

  const COLS = [...COLUMNS.fixed, ...members];
  const numCols = COLS.length;
  const FIRST_MEMBER_COL = COLUMNS.fixed.length; // 3

  // ── 建 grid ──
  const grid = [];
  const ensureRow = (r) => { while (grid.length <= r) grid.push(new Array(numCols).fill(undefined)); };
  const setCell = (r, c, cell) => { ensureRow(r); grid[r][c] = cell; };

  // 依日期分組
  const dayKey = d => (d || '').slice(0, 10);
  const byDay = {};
  for (const m of matches || []) (byDay[dayKey(m.match_date)] = byDay[dayKey(m.match_date)] || []).push(m);

  // 跨日累計（Total Result）：每天結束時把當日 Today 加進去
  const runningTotal = Object.fromEntries(members.map(m => [m, 0]));

  let r = 0;
  for (const day of Object.keys(byDay).sort()) {
    const dayMatches = byDay[day];
    const dayLabel = `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
    const dayTotals = Object.fromEntries(members.map(m => [m, 0]));
    const dayStartRow = r;

    // 預算每場 maxRows + memBets
    const blocks = dayMatches.map(match => {
      const memBets = {};
      let maxRows = 1;
      for (const mem of members) {
        memBets[mem] = bets.filter(b => b.match_id === match.id && b.user_name === mem);
        maxRows = Math.max(maxRows, memBets[mem].length);
        for (const b of memBets[mem]) dayTotals[mem] += Number(b.payout) || 0;
      }
      return { match, memBets, maxRows };
    });
    const dayTotalRows = blocks.reduce((a, b) => a + b.maxRows, 0);

    for (const { match, memBets, maxRows } of blocks) {
      const matchStartRow = r;
      const homeZh = getTeamNameZh(match.home_team_name);
      const awayZh = getTeamNameZh(match.away_team_name);
      const fixture = FORMAT.matchCell(homeZh, awayZh);
      const result = FORMAT.scoreCell(homeZh, awayZh, match.score_full, match.score_half);

      for (let i = 0; i < maxRows; i++) ensureRow(matchStartRow + i);

      // 賽程（淡藍粗體）/ 賽果（無底色）合併跨整場
      setCell(matchStartRow, 1, { v: fixture, style: 'fixtureCell', mergeDown: maxRows - 1 });
      setCell(matchStartRow, 2, { v: result,  style: 'matchCell',   mergeDown: maxRows - 1 });

      // 會員 cell
      members.forEach((mem, mi) => {
        const c = FIRST_MEMBER_COL + mi;
        const arr = memBets[mem];
        const k = arr.length;
        const betStr = (b) => FORMAT.betCell(FORMAT.normColon(b.condition), b.odds, b.amount);

        if (k === maxRows) {
          for (let i = 0; i < maxRows; i++) setCell(matchStartRow + i, c, { v: betStr(arr[i]), style: 'betCell' });
        } else if (k <= 1) {
          setCell(matchStartRow, c, { v: k === 1 ? betStr(arr[0]) : '', style: 'betCell', mergeDown: maxRows - 1 });
        } else {
          // 1 < k < maxRows（罕見）：前 k 列展開，其餘合併留空
          for (let i = 0; i < k; i++) setCell(matchStartRow + i, c, { v: betStr(arr[i]), style: 'betCell' });
          setCell(matchStartRow + k, c, { v: '', style: 'betCell', mergeDown: maxRows - 1 - k });
        }
      });

      r += maxRows;
    }

    // 日期欄（合併跨當天所有場次列；TTL 列另計）
    setCell(dayStartRow, 0, { v: dayLabel, style: 'dateCell', mergeDown: dayTotalRows - 1 });

    // Today Result 行（當日結算，淡綠底紅字）
    const todayRow = r;
    ensureRow(todayRow);
    setCell(todayRow, 0, { v: LABELS.todayResult, style: 'todayLabel', mergeAcross: COLUMNS.fixed.length - 1 });
    members.forEach((mem, mi) => {
      const c = FIRST_MEMBER_COL + mi;
      const v = dayTotals[mem];
      setCell(todayRow, c, { v: FORMAT.ttlNum(v), style: v >= 0 ? 'todayPos' : 'todayNeg' });
    });
    r = todayRow + 1;

    // Total Result 行（跨日累計 = 當日 Today + 前一日 Total）
    for (const mem of members) runningTotal[mem] += dayTotals[mem];
    const totalRow = r;
    ensureRow(totalRow);
    setCell(totalRow, 0, { v: LABELS.totalResult, style: 'ttlLabel', mergeAcross: COLUMNS.fixed.length - 1 });
    members.forEach((mem, mi) => {
      const c = FIRST_MEMBER_COL + mi;
      const v = runningTotal[mem];
      setCell(totalRow, c, { v: FORMAT.ttlNum(v), style: v >= 0 ? 'ttlPos' : 'ttlNeg' });
    });
    r = totalRow + 1;
  }

  // ── 計算 covered（被合併覆蓋的格） ──
  const covered = grid.map(() => new Array(numCols).fill(false));
  for (let rr = 0; rr < grid.length; rr++) {
    for (let cc = 0; cc < numCols; cc++) {
      const cell = grid[rr][cc];
      if (!cell) continue;
      if (cell.mergeDown) for (let d = 1; d <= cell.mergeDown; d++) if (covered[rr + d]) covered[rr + d][cc] = true;
      if (cell.mergeAcross) for (let d = 1; d <= cell.mergeAcross; d++) covered[rr][cc + d] = true;
    }
  }

  // ── 用 exceljs 組真 .xlsx ──
  const colWidths = computeColWidths(grid, COLS); // 各欄寬度（points）
  const STYLES = buildStyles();

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(SHEET_NAME, {
    views: [{ state: 'frozen', ySplit: 1 }], // 凍結首列（header）
  });

  // 欄寬：points → exceljs 字元數，AutoFitWidth=0 等效（固定寬不換行）
  colWidths.forEach((w, c) => {
    ws.getColumn(c + 1).width = w / WIDTH.pointsPerChar;
  });

  const applyStyle = (cell, styleId) => {
    const st = STYLES[styleId];
    if (!st) return;
    cell.font = st.font;
    cell.alignment = st.alignment;
    cell.border = st.border;
    if (st.fill) cell.fill = st.fill;
  };

  // Header row（exceljs row 1）
  COLS.forEach((name, c) => {
    const cell = ws.getCell(1, c + 1);
    cell.value = name;
    applyStyle(cell, 'header');
  });

  // Data rows：grid row rr → exceljs row rr + 2（首列為 header）
  for (let rr = 0; rr < grid.length; rr++) {
    const exRow = rr + 2;
    for (let cc = 0; cc < numCols; cc++) {
      if (covered[rr][cc]) continue; // 被合併覆蓋的格不寫
      const def = grid[rr][cc];
      if (!def) continue;
      const exCol = cc + 1;
      const cell = ws.getCell(exRow, exCol);
      cell.value = def.v == null ? '' : String(def.v); // 全部當文字（含 +730 / 0 / -50）
      applyStyle(cell, def.style);

      const downSpan = def.mergeDown || 0;
      const acrossSpan = def.mergeAcross || 0;
      if (downSpan || acrossSpan) {
        ws.mergeCells(exRow, exCol, exRow + downSpan, exCol + acrossSpan);
      }
    }
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    rowCount: grid.length + 1, // + header
    members,
    sheetName: SHEET_NAME,
    colWidths,          // 各欄寬度（points）對應 COLS
    cols: COLS,
  };
}

module.exports = { buildBetExportPivot, STYLE, COLUMNS, FORMAT };
