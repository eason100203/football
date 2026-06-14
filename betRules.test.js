const { classifyBet, settleBet, mirrorResult, legMultiplier, RESULT } = require('./betRules');

// 共用 ctx：日本主場 vs 巴西客場
const CTX = { homeTeamZh: '日本', awayTeamZh: '巴西' };

// ─── 既有功能：classifyBet（13 條）────────────────────────────────────────

describe('classifyBet', () => {
  test('日本 1平 → 讓分', () => {
    const r = classifyBet('日本 1平');
    expect(r.market).toBe('讓分');
    expect(r.period).toBe('全場');
    expect(r.selection).toBe('日本');
    expect(r.line).toBe(1);
    expect(r.line_type).toBe('平');
  });

  test('日本 2+50 → 讓分 +50', () => {
    const r = classifyBet('日本 2+50');
    expect(r.market).toBe('讓分');
    expect(r.line).toBe(2);
    expect(r.line_type).toBe('+50');
  });

  test('日本 1-50 → 讓分 -50', () => {
    const r = classifyBet('日本 1-50');
    expect(r.market).toBe('讓分');
    expect(r.line).toBe(1);
    expect(r.line_type).toBe('-50');
  });

  test('巴西 讓0 → 讓分 line=0 平', () => {
    const r = classifyBet('巴西 讓0');
    expect(r.market).toBe('讓分');
    expect(r.line).toBe(0);
    expect(r.line_type).toBe('平');
  });

  test('半場 日本 1平 → period 半場', () => {
    const r = classifyBet('半場 日本 1平');
    expect(r.period).toBe('半場');
    expect(r.market).toBe('讓分');
  });

  test('大1.5 → 大小 大 line=1.5 .5', () => {
    const r = classifyBet('大1.5');
    expect(r.market).toBe('大小');
    expect(r.selection).toBe('大');
    expect(r.line).toBe(1.5);
    expect(r.line_type).toBe('.5');
  });

  test('小2平 → 大小 小 line=2 平', () => {
    const r = classifyBet('小2平');
    expect(r.market).toBe('大小');
    expect(r.selection).toBe('小');
    expect(r.line).toBe(2);
    expect(r.line_type).toBe('平');
  });

  test('大2+50 → 大小 大 line=2 +50', () => {
    const r = classifyBet('大2+50');
    expect(r.market).toBe('大小');
    expect(r.selection).toBe('大');
    expect(r.line).toBe(2);
    expect(r.line_type).toBe('+50');
  });

  test('2:1 → 波膽', () => {
    const r = classifyBet('2:1');
    expect(r.market).toBe('波膽');
    expect(r.selection).toBe('2:1');
  });

  test('單 → 單雙', () => {
    expect(classifyBet('單').market).toBe('單雙');
    expect(classifyBet('單').selection).toBe('單');
  });

  test('雙 → 單雙', () => {
    expect(classifyBet('雙').market).toBe('單雙');
    expect(classifyBet('雙').selection).toBe('雙');
  });

  test('日本（獨贏）', () => {
    const r = classifyBet('日本');
    expect(r.market).toBe('獨贏');
    expect(r.selection).toBe('日本');
  });

  test('和 → 獨贏 selection=和', () => {
    const r = classifyBet('和');
    expect(r.market).toBe('獨贏');
    expect(r.selection).toBe('和');
  });
});

// ─── 既有功能：settleBet 讓分（5 條）────────────────────────────────────────

describe('settleBet 讓分', () => {
  const base = { market: '讓分', selection: '日本', line: 1 };

  test('margin 2 > A 1 → WON', () => {
    const bet = { ...base, line_type: '平' };
    expect(settleBet(bet, { home: 3, away: 1 }, CTX)).toBe(RESULT.WON);
  });

  test('margin 0 < A 1 → LOST', () => {
    const bet = { ...base, line_type: '平' };
    expect(settleBet(bet, { home: 1, away: 1 }, CTX)).toBe(RESULT.LOST);
  });

  test('margin = A，平 → PUSH', () => {
    const bet = { ...base, line_type: '平' };
    expect(settleBet(bet, { home: 2, away: 1 }, CTX)).toBe(RESULT.PUSH);
  });

  test('margin = A，+50 → HALF_WON', () => {
    const bet = { ...base, line_type: '+50' };
    expect(settleBet(bet, { home: 2, away: 1 }, CTX)).toBe(RESULT.HALF_WON);
  });

  test('margin = A，-50 → HALF_LOST', () => {
    const bet = { ...base, line_type: '-50' };
    expect(settleBet(bet, { home: 2, away: 1 }, CTX)).toBe(RESULT.HALF_LOST);
  });
});

