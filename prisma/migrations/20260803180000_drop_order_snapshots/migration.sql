-- Снимки заказов уходят вместе с ревизиями расчёта.
--
-- Их смысл был в том, чтобы объяснять уже созданное начисление: начисление ссылалось на
-- конкретную ревизию, и ревизия обязана была пережить любые правки данных. Начислений в
-- книге больше нет — заработок выводится из итога дня, — и объяснять ревизиями стало
-- нечего. Расчёт объясняет себя сам: он всегда соответствует текущим данным.
--
-- Данные не переносятся: производное сносится, система считает заново.

DROP TRIGGER IF EXISTS "OrderFinancialSnapshot_guard_update" ON "OrderFinancialSnapshot";
DROP TRIGGER IF EXISTS "OrderFinancialSnapshot_guard_delete" ON "OrderFinancialSnapshot";
DROP FUNCTION IF EXISTS "order_financial_snapshot_guard"();

DROP TABLE IF EXISTS "LedgerEntrySnapshot";
DROP TABLE IF EXISTS "OrderFinancialSnapshot";

DROP TYPE IF EXISTS "SnapshotStatus";
