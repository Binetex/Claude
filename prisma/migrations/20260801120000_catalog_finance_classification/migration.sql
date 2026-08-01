-- Финансовая классификация каталога и закупочная стоимость ваз.
--
-- Только добавление: существующие данные не изменяются и не переносятся.
-- Значений по умолчанию, меняющих смысл имеющихся строк, нет: все новые поля NULL,
-- а NULL здесь означает «не задано / наследовать», а не «ложь» и не «ноль».
--
-- Ограничения целостности, которые Prisma выразить не может (CHECK и EXCLUDE),
-- заданы ниже вручную.

-- Требуется для exclusion-constraint по (скаляр, диапазон): даёт GiST-операторы
-- сравнения для обычных типов, включая enum.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "FinancialItemType" AS ENUM ('FLOWER_PRODUCT', 'VASE', 'TIP', 'DELIVERY', 'TAX', 'SERVICE_FEE', 'DISCOUNT', 'CARD', 'GIFT', 'OTHER');

-- CreateEnum
CREATE TYPE "VaseCostType" AS ENUM ('STANDALONE_VASE', 'INCLUDED_VASE');

-- AlterTable
ALTER TABLE "Product"
    ADD COLUMN "financialType" "FinancialItemType",
    ADD COLUMN "defaultIncludesVase" BOOLEAN;

-- AlterTable
ALTER TABLE "ProductVariant"
    ADD COLUMN "financialType" "FinancialItemType",
    ADD COLUMN "includesVase" BOOLEAN,
    ADD COLUMN "financialTypeSetBy" TEXT,
    ADD COLUMN "financialTypeSetAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "VasePurchaseCost" (
    "id" TEXT NOT NULL,
    "productId" TEXT,
    "productVariantId" TEXT,
    "costType" "VaseCostType" NOT NULL,
    "purchaseCostCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "VasePurchaseCost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceAudit" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "beforeJson" JSONB,
    "afterJson" JSONB,
    "reason" TEXT,
    "batchId" TEXT,
    "entityNameSnapshot" TEXT,
    "siteShortNameSnapshot" TEXT,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Product_financialType_idx" ON "Product"("financialType");

-- CreateIndex
CREATE INDEX "ProductVariant_financialType_idx" ON "ProductVariant"("financialType");

-- CreateIndex
CREATE INDEX "ProductVariant_includesVase_idx" ON "ProductVariant"("includesVase");

-- CreateIndex
CREATE INDEX "VasePurchaseCost_productVariantId_costType_effectiveFrom_idx" ON "VasePurchaseCost"("productVariantId", "costType", "effectiveFrom");

-- CreateIndex
CREATE INDEX "VasePurchaseCost_productId_costType_effectiveFrom_idx" ON "VasePurchaseCost"("productId", "costType", "effectiveFrom");

-- CreateIndex
CREATE INDEX "VasePurchaseCost_effectiveTo_idx" ON "VasePurchaseCost"("effectiveTo");

-- CreateIndex
CREATE INDEX "FinanceAudit_entity_entityId_createdAt_idx" ON "FinanceAudit"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "FinanceAudit_batchId_idx" ON "FinanceAudit"("batchId");

-- CreateIndex
CREATE INDEX "FinanceAudit_userId_createdAt_idx" ON "FinanceAudit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "VasePurchaseCost" ADD CONSTRAINT "VasePurchaseCost_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VasePurchaseCost" ADD CONSTRAINT "VasePurchaseCost_productVariantId_fkey" FOREIGN KEY ("productVariantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinanceAudit" ADD CONSTRAINT "FinanceAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────────── Ограничения целостности (raw SQL) ───────────────────────

-- 1. Ровно одна цель стоимости: либо товар, либо вариант, но не оба и не ни один.
ALTER TABLE "VasePurchaseCost"
    ADD CONSTRAINT "VasePurchaseCost_single_target"
    CHECK (("productId" IS NOT NULL) <> ("productVariantId" IS NOT NULL));

-- 2. Себестоимость не бывает отрицательной. 0 — валидное подтверждённое значение;
--    «неизвестно» выражается ОТСУТСТВИЕМ строки, а не нулём и не NULL в этой колонке.
ALTER TABLE "VasePurchaseCost"
    ADD CONSTRAINT "VasePurchaseCost_cost_non_negative"
    CHECK ("purchaseCostCents" >= 0);

-- 3. Период действия не может быть пустым или обратным.
ALTER TABLE "VasePurchaseCost"
    ADD CONSTRAINT "VasePurchaseCost_period_valid"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- 4. Запрет пересекающихся интервалов для одной цели и одного costType.
--    Открытый интервал (effectiveTo IS NULL) трактуется как «до бесконечности»,
--    поэтому вторая открытая строка по той же цели физически невозможна.
--    Полуинтервал '[)': конец предыдущего периода может совпадать с началом следующего.
ALTER TABLE "VasePurchaseCost"
    ADD CONSTRAINT "VasePurchaseCost_no_overlap_variant"
    EXCLUDE USING gist (
        "productVariantId" WITH =,
        "costType" WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    ) WHERE ("productVariantId" IS NOT NULL);

ALTER TABLE "VasePurchaseCost"
    ADD CONSTRAINT "VasePurchaseCost_no_overlap_product"
    EXCLUDE USING gist (
        "productId" WITH =,
        "costType" WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    ) WHERE ("productId" IS NOT NULL);
