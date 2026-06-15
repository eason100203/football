/**
 * backfill-scores.js
 *
 * 一次性補抓比分：撈 matches status='FINISHED' AND score_full IS NULL 的場次，
 * 用 api_football_fixture_id 呼叫 API-Football 取回全/半場比分，寫回 score_full / score_half。
 *
 * 注意：本腳本只補比分，不結算 bets。比分補完後另跑結算流程。
 *
 * 預設 dry-run（只看不改）：
 *   node scripts/backfill-scores.js
 *
 * 確認後加 --apply 才真正寫入：
 *   node scripts/backfill-scores.js --apply
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { getScores } = require('../apiFootball');
const { getTeamNameZh } = require('../teamName');

const APPLY = process.argv.includes('--apply');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    console.error('❌ 請設定 API_FOOTBALL_KEY 環境變數');
    process.exit(1);
  }

  console.log(`\n=== backfill-scores [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===\n`);

  const { data: matches, error } = await supabase
    .from('matches')
    .select('id, seq_no, home_team_name, away_team_name, match_date, api_football_fixture_id, status, score_full')
    .eq('status', 'FINISHED')
    .is('score_full', null)
    .order('seq_no', { ascending: true });

  if (error) {
    console.error('撈取失敗:', error.message);
    process.exit(1);
  }

  console.log(`掃描目標：${(matches || []).length} 場（FINISHED + score_full IS NULL）\n`);

  if (!matches?.length) {
    console.log('✅ 無需補比分');
    return;
  }

  let filled = 0, noFixture = 0, noScore = 0, failed = 0, apiCalls = 0;

  for (const m of matches) {
    const label = `#${m.seq_no} ${getTeamNameZh(m.home_team_name)} vs ${getTeamNameZh(m.away_team_name)}`;
    const date = (m.match_date || '').slice(0, 10);

    // 缺 fixture_id → 無法抓比分
    if (!m.api_football_fixture_id) {
      noFixture++;
      console.log(`  ⚠️  缺 fixture_id：${label}（${date}）→ 需先補 fixture_id`);
      continue;
    }

    let scores;
    try {
      scores = await getScores({ apiKey, fixtureId: m.api_football_fixture_id });
      apiCalls++;
    } catch (err) {
      failed++;
      console.warn(`  ❌ API 錯誤：${label} — ${err.message}`);
      await sleep(300);
      continue;
    }

    await sleep(300); // 避免 rate limit

    // API 無比分（任一全場欄位 null）
    if (!scores || scores.fullTime.home == null || scores.fullTime.away == null) {
      noScore++;
      console.log(`  ⚠️  API 無比分：${label}（fixture=${m.api_football_fixture_id}）`);
      continue;
    }

    const scoreFull = { home: scores.fullTime.home, away: scores.fullTime.away };
    const scoreHalf = scores.halfTime.home != null
      ? { home: scores.halfTime.home, away: scores.halfTime.away }
      : null;

    if (APPLY) {
      const { error: upErr } = await supabase
        .from('matches')
        .update({ score_full: scoreFull, score_half: scoreHalf })
        .eq('id', m.id);

      if (upErr) {
        failed++;
        console.warn(`  ❌ 寫入失敗：${label} — ${upErr.message}`);
        continue;
      }
      filled++;
      console.log(`  ✅ ${label} → 全場 ${scoreFull.home}:${scoreFull.away}` +
        (scoreHalf ? ` / 半場 ${scoreHalf.home}:${scoreHalf.away}` : ' / 半場無'));
    } else {
      filled++;
      console.log(`  ✅ 可補：${label} → 全場 ${scoreFull.home}:${scoreFull.away}` +
        (scoreHalf ? ` / 半場 ${scoreHalf.home}:${scoreHalf.away}` : ' / 半場無'));
    }
  }

  console.log(
    `\n統計：掃描 ${matches.length} 場 / ` +
    `${APPLY ? '已補' : '可補'} ${filled} / ` +
    `缺 fixture_id ${noFixture} / API 無比分 ${noScore} / 失敗 ${failed}`
  );
  console.log(`API quota 消耗：${apiCalls} calls`);

  if (!APPLY) {
    console.log('\n⚠️  Dry-run 完成，未寫 DB。確認後加 --apply 執行寫入。');
  } else {
    console.log('\n✅ 補比分完成。下一步：對這些場次的 bets 跑結算。');
  }
}

main().catch((err) => {
  console.error('❌ 執行失敗：', err.message);
  process.exit(1);
});
