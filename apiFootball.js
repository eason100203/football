const axios = require('axios');
const dayjs = require('dayjs');

const BASE_URL = 'https://v3.football.api-sports.io';

// football-data.org 跟 API-Football 對同一支球隊可能用不同名稱
const NAME_ALIASES = {
  'united states':      'usa',
  'korea republic':     'south korea',
  'bosnia-herzegovina': 'bosnia',
  'bosnia & herzegovina': 'bosnia',
  'ivory coast':        "cote d'ivoire",
  'türkiye':            'turkey',       // 土耳其 2022 年官方改名
  'czech republic':     'czechia',      // 捷克舊名
};

function normalizeName(name) {
  const lower = name.toLowerCase();
  return NAME_ALIASES[lower] || lower;
}

function makeHeaders(apiKey) {
  return { 'x-apisports-key': apiKey };
}

// 查單一日期的 fixtures，返回第一個匹配結果或 null
async function _queryFixturesForDate({ apiKey, homeTeam, awayTeam, date }) {
  try {
    const { data } = await axios.get(`${BASE_URL}/fixtures`, {
      headers: makeHeaders(apiKey),
      params: { date },
      timeout: 8000
    });

    const ht = normalizeName(homeTeam);
    const at = normalizeName(awayTeam);

    const match = (data.response || []).find(f => {
      const h = normalizeName(f.teams?.home?.name || '');
      const a = normalizeName(f.teams?.away?.name || '');
      return (h.includes(ht) || ht.includes(h)) &&
             (a.includes(at) || at.includes(a));
    });

    if (!match) return null;

    return {
      fixtureId:   match.fixture.id,
      homeTeamApi: match.teams.home.name,
      awayTeamApi: match.teams.away.name,
      kickoffUtc:  match.fixture.date
    };
  } catch (err) {
    console.warn('[apiFootball] getFixtureId error:', err.message);
    return null;
  }
}

/**
 * 依日期+主客隊英文名找 fixture id。
 * 先試傳入的 date，找不到再試 D-1：football-data.org 以 UTC 儲存開球時間，
 * API-Football 以美東當地日期為準，晚間場（20:00 ET = 00:00 UTC 次日）兩邊會差一天。
 * @returns {{ fixtureId, homeTeamApi, awayTeamApi, kickoffUtc } | null}
 */
async function getFixtureId({ apiKey, homeTeam, awayTeam, date }) {
  const result = await _queryFixturesForDate({ apiKey, homeTeam, awayTeam, date });
  if (result) return result;

  const dateMinus1 = dayjs(date).subtract(1, 'day').format('YYYY-MM-DD');
  const fallback = await _queryFixturesForDate({ apiKey, homeTeam, awayTeam, date: dateMinus1 });
  if (fallback) {
    console.log(`[apiFootball] getFixtureId D-1 hit (${dateMinus1}): ${homeTeam} vs ${awayTeam}`);
    return fallback;
  }

  return null;
}

/**
 * 取全/半場比分。
 * 比賽未結束時相關欄位為 null。
 * @returns {{ fullTime: { home, away }, halfTime: { home, away } } | null}
 */
async function getScores({ apiKey, fixtureId }) {
  try {
    const { data } = await axios.get(`${BASE_URL}/fixtures`, {
      headers: makeHeaders(apiKey),
      params: { id: fixtureId },
      timeout: 8000
    });

    const fixture = (data.response || [])[0];
    if (!fixture) return null;

    const s = fixture.score || {};
    return {
      fullTime: {
        home: s.fulltime?.home ?? null,
        away: s.fulltime?.away ?? null
      },
      halfTime: {
        home: s.halftime?.home ?? null,
        away: s.halftime?.away ?? null
      }
    };
  } catch (err) {
    console.warn('[apiFootball] getScores error:', err.message);
    return null;
  }
}

/**
 * 從 Asian Handicap 市場判斷讓球方。
 * 規則：主隊 spread 最小值 < 0 → 'home'；客隊 < 0 且主隊 ≥ 0 → 'away'；平盤 → null。
 * @returns {'home' | 'away' | null}
 */
async function getHandicapGiver({ apiKey, fixtureId }) {
  try {
    const { data } = await axios.get(`${BASE_URL}/odds`, {
      headers: makeHeaders(apiKey),
      params: { fixture: fixtureId },
      timeout: 8000
    });

    const bookmakers = (data.response || [])[0]?.bookmakers || [];

    for (const bk of bookmakers) {
      const ah = (bk.bets || []).find(b => b.name === 'Asian Handicap');
      if (!ah) continue;

      const values = ah.values || [];

      const homeSpreads = values
        .filter(v => v.value.startsWith('Home '))
        .map(v => parseFloat(v.value.slice(5)));

      const awaySpreads = values
        .filter(v => v.value.startsWith('Away '))
        .map(v => parseFloat(v.value.slice(5)));

      const homeMin = homeSpreads.length ? Math.min(...homeSpreads) : Infinity;
      const awayMin = awaySpreads.length ? Math.min(...awaySpreads) : Infinity;

      if (homeMin < 0) return 'home';
      if (awayMin < 0 && homeMin >= 0) return 'away';
      return null; // 平盤
    }

    return null;
  } catch (err) {
    console.warn('[apiFootball] getHandicapGiver error:', err.message);
    return null;
  }
}

// API-Football 的 errors 欄位成功時為 []（陣列），出錯時為物件如 { access: '...' }
function firstError(errors) {
  if (!errors) return null;
  if (Array.isArray(errors)) return errors.length ? String(errors[0]) : null;
  if (typeof errors === 'object') {
    const vals = Object.values(errors).filter(Boolean);
    return vals.length ? String(vals[0]) : null;
  }
  return String(errors);
}

const toIntOrNull = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));

/**
 * 查 API-Football 帳號狀態與額度。
 * 額度（每日/每分鐘剩餘）一律從回應標頭取，因標頭即使帳號被停用也存在；
 * 帳號資訊（方案/到期/用量）則來自 /status body，停用時 body 為空。
 * @returns {{
 *   ok: boolean, error: string|null,
 *   account: {firstname,lastname,email}|null,
 *   subscription: {plan,end,active}|null,
 *   requests: {current,limit_day}|null,
 *   rate: {dayLimit,dayRemaining,minLimit,minRemaining}
 * }}
 */
async function getApiStatus({ apiKey }) {
  try {
    const resp = await axios.get(`${BASE_URL}/status`, {
      headers: makeHeaders(apiKey),
      timeout: 8000
    });
    const data = resp.data || {};
    const h = resp.headers || {};

    const rate = {
      dayLimit:     toIntOrNull(h['x-ratelimit-requests-limit']),
      dayRemaining: toIntOrNull(h['x-ratelimit-requests-remaining']),
      minLimit:     toIntOrNull(h['x-ratelimit-limit']),
      minRemaining: toIntOrNull(h['x-ratelimit-remaining']),
    };

    const error = firstError(data.errors);
    const r = data.response;
    const info = (r && typeof r === 'object' && !Array.isArray(r)) ? r : null;

    return {
      ok: !error && !!info,
      error,
      account:      info?.account || null,
      subscription: info?.subscription || null,
      requests:     info?.requests || null,
      rate,
    };
  } catch (err) {
    console.warn('[apiFootball] getApiStatus error:', err.message);
    return {
      ok: false,
      error: err.message,
      account: null,
      subscription: null,
      requests: null,
      rate: { dayLimit: null, dayRemaining: null, minLimit: null, minRemaining: null },
    };
  }
}

module.exports = { getFixtureId, getScores, getHandicapGiver, getApiStatus };
