-- ============================================================
-- 為 bets 表新增結構化欄位（自動結算用）
-- 全部可為 null，不影響既有資料與下注流程
-- 請在部署新版「之前」於 Supabase SQL Editor 執行；不跑也不會壞（程式會自動降級相容模式）
-- ============================================================
alter table public.bets add column if not exists period     text;     -- 全場 / 半場
alter table public.bets add column if not exists market     text;     -- 獨贏/讓分/大小/單雙/波膽/角球/串關/其他
alter table public.bets add column if not exists selection  text;     -- 下哪邊（隊伍/大小/單雙/比分）
alter table public.bets add column if not exists "line"     numeric;  -- 讓球數 或 大小盤線
alter table public.bets add column if not exists line_type  text;     -- 平 / +50 / -50 / .5 / 整數
alter table public.bets add column if not exists result     text;     -- won/half_won/push/half_lost/lost/pending/manual
alter table public.bets add column if not exists payout     numeric;  -- 結算盈虧（淨額）
