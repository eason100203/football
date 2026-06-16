// ============================================================
// scripts/compare-odds.js — 拉 The Odds API 世足市場盤，對到 DB 未來場次，
// 以 Pinnacle 優先（無則多家中位數）印出逐場市場盤，供人工跟私盤對照。
//
// 市場盤口（對應私盤）：
//   h2h     → 獨贏（主/和/客）
//   spreads → 讓分（主線，非亞洲梯型盤，僅供大方向對照）
//   totals  → 大小（主線 over/under）
//
// 用法：node scripts/compare-odds.js
// 需 .env：ODDS_API_KEY / SUPABASE_URL / SUPABASE_KEY
// 額度成本：1 次呼叫 = markets(3) × regions(2) = 6 點（一次回全部場次）
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const tz = require('dayjs/plugin/timezone');
const { getTeamNameZh } = require('../teamName.js');

dayjs.extend(utc);
dayjs.extend(tz);

const SPORT = 'soccer_fifa_world_cup';
const REGIONS = 'eu,uk';
const MARKETS = 'h2h,spreads,totals';
const PREFERRED_BOOKMAKER = 'pinnacle';

// The Odds API 英文名 ↔ DB（football-data.org）英文名 對齊用（key 為去重音/去標點後的小寫）
const NAME_ALIASES = {
  'usa': 'united states',
  'south korea': 'korea republic',
  'czechia': 'czech republic',
  'turkiye': 'turkey',
  'bosnia and herzegovina': 'bosnia',
  'bosnia herzegovina': 'bosnia',
  'cote d ivoire': 'ivory coast',
  'dr congo': 'congo',
  'congo dr': 'congo',
  'ir iran': 'iran',
};

// 去重音（türkiye→turkiye）、去標點（-、&、. → 空白）、小寫，再套 alias
function normName(name) {
  const k = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return NAME_ALIASES[k] || k;
}

// 兩隊名是否視為同一隊（雙向 includes 容錯）
function sameTeam(a, b) {
  const x = normName(a), y = normName(b);
  return x === y || x.includes(y) || y.includes(x);
}

// 一場比賽以「兩隊正規化後排序」當 key，避免主客順序不一致導致對不上
function pairKey(home, away) {
  return [normName(home), normName(away)].sort().join(' | ');
}

function median(nums) {
  const s = nums.filter(n => typeof n === 'number' && !Number.isNaN(n)).sort((a, b) => a - b);
  if (!s.length) return null;
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

// 取某盤口的代表值：Pinnacle 優先；沒有則跨莊家對「每個 outcome（依 name+point 分組）」取中位數
function summarizeMarket(game, marketKey) {
  const pin = game.bookmakers.find(b => (b.key || b.title || '').toLowerCase().includes(PREFERRED_BOOKMAKER));
  if (pin) {
    const m = pin.markets.find(x => x.key === marketKey);
    if (m) return { source: 'Pinnacle', outcomes: m.outcomes };
  }
  // 中位數 fallback：以 outcome 的 name+point 為群組，各自取賠率中位數
  const groups = {};
  let count = 0;
  for (const b of game.bookmakers) {
    const m = (b.markets || []).find(x => x.key === marketKey);
    if (!m) continue;
    count++;
    for (const o of m.outcomes) {
      const id = `${o.name}@@${o.point ?? ''}`;
      (groups[id] = groups[id] || { name: o.name, point: o.point, prices: [] }).prices.push(o.price);
    }
  }
  const ids = Object.keys(groups);
  if (!ids.length) return null;
  const outcomes = ids.map(id => ({ name: groups[id].name, point: groups[id].point, price: round2(median(groups[id].prices)) }));
  return { source: `中位數(${count}家)`, outcomes };
}

function fmtOutcome(o) {
  const isTotal = /^(over|under)$/i.test(o.name); // 大小：line 不加正負號
  const pt = o.point != null
    ? (isTotal ? ` ${o.point}` : ` ${o.point > 0 ? '+' : ''}${o.point}`)
    : '';
  return `${o.name}${pt}@${o.price}`;
}

async function main() {
  const oddsKey = process.env.ODDS_API_KEY;
  if (!oddsKey) throw new Error('.env 缺 ODDS_API_KEY');
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  // 1) 市場盤
  const resp = await axios.get(`https://api.the-odds-api.com/v4/sports/${SPORT}/odds`, {
    params: { apiKey: oddsKey, regions: REGIONS, markets: MARKETS, oddsFormat: 'decimal', dateFormat: 'iso' }
  });
  const games = resp.data || [];
  const oddsByPair = {};
  for (const g of games) oddsByPair[pairKey(g.home_team, g.away_team)] = g;

  // 2) DB 未來場次（台灣今天 00:00 起、尚未結束）
  const todayTW = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD');
  const { data: matches } = await supabase
    .from('matches')
    .select('seq_no, home_team_name, away_team_name, match_date, status')
    .gte('match_date', `${todayTW} 00:00`)
    .neq('status', 'FINISHED')
    .order('match_date', { ascending: true });

  console.log(`市場盤場次：${games.length} | DB 未來場次：${(matches || []).length} | 剩餘額度：${resp.headers['x-requests-remaining']}\n`);

  // 先精準（排序後 key）對，對不上再用雙向 includes 模糊比對
  const findGame = (home, away) => oddsByPair[pairKey(home, away)] || games.find(g =>
    (sameTeam(g.home_team, home) && sameTeam(g.away_team, away)) ||
    (sameTeam(g.home_team, away) && sameTeam(g.away_team, home))
  ) || null;

  let matched = 0;
  for (const m of matches || []) {
    const g = findGame(m.home_team_name, m.away_team_name);
    const homeZh = getTeamNameZh(m.home_team_name) || m.home_team_name;
    const awayZh = getTeamNameZh(m.away_team_name) || m.away_team_name;
    if (!g) {
      console.log(`#${m.seq_no} ${homeZh} vs ${awayZh} — ⚠️ 市場盤查無此場（莊家未開盤或名稱對不上）`);
      continue;
    }
    matched++;
    // 用 DB 中文名，但對齊「市場盤的主客方向」（讓分正負號才正確）
    const oddsHomeIsDbHome = sameTeam(g.home_team, m.home_team_name);
    const gh = oddsHomeIsDbHome ? homeZh : awayZh;
    const ga = oddsHomeIsDbHome ? awayZh : homeZh;
    console.log(`#${m.seq_no} ${gh}[主] vs ${ga}　${dayjs(g.commence_time).tz('Asia/Taipei').format('MM/DD HH:mm')}`);
    for (const [key, label] of [['h2h', '獨贏'], ['spreads', '讓分'], ['totals', '大小']]) {
      const s = summarizeMarket(g, key);
      if (!s) { console.log(`   ${label}：（無莊家提供）`); continue; }
      console.log(`   ${label}：${s.outcomes.map(fmtOutcome).join(' | ')}　[${s.source}]`);
    }
    console.log('');
  }

  console.log(`對到 ${matched} / ${(matches || []).length} 場。市場盤有、DB 沒有的場次未列出。`);
}

main().catch(e => {
  console.error('❌ 失敗：', e.response?.status, JSON.stringify(e.response?.data || e.message));
  process.exit(1);
});
