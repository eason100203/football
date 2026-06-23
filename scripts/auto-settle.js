require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { classifyBet, settleBet, legMultiplier, payoutFor, RESULT } = require('../betRules.js');
const { getScores, getCorners } = require('../apiFootball');
const { getTeamNameZh } = require('../teamName.js');

dayjs.extend(utc);
dayjs.extend(timezone);

function calcInverse(cls, homeTeamZh, homeIsGiver) {
  if (cls.market !== '讓分') return false;
  if (homeIsGiver == null) return null;
  const selectionIsHome = cls.selection === homeTeamZh;
  return homeIsGiver ? !selectionIsHome : selectionIsHome;
}

function parseParlayLeg(line) {
  const seqMatch = line.match(/^#(\d+)\s+/);
  if (!seqMatch) return null;
  const rest = line.slice(seqMatch[0].length).trim();
  const tokens = rest.split(/\s+/);
  if (tokens.length < 2) return null;
  const odds = parseFloat(tokens[tokens.length - 1]);
  if (isNaN(odds)) return null;
  return { seqNo: Number(seqMatch[1]), condition: tokens.slice(0, -1).join(' '), odds };
}

/**
 * 結算今日（台灣時間）所有 FINISHED 且未結算的單注 + 所有待結算串關。
 * @param {{ supabase, apiKey: string }} opts
 * @returns {Promise<null | {
 *   date: string,
 *   settledMatchCount: number,
 *   skippedMatchCount: number,
 *   autoCount: number,
 *   manualCount: number,
 *   parlayAutoCount: number,
 *   parlayManualCount: number,
 *   memberPayouts: Record<string, number>
 * }>} null 代表今日無可結算場次
 */
async function autoSettle({ supabase, apiKey }) {
  const todayTW = dayjs().tz('Asia/Taipei').format('YYYY-MM-DD');
  const rangeStart = `${todayTW} 00:00`;
  const rangeEnd   = `${todayTW} 23:59`;

  // 不以 settled_at 為閘門：改以「該場是否還有未結算注單」決定要不要結，
  // 否則賽後（settled_at 已設）才下的注單會永遠漏結。
  const { data: settleMatches, error: smErr } = await supabase
    .from('matches')
    .select('id, seq_no, home_team_name, away_team_name, api_football_fixture_id, home_is_giver, status, score_full, score_half')
    .eq('status', 'FINISHED')
    .gte('match_date', rangeStart)
    .lte('match_date', rangeEnd)
    .order('seq_no', { ascending: true });

  if (smErr) throw new Error(`查詢失敗: ${smErr.message}`);
  if (!settleMatches?.length) return null;

  const nowIso = new Date().toISOString();
  let settledMatchCount = 0, skippedMatchCount = 0;
  let autoCount = 0, manualCount = 0;
  const memberPayouts = {};

  for (const match of settleMatches) {
    const label = `#${match.seq_no} ${getTeamNameZh(match.home_team_name)} vs ${getTeamNameZh(match.away_team_name)}`;

    // 先撈未結算注單；沒有待結就直接跳過（不花 API 額度，也不重碰已結算場次）
    const { data: unsettledBets, error: betsErr } = await supabase
      .from('bets')
      .select('id, user_name, market, selection, line, line_type, period, inverse, amount, odds')
      .eq('match_id', match.id)
      .is('result', null);

    if (betsErr) {
      console.warn(`[auto-settle] 撈注單失敗 ${label}:`, betsErr.message);
      continue;
    }
    if (!unsettledBets || unsettledBets.length === 0) continue;

    if (!match.api_football_fixture_id) {
      skippedMatchCount++;
      console.warn(`[auto-settle] 跳過（無 fixture_id）: ${label}`);
      continue;
    }

    // 比分：已存過就重用，沒有才打 API（省額度；補結晚到注單時通常已有比分）
    let fullScore = match.score_full || null;
    let halfScore = match.score_half || null;
    if (!fullScore) {
      const scores = await getScores({ apiKey, fixtureId: match.api_football_fixture_id });
      if (!scores || scores.fullTime.home == null || scores.fullTime.away == null) {
        skippedMatchCount++;
        console.warn(`[auto-settle] 跳過（比分未知）: ${label}`);
        continue;
      }
      fullScore = { home: scores.fullTime.home, away: scores.fullTime.away };
      halfScore = scores.halfTime.home != null
        ? { home: scores.halfTime.home, away: scores.halfTime.away }
        : null;
      await supabase.from('matches').update({ score_full: fullScore, score_half: halfScore }).eq('id', match.id);
    }

    // 有角球盤才撈角球統計（省 API 額度）
    const hasCornerBet = unsettledBets.some(b => b.market === '角球');
    const corners = hasCornerBet
      ? await getCorners({ apiKey, fixtureId: match.api_football_fixture_id })
      : null;
    if (hasCornerBet && !corners) {
      console.warn(`[auto-settle] 角球統計未取得，角球盤將標人工: ${label}`);
    }

    const homeTeamZh = getTeamNameZh(match.home_team_name);
    const awayTeamZh = getTeamNameZh(match.away_team_name);

    for (const bet of unsettledBets) {
      const score = bet.period === '半場' ? halfScore : fullScore;
      if (!score) {
        await supabase.from('bets').update({ result: RESULT.MANUAL, payout: 0 }).eq('id', bet.id);
        manualCount++;
        continue;
      }

      const result = settleBet(bet, score, {
        homeTeamZh,
        awayTeamZh,
        inverse: bet.inverse ?? false,
        corners  // 角球盤用；其他盤口會忽略
      });

      if (result === RESULT.MANUAL || result === RESULT.PENDING) {
        await supabase.from('bets').update({ result: RESULT.MANUAL, payout: 0 }).eq('id', bet.id);
        manualCount++;
      } else {
        const payout = payoutFor(result, bet.amount, bet.odds);
        await supabase.from('bets').update({ result, payout: payout ?? 0 }).eq('id', bet.id);
        autoCount++;
        if (payout != null) {
          const name = bet.user_name || '未知';
          memberPayouts[name] = (memberPayouts[name] || 0) + payout;
        }
      }
    }

    await supabase.from('matches').update({ settled_at: nowIso }).eq('id', match.id);
    settledMatchCount++;
  }

  // 串關結算
  let parlayAutoCount = 0, parlayManualCount = 0;

  const { data: parlayBets } = await supabase
    .from('bets')
    .select('id, user_name, condition, amount, created_at')
    .eq('market', '串關')
    .is('result', null)
    .like('ticket_id', 'P%');

  for (const parlay of (parlayBets || [])) {
    const rawLines = (parlay.condition || '').split('\n').map(l => l.trim()).filter(Boolean);
    const legs = rawLines.map(parseParlayLeg);

    if (legs.length === 0 || legs.some(l => l === null)) {
      await supabase.from('bets').update({ result: RESULT.MANUAL, payout: 0 }).eq('id', parlay.id);
      parlayManualCount++;
      console.warn(`[auto-settle] 串關解析失敗: id=${parlay.id}`);
      continue;
    }

    let allReady = true;
    const legContexts = [];
    for (const leg of legs) {
      const { data: m } = await supabase
        .from('matches')
        .select('id, home_team_name, away_team_name, home_is_giver, score_full, score_half')
        .eq('seq_no', leg.seqNo)
        .single();
      if (!m || !m.score_full) { allReady = false; break; }
      legContexts.push({ leg, match: m });
    }
    if (!allReady) continue;

    let anyManual = false;
    const multipliers = [];
    for (const { leg, match } of legContexts) {
      const cls = classifyBet(leg.condition);
      if (!cls || cls.market === '其他') { anyManual = true; break; }
      const homeZh = getTeamNameZh(match.home_team_name);
      const awayZh = getTeamNameZh(match.away_team_name);
      const inverse = calcInverse(cls, homeZh, match.home_is_giver);
      const score = cls.period === '半場' ? match.score_half : match.score_full;
      if (!score) { anyManual = true; break; }
      const legResult = settleBet(
        { market: cls.market, selection: cls.selection, line: cls.line, line_type: cls.line_type },
        score,
        { homeTeamZh: homeZh, awayTeamZh: awayZh, inverse: inverse ?? false }
      );
      const m = legMultiplier(legResult, leg.odds);
      if (m === null) { anyManual = true; break; }
      multipliers.push(m);
    }

    if (anyManual) {
      await supabase.from('bets').update({ result: RESULT.MANUAL, payout: 0 }).eq('id', parlay.id);
      parlayManualCount++;
      continue;
    }

    const combined = multipliers.reduce((a, b) => a * b, 1);
    const payout = Math.round(parlay.amount * (combined - 1));
    const finalResult = combined > 1 ? RESULT.WON : combined < 1 ? RESULT.LOST : RESULT.PUSH;

    await supabase.from('bets').update({ result: finalResult, payout }).eq('id', parlay.id);
    parlayAutoCount++;
    const pName = parlay.user_name || '未知';
    memberPayouts[pName] = (memberPayouts[pName] || 0) + payout;
  }

  return { date: todayTW, settledMatchCount, skippedMatchCount, autoCount, manualCount, parlayAutoCount, parlayManualCount, memberPayouts };
}

if (require.main === module) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    console.error('❌ 請設定 API_FOOTBALL_KEY 環境變數');
    process.exit(1);
  }

  autoSettle({ supabase, apiKey })
    .then(stats => {
      if (!stats) {
        console.log('✅ 今日無可結算場次（FINISHED 且未結算）');
        return;
      }
      const { date, settledMatchCount, skippedMatchCount, autoCount, manualCount, parlayAutoCount, parlayManualCount, memberPayouts } = stats;
      console.log(`✅ 結算完成（${date}）`);
      console.log(`  場次：${settledMatchCount} 結算 / ${skippedMatchCount} 跳過`);
      console.log(`  單注：${autoCount} 自動 / ${manualCount} 人工`);
      if (parlayAutoCount + parlayManualCount > 0) {
        console.log(`  串關：${parlayAutoCount} 自動 / ${parlayManualCount} 人工`);
      }
      const entries = Object.entries(memberPayouts).sort((a, b) => b[1] - a[1]);
      if (entries.length) {
        console.log('  會員輸贏：');
        for (const [name, p] of entries) console.log(`    ${name}  ${p >= 0 ? '+' : ''}${p}`);
      }
    })
    .catch(err => {
      console.error('❌ 結算失敗：', err.message);
      process.exit(1);
    });
}

module.exports = { autoSettle };