// ─── 既有功能：settleBet 大小（3 條）────────────────────────────────────────

describe('settleBet 大小', () => {
  test('大1.5 total=2 → WON', () => {
    const bet = { market: '大小', selection: '大', line: 1.5, line_type: '.5' };
    expect(settleBet(bet, { home: 2, away: 0 })).toBe(RESULT.WON);
  });

  test('大1.5 total=1 → LOST', () => {
    const bet = { market: '大小', selection: '大', line: 1.5, line_type: '.5' };
    expect(settleBet(bet, { home: 0, away: 1 })).toBe(RESULT.LOST);
  });

  test('大2平 total=2 → PUSH', () => {
    const bet = { market: '大小', selection: '大', line: 2, line_type: '平' };
    expect(settleBet(bet, { home: 1, away: 1 })).toBe(RESULT.PUSH);
  });
});

// ─── 新增：mirrorResult helper（6 條）────────────────────────────────────────

describe('mirrorResult helper', () => {
  test('won → lost', () => expect(mirrorResult(RESULT.WON)).toBe(RESULT.LOST));
  test('lost → won', () => expect(mirrorResult(RESULT.LOST)).toBe(RESULT.WON));
  test('half_won → half_lost', () => expect(mirrorResult(RESULT.HALF_WON)).toBe(RESULT.HALF_LOST));
  test('half_lost → half_won', () => expect(mirrorResult(RESULT.HALF_LOST)).toBe(RESULT.HALF_WON));
  test('push → push（不變）', () => expect(mirrorResult(RESULT.PUSH)).toBe(RESULT.PUSH));
  test('manual → manual（不變）', () => expect(mirrorResult(RESULT.MANUAL)).toBe(RESULT.MANUAL));
});

// ─── 新增：inverse handicap settling（6 條）──────────────────────────────────

describe('inverse handicap settling', () => {
  const base = { market: '讓分', selection: '日本', line: 1 };
  const score11 = { home: 2, away: 1 }; // margin = 1（= A）

  test('讓1平 margin=A：push 鏡像不變', () => {
    const bet = { ...base, line_type: '平' };
    expect(settleBet(bet, score11, { ...CTX, inverse: false })).toBe(RESULT.PUSH);
    expect(settleBet(bet, score11, { ...CTX, inverse: true })).toBe(RESULT.PUSH);
  });

  test('讓1-50 margin=A：half_lost → half_win', () => {
    const bet = { ...base, line_type: '-50' };
    expect(settleBet(bet, score11, { ...CTX, inverse: false })).toBe(RESULT.HALF_LOST);
    expect(settleBet(bet, score11, { ...CTX, inverse: true })).toBe(RESULT.HALF_WON);
  });

  test('讓1+50 margin=A：half_win → half_lost', () => {
    const bet = { ...base, line_type: '+50' };
    expect(settleBet(bet, score11, { ...CTX, inverse: false })).toBe(RESULT.HALF_WON);
    expect(settleBet(bet, score11, { ...CTX, inverse: true })).toBe(RESULT.HALF_LOST);
  });

  test('讓1 margin=2 > A：win → lose', () => {
    const bet = { ...base, line_type: '平' };
    const score = { home: 3, away: 1 }; // margin = 2
    expect(settleBet(bet, score, { ...CTX, inverse: false })).toBe(RESULT.WON);
    expect(settleBet(bet, score, { ...CTX, inverse: true })).toBe(RESULT.LOST);
  });

  test('讓1 margin=0 < A：lose → win', () => {
    const bet = { ...base, line_type: '平' };
    const score = { home: 1, away: 1 }; // margin = 0
    expect(settleBet(bet, score, { ...CTX, inverse: false })).toBe(RESULT.LOST);
    expect(settleBet(bet, score, { ...CTX, inverse: true })).toBe(RESULT.WON);
  });

  test('大小 selection 自行處理大小邊：大1.5 WON、小1.5 LOST', () => {
    const score = { home: 2, away: 0 };
    expect(settleBet({ market: '大小', selection: '大', line: 1.5, line_type: '.5' }, score)).toBe(RESULT.WON);
    expect(settleBet({ market: '大小', selection: '小', line: 1.5, line_type: '.5' }, score)).toBe(RESULT.LOST);
  });
});

