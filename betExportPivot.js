// ============================================================
// betExportPivot.js — 下注 pivot 匯出（SpreadsheetML 2003，零依賴）
//
// 產出 Excel 可直接開啟的 .xml（SpreadsheetML），支援：
//   合併儲存格 / 背景色 / 字色 / 粗體 / 框線。
// Excel 雙擊即開；檔名用 .xls 亦可直接開。
//
// ── 所有可調設定集中在下方常數，日後改色 / 改欄序 / 改格式只動這裡 ──
// ============================================================

const { getTeamNameZh } = require('./teamName.js');

// 顏色（SpreadsheetML 用 #RRGGBB；若手上是 ARGB 8 碼，去掉前 2 碼 alpha）
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

// ── XML helpers ──
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#10;');
}

function bordersXml() {
  const sides = ['Left', 'Top', 'Right', 'Bottom'];
  return '<Borders>' +
    sides.map(p =>
      `<Border ss:Position="${p}" ss:LineStyle="Continuous" ss:Weight="${STYLE.borderWeight}" ss:Color="${STYLE.borderColor}"/>`
    ).join('') +
    '</Borders>';
}

// font 片段（name + size，可選 bold / color）
function fontXml({ bold = false, color = null } = {}) {
  let a = ` ss:FontName="${FONT.name}" x:Family="Swiss" ss:Size="${FONT.size}"`;
  if (bold) a += ' ss:Bold="1"';
  if (color) a += ` ss:Color="${color}"`;
  return `<Font${a}/>`;
}

// 所有 cell 橫向 + 垂直置中、不換行
const CENTER = '<Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="0"/>';

// 預定義 styles（字體微軟正黑體、字級 10、全置中）
function stylesXml() {
  const B = bordersXml();
  return `<Styles>
  <Style ss:ID="Default" ss:Name="Normal">${fontXml()}${CENTER}</Style>
  <Style ss:ID="header">
    ${fontXml({ bold: true })}
    <Interior ss:Color="${STYLE.headerBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="dateCell">
    ${fontXml()}
    ${CENTER}${B}
  </Style>
  <Style ss:ID="fixtureCell">
    ${fontXml({ bold: STYLE.matchBold })}
    <Interior ss:Color="${STYLE.matchBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="matchCell">
    ${fontXml()}
    ${CENTER}${B}
  </Style>
  <Style ss:ID="betCell">
    ${fontXml()}
    ${CENTER}${B}
  </Style>
  <Style ss:ID="todayLabel">
    ${fontXml({ bold: true, color: STYLE.ttlLabelColor })}
    <Interior ss:Color="${STYLE.todayBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="todayPos">
    ${fontXml({ bold: true, color: STYLE.payoutPositive })}
    <Interior ss:Color="${STYLE.todayBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="todayNeg">
    ${fontXml({ bold: true, color: STYLE.payoutNegative })}
    <Interior ss:Color="${STYLE.todayBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="ttlLabel">
    ${fontXml({ bold: true, color: STYLE.ttlLabelColor })}
    <Interior ss:Color="${STYLE.ttlBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="ttlPos">
    ${fontXml({ bold: true, color: STYLE.payoutPositive })}
    <Interior ss:Color="${STYLE.ttlBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
  <Style ss:ID="ttlNeg">
    ${fontXml({ bold: true, color: STYLE.payoutNegative })}
    <Interior ss:Color="${STYLE.ttlBg}" ss:Pattern="Solid"/>
    ${CENTER}${B}
  </Style>
</Styles>`;
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

  // ── 組 XML ──
  const colWidths = computeColWidths(grid, COLS);
  const colsXml = colWidths.map(w => `<Column ss:Width="${w}" ss:AutoFitWidth="0"/>`).join('');

  const rowsXml = [];

  // Header row
  rowsXml.push('<Row>' + COLS.map((name, c) =>
    `<Cell ss:Index="${c + 1}" ss:StyleID="header"><Data ss:Type="String">${escXml(name)}</Data></Cell>`
  ).join('') + '</Row>');

  // Data rows
  for (let rr = 0; rr < grid.length; rr++) {
    let row = '<Row>';
    for (let cc = 0; cc < numCols; cc++) {
      if (covered[rr][cc]) continue;
      const cell = grid[rr][cc];
      if (!cell) continue;
      let attrs = ` ss:Index="${cc + 1}"`;
      if (cell.style) attrs += ` ss:StyleID="${cell.style}"`;
      if (cell.mergeAcross) attrs += ` ss:MergeAcross="${cell.mergeAcross}"`;
      if (cell.mergeDown) attrs += ` ss:MergeDown="${cell.mergeDown}"`;
      row += `<Cell${attrs}><Data ss:Type="String">${escXml(cell.v)}</Data></Cell>`;
    }
    row += '</Row>';
    rowsXml.push(row);
  }

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
${stylesXml()}
<Worksheet ss:Name="${escXml(SHEET_NAME)}">
<Table>
${colsXml}
${rowsXml.join('\n')}
</Table>
<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
<FreezePanes/><FrozenNoSplit/>
<SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>
<ActivePane>2</ActivePane>
</WorksheetOptions>
</Worksheet>
</Workbook>`;

  return {
    buffer: Buffer.from(xml, 'utf-8'),
    rowCount: grid.length + 1, // + header
    members,
    sheetName: SHEET_NAME,
    colWidths,          // 各欄寬度（points）對應 COLS
    cols: COLS,
  };
}

module.exports = { buildBetExportPivot, STYLE, COLUMNS, FORMAT };
