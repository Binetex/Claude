-- Периоды действия у настроек расчёта.
--
-- Датированные ставки означали, что вчерашний день считается не так, как сегодняшний, и
-- вопрос «почему тут другая сумма» требовал раскопок в интервалах. За это платили
-- интервальной арифметикой, GiST-непересечением, различением «новая ставка с даты» и
-- «исправление ошибки», подневной подстановкой значений в предпросмотре.
--
-- Остаётся одна строка на область с текущим значением. История значений никуда не
-- девается — она в FinanceAudit, где у каждой правки есть автор, время и причина.
--
-- Из нескольких строк остаётся ДЕЙСТВУЮЩАЯ на сегодня; если такой нет (все периоды
-- будущие) — самая ранняя. Прочие удаляются: они описывали прошлое, которое больше не
-- пересчитывается по своим ставкам.

-- ─────────────── 1. Схлопывание до одной строки на область ───────────────

DELETE FROM "ConsumablesRate" a USING "ConsumablesRate" b
WHERE COALESCE(a."siteId", '') = COALESCE(b."siteId", '')
  AND a.id <> b.id
  AND (b."effectiveFrom" <= now(), b."effectiveFrom") > (a."effectiveFrom" <= now(), a."effectiveFrom");

DELETE FROM "SiteAcquiringFeeModel" a USING "SiteAcquiringFeeModel" b
WHERE a."siteId" = b."siteId"
  AND a.id <> b.id
  AND (b."effectiveFrom" <= now(), b."effectiveFrom") > (a."effectiveFrom" <= now(), a."effectiveFrom");

DELETE FROM "OwnerTaxPolicy" a USING "OwnerTaxPolicy" b
WHERE COALESCE(a."siteId", '') = COALESCE(b."siteId", '')
  AND a.id <> b.id
  AND (b."effectiveFrom" <= now(), b."effectiveFrom") > (a."effectiveFrom" <= now(), a."effectiveFrom");

DELETE FROM "VasePurchaseCost" a USING "VasePurchaseCost" b
WHERE COALESCE(a."productVariantId", '') = COALESCE(b."productVariantId", '')
  AND COALESCE(a."productId", '') = COALESCE(b."productId", '')
  AND a."costType" = b."costType"
  AND a.id <> b.id
  AND (b."effectiveFrom" <= now(), b."effectiveFrom") > (a."effectiveFrom" <= now(), a."effectiveFrom");

-- ─────────────── 2. Снятие интервальных ограничений ───────────────

ALTER TABLE "ConsumablesRate" DROP CONSTRAINT IF EXISTS "CR_no_overlap";
ALTER TABLE "SiteAcquiringFeeModel" DROP CONSTRAINT IF EXISTS "SAFM_no_overlap";
ALTER TABLE "OwnerTaxPolicy" DROP CONSTRAINT IF EXISTS "OTP_no_overlap";
ALTER TABLE "VasePurchaseCost" DROP CONSTRAINT IF EXISTS "VasePurchaseCost_no_overlap_variant";
ALTER TABLE "VasePurchaseCost" DROP CONSTRAINT IF EXISTS "VasePurchaseCost_no_overlap_product";
ALTER TABLE "VasePurchaseCost" DROP CONSTRAINT IF EXISTS "VasePurchaseCost_period_order";

DROP INDEX IF EXISTS "ConsumablesRate_siteId_effectiveFrom_idx";
DROP INDEX IF EXISTS "ConsumablesRate_effectiveTo_idx";
DROP INDEX IF EXISTS "SiteAcquiringFeeModel_siteId_effectiveFrom_idx";
DROP INDEX IF EXISTS "SiteAcquiringFeeModel_effectiveTo_idx";
DROP INDEX IF EXISTS "OwnerTaxPolicy_siteId_effectiveFrom_idx";
DROP INDEX IF EXISTS "OwnerTaxPolicy_effectiveTo_idx";
DROP INDEX IF EXISTS "VasePurchaseCost_productVariantId_costType_effectiveFrom_idx";
DROP INDEX IF EXISTS "VasePurchaseCost_productId_costType_effectiveFrom_idx";
DROP INDEX IF EXISTS "VasePurchaseCost_effectiveTo_idx";

-- ─────────────── 3. Удаление колонок ───────────────

ALTER TABLE "ConsumablesRate" DROP COLUMN "effectiveFrom", DROP COLUMN "effectiveTo";
ALTER TABLE "SiteAcquiringFeeModel" DROP COLUMN "effectiveFrom", DROP COLUMN "effectiveTo";
ALTER TABLE "OwnerTaxPolicy" DROP COLUMN "effectiveFrom", DROP COLUMN "effectiveTo";
ALTER TABLE "VasePurchaseCost" DROP COLUMN "effectiveFrom", DROP COLUMN "effectiveTo";

-- ─────────────── 4. Одна строка на область ───────────────
--
-- Частичные индексы, а не обычные уникальные: NULL (глобальная настройка, цель-товар
-- против цели-варианта) в обычном уникальном индексе не сравнивается сам с собой, и две
-- глобальные строки прошли бы проверку.

-- Имена ..._siteId_key ожидает Prisma по @@unique в схеме; обычный уникальный индекс
-- допускает несколько NULL, поэтому глобальную строку стережёт отдельный частичный.
CREATE UNIQUE INDEX "ConsumablesRate_siteId_key" ON "ConsumablesRate" ("siteId");
CREATE UNIQUE INDEX "ConsumablesRate_global_unique" ON "ConsumablesRate" ((1)) WHERE "siteId" IS NULL;

CREATE UNIQUE INDEX "SiteAcquiringFeeModel_siteId_key" ON "SiteAcquiringFeeModel" ("siteId");

CREATE UNIQUE INDEX "OwnerTaxPolicy_siteId_key" ON "OwnerTaxPolicy" ("siteId");
CREATE UNIQUE INDEX "OwnerTaxPolicy_global_unique" ON "OwnerTaxPolicy" ((1)) WHERE "siteId" IS NULL;

CREATE UNIQUE INDEX "VasePurchaseCost_variant_unique" ON "VasePurchaseCost" ("productVariantId", "costType") WHERE "productVariantId" IS NOT NULL;
CREATE UNIQUE INDEX "VasePurchaseCost_product_unique" ON "VasePurchaseCost" ("productId", "costType") WHERE "productId" IS NOT NULL;

CREATE INDEX "VasePurchaseCost_productVariantId_costType_idx" ON "VasePurchaseCost" ("productVariantId", "costType");
CREATE INDEX "VasePurchaseCost_productId_costType_idx" ON "VasePurchaseCost" ("productId", "costType");
