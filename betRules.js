// ============================================================
// betRules.js — 盤口規則登記表（與 bot 主程式分離，方便維護/擴充）
//
// 設計原則：
//   1. 每種盤口 = MARKETS 裡的一個物件，自帶 match / parse / settle
//   2. 加新盤口 = 加一筆，不用動 bot 路由、資料庫、結算引擎
//   3. settle 是純函式（只吃 下注 + 比分），可單獨測試
//   4. 看不懂或暫不支援的，回 'manual' 標人工，不會誤算
//
// 結算結果 result：
//   won(全贏) / half_won(半贏) / push(走盤) / half_lost(半輸) / lost(全輸)
//   pending(未結算) / manual(人工)
// ============================================================

const { TEAM_NAMES_ZH } = require('./teamName.js');
const TEAM_SET = new Set(Object.values(TEAM_NAMES_ZH || {}));

const RESULT = {
  WON: 'won',
  HALF_WON: 'half_won',
  PUSH: 'push',
  HALF_LOST: 'half_lost',
  LOST: 'lost',
  PENDING: 'pending',
  MANUAL: 'manual',
};

// 鏡像結果：贏↔輸，半贏↔半輸，走盤/人工 不變
function mirrorResult(result) {
  switch (result) {
    case RESULT.WON:       return RESULT.LOST;
    case RESULT.LOST:      return RESULT.WON;
    case RESULT.HALF_WON:  return RESULT.HALF_LOST;
    case RESULT.HALF_LOST: return RESULT.HALF_WON;
    default:               return result;
  }
}

// 結果 → 盈虧金額（賠率為淨賠率：贏的是純利，本金另計）
function payoutFor(result, stake, odds) {
  stake = Number(stake) || 0;
  odds = Number(odds) || 0;
  switch (result) {
    case RESULT.WON: return stake * odds;
    case RESULT.HALF_WON: return (stake * odds) / 2;
    case RESULT.PUSH: return 0;
    case RESULT.HALF_LOST: return -stake / 2;
    case RESULT.LOST: return -stake;
    default: return null;
  }
}

// 抓開頭的「半場 / 半」→ 時段
function stripPeriod(text) {
  let period = '全場';
  let t = String(text || '').trim();
  const m = t.match(/^(半場|半)\s*/);
  if (m) { period = '半場'; t = t.slice(m[0].length).trim(); }
  return { period, text: t };
}

function firstTeam(t) {
  // 先把「中文字緊接數字」的情況補空格（例如「瑞士2+50」→「瑞士 2+50」）
  const normalized = String(t).replace(/([一-鿿])(\d)/g, '$1 $2');
  for (const tok of normalized.split(/\s+/)) if (TEAM_SET.has(tok)) return tok;
  return null;
}
function hasTeam(t) { return firstTeam(t) != null; }

// 讓分：依 suffix 決定結果
// .5 線：無平手可能，margin > A → WON，否則 LOST
// 0/'平'：整數平盤，margin = A → PUSH（'平' 保留作舊資料相容）
// +50：Quarter+，margin = A → HALF_WON
// -50：Quarter-，margin = A → HALF_LOST
function handicapResult(margin, A, suffix) {
  if (suffix === '.5') return margin > A ? RESULT.WON : RESULT.LOST;
  if (margin > A) return RESULT.WON;
  if (margin < A) return RESULT.LOST;
  if (suffix === '0' || suffix === '平') return RESULT.PUSH;
  if (suffix === '+50') return RESULT.HALF_WON;
  if (suffix === '-50') return RESULT.HALF_LOST;
  return RESULT.MANUAL;
}

