require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;

async function syncMatchesToDatabase(apiMatches) {
  if (!apiMatches?.length) return;

  dayjs.extend(utc);
  dayjs.extend(timezone);

  const rows = apiMatches.map((match, index) => ({
    id: match.id,
    seq_no: index + 1,
    match_date: dayjs(match.utcDate).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm'),
    label: `${match.homeTeam?.name || 'TBD'} vs ${match.awayTeam?.name || 'TBD'}`,
    home_team_name: match.homeTeam?.name || 'TBD',
    away_team_name: match.awayTeam?.name || 'TBD',
    status: match.status,
    stage: match.stage,
    group_name: match.group,
    competition_name: match.competition?.name || 'FIFA World Cup',
    last_updated: match.lastUpdated,
    raw_data: match
  }));

  const { error } = await supabase
    .from('matches')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw error;
  console.log(`✅ 同步完成，共 ${rows.length} 場比賽 `);
}

async function main() {
  const response = await axios.get(
    'https://api.football-data.org/v4/competitions/WC/matches',
    { headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY } }
  );

  const matches = response.data.matches || [];
  await syncMatchesToDatabase(matches);
}

main().catch(err => {
  console.error('❌ 同步失敗：', err.message);
  process.exit(1); // 讓 GitHub Actions 知道失敗
});