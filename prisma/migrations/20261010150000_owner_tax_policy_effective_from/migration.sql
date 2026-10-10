-- Налоговая политика владельца получает дату начала (владелец 10.10.2026: новая ставка действует
-- с выбранного дня, прошлое до него считается по прежней). Только эта настройка: она меняет лишь
-- картину дохода владельца, база флориста от неё не зависит.
--
-- Существующие записи становятся «всегда» (2000-01-01) — до первой правки ничего не меняется.
-- Старый код в окне деплоя пишет без даты и получает то же «всегда» из умолчания; уникальность по
-- одной области он не использует (ищет findFirst), поэтому снятие индекса ему не мешает.
ALTER TABLE "OwnerTaxPolicy" ADD COLUMN "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT '2000-01-01 00:00:00'::timestamp without time zone;

DROP INDEX IF EXISTS "OwnerTaxPolicy_siteId_key";
DROP INDEX IF EXISTS "OwnerTaxPolicy_global_unique";

CREATE UNIQUE INDEX "OwnerTaxPolicy_siteId_effectiveFrom_key" ON "OwnerTaxPolicy"("siteId", "effectiveFrom");
-- NULL в обычном уникальном индексе сам с собой не сравнивается: общей записи на одну дату — одна.
CREATE UNIQUE INDEX "OwnerTaxPolicy_global_effectiveFrom_unique" ON "OwnerTaxPolicy"("effectiveFrom") WHERE "siteId" IS NULL;
