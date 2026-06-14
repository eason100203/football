require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const { getFixtureId, getHandicapGiver } = require('../apiFootball');
const { getTeamNameZh } = require('../teamName.js');

dayjs.extend(utc);
dayjs.extend(timezone);

/**
 * 掃描 home_is_giver IS NULL 的場次並回填。
 * @param {{ supabase, apiKey, cutoffDays? }} opts
 * @returns {{ scanned, success, neutral, failed, failedLabels }}
 */
async function syncHandicap({ supabase, apiKey, cutoffDays = 7 }) {
  const cutoff = dayjs().tz('Asia/Taipei').subtract(cutoffDays, 'day').format('YYYY-MM-DD 00:00');

  const { data: matches, error: fetchError } = await supabase
    .from('matches')
    .select('id, seq_no, home_team_name, away_team_name, match_date, api_football_fixture_id')
    .is('home_is_giver', null)
    .gte('match_date', cutoff)
    .order('seq_no', { ascending: true });

  if (fetchError) throw new Error(`查詢失敗: ${fetchError.message}`);
  if (!matches?.length) return { scanned: 0, success: 0, neutral: 0, failed: 0, failedLabels: [] };

  let success = 0, neutral = 0, failed = 0;
  const failedLabels = [];

  for (const match of matches) {
    const label = `#${match.seq_no} ${getTeamNameZh(match.home_team_name)} vs ${getTeamNameZh(match.away_team_name)}`;
    try {
      let fixtureId = match.api_football_fixture_id;

      if (!fixtureId) {
        const date = (match.match_date || '').slice(0, 10);
        const found = await getFixtureId({
          apiKey,
          homeTeam: match.home_team_name,
          awayTeam: match.away_team_name,
          date
        });
        if (!found) {
          failed++;
          failedLabels.push(label);
          console.warn(`[sync-handicap] 查無 fixture: ${label}`);
          continue;
        }
        fixtureId = found.fixtureId;
      }

      const giver = await getHandicapGiver({ apiKey, fixtureId });

      const updatePayload = { api_football_fixture_id: fixtureId };
      if (giver === 'home') updatePayload.home_is_giver = true;
      else if (giver === 'away') updatePayload.home_is_giver = false;

      await supabase.from('matches').update(updatePayload).eq('id', match.id);

      if (giver === null) neutral++;
      else success++;

      console.log(`[sync-handicap] ${label} → ${giver ?? '平水盤'}`);
    } catch (err) {
      failed++;
      failedLabels.push(label);
      console.warn(`[sync-handicap] 錯誤 ${label}:`, err.message);
    }
  }

  return { scanned: matches.length, success, neutral, failed, failedLabels };
}

if (require.main === module) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  const apiKey = process.env.API_FOOTBALL_KEY;

  if (!apiKey) {
    console.error('❌ 請設定 API_FOOTBALL_KEY 環境變數');
    process.exit(1);
  }

  syncHandicap({ supabase, apiKey })
    .then(({ scanned, success, neutral, failed, failedLabels }) => {
      console.log(`✅ 盤口同步完成：掃描 ${scanned} 場 / 成功 ${success} / 平水 ${neutral} / 失敗 ${failed}`);
      if (failedLabels.length) console.log(`  失敗: ${failedLabels.join('、')}`);
      if (failed > 0 && success === 0 && neutral === 0) process.exit(1);
    })
    .catch(err => {
      console.error('❌ 同步失敗：', err.message);
      process.exit(1);
    });
}

module.exports = { syncHandicap };
