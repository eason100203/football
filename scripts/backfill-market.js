/**
 * backfill-market.js
 *
 * 回填 market=null/其他 且 result=null/manual 的 bets：
 * 用最新 classifyBet 重新 parse condition，修正 market / line / line_type / inverse。
 * 若原 result='manual' 且新 market 是可自動結算的盤口 → 同步重置 result=null，
 * 讓下次 auto-settle 重新計算。
 *
 * 預設 dry-run（只列差異，不寫 DB）：
 *   node scripts/backfill-market.js
 *
 * 確認後加 --apply 才真正更新：
 *   node scripts/backfill-market.js --apply
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { classifyBet } = require('../betRules');
const { getTeamNameZh } = require('../teamName');

const APPLY = process.argv.includes('--apply');

// 這些 market 有自動 settle 邏輯（角球永遠 MANUAL，不列入）
const AUTO_SETTLE = new Set(['讓分', '大小', '波膽', '獨贏', '單雙']);

function calcInverse(cls, homeTeamZh, homeIsGiver) {
  if (cls.market !== '讓分') return false;
  if (homeIsGiver == null) return null;
  const selectionIsHome = cls.selection === homeTeamZh;
  return homeIsGiver ? !selectionIsHome : selectionIsHome;
}

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

  console.log(`\n=== backfill-market [${APPLY ? 'APPLY' : 'DRY-RUN'}] ===\n`);

  // 撈 (market IS NULL OR market='其他') AND (result IS NULL OR result='manual')
  // 兩次撈再 merge，避免 PostgREST 巢狀 OR 語法問題
  const [r1, r2] = await Promise.all([
    supabase
      .from('bets')
      .select('id, ticket_id, condition, market, result, period, match_id, user_name')
      .is('market', null)
      .or('result.is.null,result.eq.manual')
      .order('id', { ascending: true }),
    supabase
      .from('bets')
      .select('id, ticket_id, condition, market, result, period, match_id, user_name')
      .eq('market', '其他')
      .or('result.is.null,result.eq.manual')
      .order('id', { ascending: true }),
  ]);

  if (r1.error) { console.error('撈取失敗 (null):', r1.error.message); process.exit(1); }
  if (r2.error) { console.error('撈取失敗 (其他):', r2.error.message); process.exit(1); }

  // 合併去重
  const seen = new Set();
  const allBets = [...(r1.data || []), ...(r2.data || [])].filter(b => {
    if (seen.has(b.id)) return false;
    seen.add(b.id);
    return true;
  });

  const targets = allBets.filter(b => !b.ticket_id?.startsWith('P'));
  console.log(`掃描目標：${targets.length} 筆（market=null/其他 + result=null/manual + 非串關）\n`);

  if (!targets.length) {
    console.log('✅ 無需回填');
    return;
  }

  const matchCache = {};
  const marketDist = {};
  const samples = [];
  let willUpdate = 0, willResetResult = 0, skipped = 0;

  for (const bet of targets) {
    const cls = classifyBet(bet.condition || '');
    const newMarket = cls?.market || '其他';
    marketDist[newMarket] = (marketDist[newMarket] || 0) + 1;

    // 仍解析成「其他」→ 跳過
    if (!cls || cls.market === '其他') {
      skipped++;
      continue;
    }

    // 組 update payload
    const payload = {
      period:    cls.period,
      market:    cls.market,
      selection: cls.selection,
      line:      cls.line,
      line_type: cls.line_type,
    };

    // 若原 result='manual' 且新 market 可自動結算 → 重置為 null
    const shouldResetResult = bet.result === 'manual' && AUTO_SETTLE.has(cls.market);
    if (shouldResetResult) {
      payload.result = null;
      willResetResult++;
    }

    // 讓分需要另算 inverse
    if (cls.market === '讓分' && bet.match_id) {
      if (!matchCache[bet.match_id]) {
        const { data: m } = await supabase
          .from('matches')
          .select('home_team_name, home_is_giver')
          .eq('id', bet.match_id)
          .single();
        matchCache[bet.match_id] = m ?? null;
      }
      const match = matchCache[bet.match_id];
      if (match) {
        const homeTeamZh = getTeamNameZh(match.home_team_name);
        payload.inverse = calcInverse(cls, homeTeamZh, match.home_is_giver);
      }
    }

    // 收前 5 筆 sample
    if (samples.length < 5) {
      samples.push({
        id:          bet.id,
        user:        bet.user_name || '?',
        condition:   bet.condition,
        fromMarket:  bet.market ?? 'null',
        fromResult:  bet.result ?? 'null',
        toMarket:    cls.market,
        line:        cls.line,
        line_type:   cls.line_type,
        inverse:     payload.inverse !== undefined ? payload.inverse : '(非讓分)',
        resetResult: shouldResetResult,
      });
    }

    if (APPLY) {
      try {
        const { error: upErr } = await supabase
          .from('bets')
          .update(payload)
          .eq('id', bet.id);

        if (upErr) {
          console.warn(`  ❌ 更新失敗 id=${bet.id}: ${upErr.message}`);
          skipped++;
          continue;
        }
        willUpdate++;
        const resetTag = shouldResetResult ? ' [result→null]' : '';
        console.log(`  ✅ id=${bet.id} [${bet.user_name}] "${bet.condition}" → ${cls.market}${resetTag}`);
      } catch (err) {
        console.warn(`  ❌ 例外 id=${bet.id}: ${err.message}`);
        skipped++;
      }
    } else {
      willUpdate++;
    }
  }

  // 新 market 分佈
  console.log('新 market 分佈：');
  for (const [market, count] of Object.entries(marketDist).sort((a, b) => b[1] - a[1])) {
    const tag = market === '其他' ? ' ← 仍無法辨識（skip）' : '';
    console.log(`  ${market}: ${count} 筆${tag}`);
  }

  // 前 5 筆 sample
  if (samples.length) {
    console.log('\n抽樣（前 5 筆）：');
    for (const s of samples) {
      const resetTag = s.resetResult ? ' ★result→null' : '';
      console.log(
        `  id=${s.id} [${s.user}] "${s.condition}"\n` +
        `    market: ${s.fromMarket} → ${s.toMarket}  result: ${s.fromResult}${resetTag}\n` +
        `    line=${s.line}  line_type=${s.line_type}  inverse=${s.inverse}`
      );
    }
  }

  // 統計
  console.log(
    `\n統計：掃描 ${targets.length} 筆 / ` +
    `${APPLY ? '已更新' : '待更新'} ${willUpdate} 筆 / ` +
    `其中 result 重置 ${willResetResult} 筆 / ` +
    `skip ${skipped} 筆`
  );

  if (!APPLY) {
    console.log('\n⚠️  Dry-run 完成，未寫 DB。確認後加 --apply 執行更新。');
  } else {
    console.log('\n✅ 回填完成');
  }
}

main().catch(err => {
  console.error('❌ 執行失敗：', err.message);
  process.exit(1);
});