const MARKETS = {
  角球: {
    match(t) { return /角(球)?/.test(t); },
    parse(t) { return { market: '角球', selection: t.trim(), line: null, line_type: null }; },
    settle() { return RESULT.MANUAL; },
  },
  波膽: {
    match(t) {
      const trimmed = t.trim();
      if (/^\d{1,2}\s*[:：]\s*\d{1,2}$/.test(trimmed)) return true;
      if (/\d{1,2}\s*[:：]\s*\d{1,2}\s*$/.test(trimmed)) return true;
      return false;
    },
    parse(t) {
      const m = t.match(/(\d{1,2})\s*[:：]\s*(\d{1,2})/);
      return { market: '波膽', selection: `${m[1]}:${m[2]}`, line: null, line_type: null };
    },
    settle(bet, score) {
      const m = String(bet.selection).match(/(\d+)\s*:\s*(\d+)/);
      if (!m) return RESULT.MANUAL;
      return (Number(m[1]) === score.home && Number(m[2]) === score.away) ? RESULT.WON : RESULT.LOST;
    },
  },
  大小: {
    match(t) { return /(^|[^一-鿿])(大|小)/.test(t) && /\d/.test(t); },
    parse(t) {
      const side = /小/.test(t) ? '小' : '大';
      let line = null, line_type = null, m;
      if ((m = t.match(/(\d+)\s*\+\s*50/))) { line = Number(m[1]); line_type = '+50'; }
      else if ((m = t.match(/(\d+)\s*-\s*50/))) { line = Number(m[1]); line_type = '-50'; }
      else if ((m = t.match(/(\d+)\s*平/))) { line = Number(m[1]); line_type = '平'; }
      else if ((m = t.match(/(\d+(?:\.\d+)?)/))) { line = Number(m[1]); line_type = (line % 1 === 0) ? '整數' : '.5'; }
      return { market: '大小', selection: side, line, line_type };
    },
    settle(bet, score) {
      if (bet.line == null) return RESULT.MANUAL;
      const total = score.home + score.away;
      const big = bet.selection === '大';
      if (bet.line_type === '.5') return ((total > bet.line) === big) ? RESULT.WON : RESULT.LOST;
      if (bet.line_type === '平' || bet.line_type === '整數') {
        if (total === bet.line) return RESULT.PUSH;
        return ((total > bet.line) === big) ? RESULT.WON : RESULT.LOST;
      }
      if (bet.line_type === '-50') {
        const X = bet.line;
        if (total >= X + 1) return big ? RESULT.WON      : RESULT.LOST;
        if (total === X)    return big ? RESULT.HALF_LOST : RESULT.HALF_WON;
        return                     big ? RESULT.LOST      : RESULT.WON;
      }
      if (bet.line_type === '+50') {
        const X = bet.line;
        if (total >= X + 1) return big ? RESULT.WON      : RESULT.LOST;
        if (total === X)    return big ? RESULT.HALF_WON  : RESULT.HALF_LOST;
        return                     big ? RESULT.LOST      : RESULT.WON;
      }
      return RESULT.MANUAL;
    },
  },
  單雙: {
    match(t) { return /^(單|雙)(數)?$/.test(t.trim()); },
    parse(t) { return { market: '單雙', selection: /雙/.test(t) ? '雙' : '單', line: null, line_type: null }; },
    settle(bet, score) {
      const even = ((score.home + score.away) % 2) === 0;
      const win = bet.selection === '雙' ? even : !even;
      return win ? RESULT.WON : RESULT.LOST;
    },
  },
  讓分: {
    // 寬鬆 match：有隊名 + 有數字即視為讓分（角球/大小已在前面被分走）
    match(t) { return hasTeam(t) && /\d/.test(t); },
    parse(t) {
      const team = firstTeam(t);
      let line = null, line_type = null, m;
      if ((m = t.match(/(\d+)\s*\+\s*50/))) {
        line = Number(m[1]); line_type = '+50';
      } else if ((m = t.match(/(\d+)\s*-\s*50/))) {
        line = Number(m[1]); line_type = '-50';
      } else if ((m = t.match(/讓?(\d+(?:\.\d+)?)/))) {
        line = Number(m[1]);
        line_type = line % 1 !== 0 ? '.5' : '0';
      }
      return { market: '讓分', selection: team, line, line_type };
    },
    settle(bet, score, ctx = {}) {
      if (bet.line == null || !bet.selection) return RESULT.MANUAL;
      const isHome = ctx.homeTeamZh === bet.selection;
      const isAway = ctx.awayTeamZh === bet.selection;
      if (!isHome && !isAway) return RESULT.MANUAL;
      const margin = isHome ? (score.home - score.away) : (score.away - score.home);
      return handicapResult(margin, bet.line, bet.line_type);
    },
  },
  獨贏: {
    match(t) { const s = t.trim(); return s === '和' || s === '平' || TEAM_SET.has(s); },
    parse(t) { const s = t.trim(); return { market: '獨贏', selection: s === '平' ? '和' : s, line: null, line_type: null }; },
    settle(bet, score, ctx = {}) {
      const margin = score.home - score.away;
      const outcome = margin > 0 ? ctx.homeTeamZh : (margin < 0 ? ctx.awayTeamZh : '和');
      return outcome === bet.selection ? RESULT.WON : RESULT.LOST;
    },
  },
};

const MARKET_ORDER = ['角球', '波膽', '大小', '單雙', '讓分', '獨贏'];

function classifyBet(rawText) {
  const { period, text } = stripPeriod(rawText);
  for (const key of MARKET_ORDER) {
    if (MARKETS[key].match(text)) return { period, ...MARKETS[key].parse(text) };
  }
  return { period, market: '其他', selection: null, line: null, line_type: null };
}

// 大小盤 settle 內部已依 selection 自行處理大小兩邊，不再走 mirror 路徑
const MIRROR_MARKETS = new Set(['讓分']);

function settleBet(bet, score, ctx = {}) {
  const { inverse = false } = ctx;
  const m = MARKETS[bet.market];
  if (!m || !m.settle) return RESULT.MANUAL;
  try {
    const result = m.settle(bet, score, ctx);
    return (inverse && MIRROR_MARKETS.has(bet.market)) ? mirrorResult(result) : result;
  } catch (e) { return RESULT.MANUAL; }
}

// 串關 leg 乘數：WON=1+odds, HALF_WON=1+odds/2, PUSH=1, HALF_LOST=0.5, LOST=0, 其他→null
function legMultiplier(result, odds) {
  switch (result) {
    case RESULT.WON:       return 1 + odds;
    case RESULT.HALF_WON:  return 1 + odds / 2;
    case RESULT.PUSH:      return 1;
    case RESULT.HALF_LOST: return 0.5;
    case RESULT.LOST:      return 0;
    default:               return null;
  }
}

module.exports = { MARKETS, MARKET_ORDER, classifyBet, settleBet, legMultiplier, payoutFor, mirrorResult, RESULT };
