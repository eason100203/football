const { getFixtureId, getScores, getHandicapGiver } = require('./apiFootball');

const API_KEY = process.env.API_FOOTBALL_KEY;

// 整合測試需要真實 API key，沒設環境變數就全 skip
const describeIfKey = API_KEY ? describe : describe.skip;

describeIfKey('API-Football 整合測試', () => {
  // 已知 fixture ids（測試前已手動驗證）
  const USA_PY_ID   = 1489370; // USA vs Paraguay       API 2026-06-13
  const CAN_BIH_ID  = 1539000; // Canada vs Bosnia&Her  API 2026-06-12 19:00 UTC
  const AUS_TUR_ID  = 1539001; // Australia vs Türkiye  API 2026-06-14（DB 存 Turkey）
  const BRA_MOR_ID  = 1489371; // Brazil vs Morocco     API 2026-06-13，DB 存 2026-06-14
  const GER_CUR_ID  = 1489374; // Germany vs Curaçao    API 2026-06-14，DB 存 2026-06-15

  describe('getFixtureId — 基本', () => {
    test('USA vs Paraguay → fixture 1489370', async () => {
      const result = await getFixtureId({
        apiKey:    API_KEY,
        homeTeam:  'United States',
        awayTeam:  'Paraguay',
        date:      '2026-06-13'
      });
      expect(result).not.toBeNull();
      expect(result.fixtureId).toBe(USA_PY_ID);
    }, 15000);

    test('Canada vs Bosnia & Herzegovina → fixture 1539000', async () => {
      const result = await getFixtureId({
        apiKey:    API_KEY,
        homeTeam:  'Canada',
        awayTeam:  'Bosnia',
        date:      '2026-06-12'
      });
      expect(result).not.toBeNull();
      expect(result.fixtureId).toBe(CAN_BIH_ID);
    }, 15000);
  });

  describe('getFixtureId — Türkiye alias + D-1 date fallback', () => {
    test('Australia vs Turkey（DB 名）→ alias 命中 API 的 Türkiye', async () => {
      const result = await getFixtureId({
        apiKey:   API_KEY,
        homeTeam: 'Australia',
        awayTeam: 'Turkey',
        date:     '2026-06-14'
      });
      expect(result).not.toBeNull();
      expect(result.fixtureId).toBe(AUS_TUR_ID);
    }, 15000);

    test('Brazil vs Morocco DB=2026-06-14 → D-1 fallback 找到 API 2026-06-13 fixture', async () => {
      const result = await getFixtureId({
        apiKey:   API_KEY,
        homeTeam: 'Brazil',
        awayTeam: 'Morocco',
        date:     '2026-06-14'  // DB 存的 UTC 日期；API 存 2026-06-13（美東時間）
      });
      expect(result).not.toBeNull();
      expect(result.fixtureId).toBe(BRA_MOR_ID);
    }, 20000); // 最多 2 次 API call

    test('Germany vs Curaçao DB=2026-06-15 → D-1 fallback 找到 API 2026-06-14 fixture', async () => {
      const result = await getFixtureId({
        apiKey:   API_KEY,
        homeTeam: 'Germany',
        awayTeam: 'Curaçao',
        date:     '2026-06-15'  // DB 存的 UTC 日期；API 存 2026-06-14
      });
      expect(result).not.toBeNull();
      expect(result.fixtureId).toBe(GER_CUR_ID);
    }, 20000);
  });

  describe('getHandicapGiver', () => {
    test('USA vs Paraguay → home giver（美國讓）', async () => {
      const result = await getHandicapGiver({ apiKey: API_KEY, fixtureId: USA_PY_ID });
      expect(result).toBe('home');
    }, 15000);

    test('Canada vs Bosnia → home giver（加拿大讓）', async () => {
      const result = await getHandicapGiver({ apiKey: API_KEY, fixtureId: CAN_BIH_ID });
      expect(result).toBe('home');
    }, 15000);
  });

  describe('getScores', () => {
    test('USA vs Paraguay — 未開賽時 fullTime / halfTime 應為 null', async () => {
      const result = await getScores({ apiKey: API_KEY, fixtureId: USA_PY_ID });
      expect(result).not.toBeNull();
      expect(result).toHaveProperty('fullTime');
      expect(result).toHaveProperty('halfTime');
      // 比賽未開打：值為 null；開打後則為數字，兩種都接受
      const isNullOrNumber = v => v === null || typeof v === 'number';
      expect(isNullOrNumber(result.fullTime.home)).toBe(true);
      expect(isNullOrNumber(result.fullTime.away)).toBe(true);
      expect(isNullOrNumber(result.halfTime.home)).toBe(true);
      expect(isNullOrNumber(result.halfTime.away)).toBe(true);
    }, 15000);
  });
});
