require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const FOOTBALL_DATA_API_KEY = process.env.FOOTBALL_DATA_API_KEY;
const STANDINGS_URL = 'https://api.football-data.org/v4/competitions/WC/standings';

async function syncStandingsToDatabase(apiStandings, competition = {}, season = {}) {
  if (!apiStandings?.length) return;

  const competitionCode = competition.code || 'WC';
  const competitionName = competition.name || 'FIFA World Cup';

  const rows = [];

  apiStandings.forEach((standing) => {
    const groupName = standing.group || standing.stage || standing.type || 'overall';

    standing.table?.forEach((teamRow) => {
      rows.push({
        competition_code: competitionCode,
        competition_name: competitionName,
        season_start: season.startDate || null,
        season_end: season.endDate || null,
        group_name: groupName,
        stage: standing.stage || null,
        table_type: standing.type || null,
        team_id: teamRow.team?.id || null,
        team_name: teamRow.team?.name || null,
        team_short_name: teamRow.team?.shortName || null,
        team_tla: teamRow.team?.tla || null,
        crest_url: teamRow.team?.crest || null,
        position: teamRow.position,
        played_games: teamRow.playedGames,
        form: teamRow.form || null,
        won: teamRow.won,
        draw: teamRow.draw,
        lost: teamRow.lost,
        points: teamRow.points,
        goals_for: teamRow.goalsFor,
        goals_against: teamRow.goalsAgainst,
        goal_difference: teamRow.goalDifference,
        last_updated: teamRow.lastUpdated || new Date().toISOString(),
        raw_data: teamRow
      });
    });
  });

  // 先移除舊的同一個賽事資料，再重新插入，避免重複
  const { error: deleteError } = await supabase
    .from('standings')
    .delete()
    .eq('competition_code', competitionCode);

  if (deleteError) throw deleteError;

  const { error: insertError } = await supabase
    .from('standings')
    .insert(rows);

  if (insertError) throw insertError;

  console.log(`✅ 同步完成，共 ${rows.length} 筆 standings 資料`);
}

async function main() {
  const response = await axios.get(STANDINGS_URL, {
    headers: { 'X-Auth-Token': FOOTBALL_DATA_API_KEY }
  });
  const standings = response.data.standings || [];
  const competition = response.data.competition || {};
  const season = response.data.season || {};
  await syncStandingsToDatabase(standings, competition, season);
}

main().catch(err => {
  console.error('❌ sync-standings failed:', err.response?.data || err.message || err);
  process.exit(1);
});