// ─── 新增：大小 +50/-50 settling（8 條）────────────────────────────────────────

describe('大小 +50/-50 settling', () => {
  // 下大球 —— -50 (X.25 線)
  test('大 2-50, total=3 → WON', () => {
    const bet = { market: '大小', selection: '大', line: 2, line_type: '-50' };
    expect(settleBet(bet, { home: 1, away: 2 })).toBe(RESULT.WON);
  });
  test('大 2-50, total=2 → HALF_LOST', () => {
    const bet = { market: '大小', selection: '大', line: 2, line_type: '-50' };
    expect(settleBet(bet, { home: 1, away: 1 })).toBe(RESULT.HALF_LOST);
  });
  test('大 2-50, total=1 → LOST', () => {
    const bet = { market: '大小', selection: '大', line: 2, line_type: '-50' };
    expect(settleBet(bet, { home: 1, away: 0 })).toBe(RESULT.LOST);
  });

  // 下大球 —— +50 (X-0.25 線)
  test('大 3+50, total=4 → WON', () => {
    const bet = { market: '大小', selection: '大', line: 3, line_type: '+50' };
    expect(settleBet(bet, { home: 2, away: 2 })).toBe(RESULT.WON);
  });
  test('大 3+50, total=3 → HALF_WON', () => {
    const bet = { market: '大小', selection: '大', line: 3, line_type: '+50' };
    expect(settleBet(bet, { home: 1, away: 2 })).toBe(RESULT.HALF_WON);
  });
  test('大 3+50, total=2 → LOST', () => {
    const bet = { market: '大小', selection: '大', line: 3, line_type: '+50' };
    expect(settleBet(bet, { home: 1, away: 1 })).toBe(RESULT.LOST);
  });

  // 下小球 —— selection='小' 直接處理（不走 inverse）
  test('小 2-50, total=2 → HALF_WON', () => {
    const bet = { market: '大小', selection: '小', line: 2, line_type: '-50' };
    expect(settleBet(bet, { home: 1, away: 1 })).toBe(RESULT.HALF_WON);
  });
  test('小 3+50, total=3 → HALF_LOST', () => {
    const bet = { market: '大小', selection: '小', line: 3, line_type: '+50' };
    expect(settleBet(bet, { home: 1, away: 2 })).toBe(RESULT.HALF_LOST);
  });
});

// ─── 新增：串關 legMultiplier（6 條）─────────────────────────────────────────

describe('parlay legMultiplier', () => {
  test('WON odds=0.8 → 1.8', () => {
    expect(legMultiplier(RESULT.WON, 0.8)).toBeCloseTo(1.8);
  });

  test('HALF_WON odds=1.0 → 1.5', () => {
    expect(legMultiplier(RESULT.HALF_WON, 1.0)).toBeCloseTo(1.5);
  });

  test('PUSH odds=0.9 → 1（odds 無影響）', () => {
    expect(legMultiplier(RESULT.PUSH, 0.9)).toBe(1);
  });

  test('HALF_LOST odds=1.0 → 0.5', () => {
    expect(legMultiplier(RESULT.HALF_LOST, 1.0)).toBe(0.5);
  });

  test('LOST odds=0.9 → 0', () => {
    expect(legMultiplier(RESULT.LOST, 0.9)).toBe(0);
  });

  test('MANUAL → null（觸發人工）', () => {
    expect(legMultiplier(RESULT.MANUAL, 1.0)).toBeNull();
  });

  test('三 leg 全 WON 0.8×1.0×0.5 → combined ≈ 5.4', () => {
    const combined = legMultiplier(RESULT.WON, 0.8)
                   * legMultiplier(RESULT.WON, 1.0)
                   * legMultiplier(RESULT.WON, 0.5);
    expect(combined).toBeCloseTo(5.4);
  });

  test('WON + LOST → combined = 0', () => {
    const combined = legMultiplier(RESULT.WON, 0.9) * legMultiplier(RESULT.LOST, 0.8);
    expect(combined).toBe(0);
  });
});
