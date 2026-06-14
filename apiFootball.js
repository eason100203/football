const axios = require('axios');

const BASE_URL = 'https://v3.football.api-sports.io';

// football-data.org 跟 API-Football 對同一支球隊可能用不同名稱
const NAME_ALIASES = {
  'united states': 'usa',
  'korea republic': 'south korea',
  'bosnia-herzegovina': 'bosnia',
  'bosnia & herzegovina': 'bosnia',
  'ivory coast': "cote d'ivoire",
};

function normalizeName(name) {
  const lower = name.toLowerCase();
  return NAME_ALIASES[lower] || lower;
}

function makeHeaders(apiKey) {
  return { 'x-apisports-key': apiKey };
}

/**
 * 依日期+主客隊英文名找 fixture id。
 * @returns {{ fixtureId, homeTeamApi, awayTeamApi, kickoffUtc } | null}
 */
async function getFixtureId({ apiKey, homeTeam, awayTeam, date }) {
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

module.exports = { getFixtureId, getScores, getHandicapGiver };
