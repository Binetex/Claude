-- Stage 3a: входные данные расчёта доли основного флориста, снимок заказа с ревизиями
-- и очередь Finance Setup Assistant.
--
-- ТОЛЬКО добавление. Существующие таблицы, колонки и данные не изменяются.
-- Миграция НИЧЕГО не начисляет и не создаёт ни одной настройки: всё вносит владелец
-- через ассистента, с предпросмотром и аудитом. Начисления PRIMARY на этом этапе
-- не создаются вовсе.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- AlterTable
-- У deliveryActualCost есть DEFAULT 0, поэтому «доставка бесплатна» неотличимо от
-- «стоимость неизвестна». Без этой отметки заказ с реально нулевой доставкой навсегда
-- застрял бы в очереди разбора. NULL = не подтверждена; существующие строки не меняются.
ALTER TABLE "Order" ADD COLUMN "deliveryActualCostConfirmedAt" TIMESTAMP(3);

-- CreateEnum
CREATE TYPE "AcquiringFeeSource" AS ENUM ('ACTUAL', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "FinanceIssueSeverity" AS ENUM ('BLOCKING', 'WARNING', 'INFO');

-- CreateEnum
CREATE TYPE "FinanceIssueStatus" AS ENUM ('OPEN', 'RESOLVED', 'AUTO_RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FinanceIssueType" AS ENUM ('DELIVERY_ACTUAL_COST_MISSING', 'ACQUIRING_FEE_MODEL_MISSING', 'DAILY_FLOWER_EXPENSE_MISSING', 'VASE_COST_MISSING', 'GIFT_COST_MISSING', 'VASE_LINK_MISSING', 'CONSUMABLES_RATE_MISSING', 'OWNER_TAX_POLICY_MISSING', 'FLOWER_REVENUE_UNDETERMINED');

-- CreateEnum
CREATE TYPE "FinanceActionType" AS ENUM ('SET_DELIVERY_ACTUAL_COST', 'CREATE_SITE_FEE_MODEL', 'SET_DAILY_FLOWER_EXPENSE', 'SET_VASE_PURCHASE_COST', 'LINK_VASE_VARIANT', 'SET_CONSUMABLES_RATE', 'SET_OWNER_TAX_POLICY', 'CLASSIFY_ORDER_ITEMS');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "DailyFlowerExpense" (
    "id" TEXT NOT NULL,
    "financeProfileId" TEXT NOT NULL,
    "expenseDay" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyFlowerExpense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumablesRate" (
    "id" TEXT NOT NULL,
    "siteId" TEXT,
    "amountCents" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumablesRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderConsumablesOverride" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderConsumablesOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteAcquiringFeeModel" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "percentBp" INTEGER NOT NULL,
    "fixedCents" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteAcquiringFeeModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAcquiringFee" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAcquiringFee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnerTaxPolicy" (
    "id" TEXT NOT NULL,
    "siteId" TEXT,
    "actualShareBp" INTEGER NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnerTaxPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderFinancialSnapshot" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'DRAFT',
    "isCalculable" BOOLEAN NOT NULL,
    "grossRevenueCents" INTEGER NOT NULL,
    "flowerRevenueCents" INTEGER NOT NULL,
    "taxCents" INTEGER NOT NULL,
    "deliveryActualCents" INTEGER NOT NULL,
    "acquiringFeeCents" INTEGER NOT NULL,
    "acquiringFeeSource" "AcquiringFeeSource" NOT NULL,
    "vaseGiftCostCents" INTEGER NOT NULL,
    "consumablesCents" INTEGER NOT NULL,
    "allocatedFlowerCents" INTEGER NOT NULL,
    "otherExpenseCents" INTEGER NOT NULL DEFAULT 0,
    "distributableCents" INTEGER NOT NULL,
    "calcInputJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "OrderFinancialSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinanceIssue" (
    "id" TEXT NOT NULL,
    "type" "FinanceIssueType" NOT NULL,
    "severity" "FinanceIssueSeverity" NOT NULL,
    "status" "FinanceIssueStatus" NOT NULL DEFAULT 'OPEN',
    "deduplicationKey" TEXT NOT NULL,
    "scopeDate" TIMESTAMP(3),
    "siteId" TEXT,
    "orderId" TEXT,
    "floristId" TEXT,
    "sourceEntity" TEXT NOT NULL,
    "sourceEntityId" TEXT NOT NULL,
    "suggestedActionType" "FinanceActionType" NOT NULL,
    "suggestedValueJson" JSONB,
    "detailJson" JSONB,
    "estimatedImpactCents" INTEGER,
    "firstDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastDetectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionComment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinanceIssue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyFlowerExpense_financeProfileId_expenseDay_key" ON "DailyFlowerExpense"("financeProfileId", "expenseDay");
CREATE INDEX "DailyFlowerExpense_expenseDay_idx" ON "DailyFlowerExpense"("expenseDay");

-- CreateIndex
CREATE INDEX "ConsumablesRate_siteId_effectiveFrom_idx" ON "ConsumablesRate"("siteId", "effectiveFrom");
CREATE INDEX "ConsumablesRate_effectiveTo_idx" ON "ConsumablesRate"("effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "OrderConsumablesOverride_orderId_key" ON "OrderConsumablesOverride"("orderId");

-- CreateIndex
CREATE INDEX "SiteAcquiringFeeModel_siteId_effectiveFrom_idx" ON "SiteAcquiringFeeModel"("siteId", "effectiveFrom");
CREATE INDEX "SiteAcquiringFeeModel_effectiveTo_idx" ON "SiteAcquiringFeeModel"("effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "OrderAcquiringFee_orderId_key" ON "OrderAcquiringFee"("orderId");

-- CreateIndex
CREATE INDEX "OwnerTaxPolicy_siteId_effectiveFrom_idx" ON "OwnerTaxPolicy"("siteId", "effectiveFrom");
CREATE INDEX "OwnerTaxPolicy_effectiveTo_idx" ON "OwnerTaxPolicy"("effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "OrderFinancialSnapshot_orderId_revision_key" ON "OrderFinancialSnapshot"("orderId", "revision");
CREATE INDEX "OrderFinancialSnapshot_orderId_revision_idx" ON "OrderFinancialSnapshot"("orderId", "revision");
CREATE INDEX "OrderFinancialSnapshot_orderId_status_idx" ON "OrderFinancialSnapshot"("orderId", "status");

-- Действующая ревизия у заказа ровно одна: «какой снимок сейчас применяется»
-- обязано иметь единственный ответ. Черновиков и вытесненных может быть много.
CREATE UNIQUE INDEX "OrderFinancialSnapshot_one_published"
    ON "OrderFinancialSnapshot"("orderId") WHERE ("status" = 'PUBLISHED');

-- CreateIndex
CREATE UNIQUE INDEX "FinanceIssue_deduplicationKey_key" ON "FinanceIssue"("deduplicationKey");
CREATE INDEX "FinanceIssue_status_severity_scopeDate_idx" ON "FinanceIssue"("status", "severity", "scopeDate");
CREATE INDEX "FinanceIssue_status_siteId_idx" ON "FinanceIssue"("status", "siteId");
CREATE INDEX "FinanceIssue_status_type_idx" ON "FinanceIssue"("status", "type");
CREATE INDEX "FinanceIssue_orderId_idx" ON "FinanceIssue"("orderId");

-- AddForeignKey
ALTER TABLE "DailyFlowerExpense" ADD CONSTRAINT "DailyFlowerExpense_financeProfileId_fkey" FOREIGN KEY ("financeProfileId") REFERENCES "FloristFinanceProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ConsumablesRate" ADD CONSTRAINT "ConsumablesRate_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderConsumablesOverride" ADD CONSTRAINT "OrderConsumablesOverride_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SiteAcquiringFeeModel" ADD CONSTRAINT "SiteAcquiringFeeModel_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderAcquiringFee" ADD CONSTRAINT "OrderAcquiringFee_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerTaxPolicy" ADD CONSTRAINT "OwnerTaxPolicy_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderFinancialSnapshot" ADD CONSTRAINT "OrderFinancialSnapshot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceIssue" ADD CONSTRAINT "FinanceIssue_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceIssue" ADD CONSTRAINT "FinanceIssue_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FinanceIssue" ADD CONSTRAINT "FinanceIssue_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────── Целостность сумм и периодов ───────────────────

-- 1. Расходы не бывают отрицательными. Ноль — подтверждённое «расхода нет»;
--    «неизвестно» выражается ОТСУТСТВИЕМ строки, а не нулём.
ALTER TABLE "DailyFlowerExpense" ADD CONSTRAINT "DFE_amount_non_negative" CHECK ("amountCents" >= 0);
ALTER TABLE "ConsumablesRate" ADD CONSTRAINT "CR_amount_non_negative" CHECK ("amountCents" >= 0);
ALTER TABLE "OrderConsumablesOverride" ADD CONSTRAINT "OCO_amount_non_negative" CHECK ("amountCents" >= 0);
ALTER TABLE "OrderAcquiringFee" ADD CONSTRAINT "OAF_fee_non_negative" CHECK ("feeCents" >= 0);
ALTER TABLE "SiteAcquiringFeeModel" ADD CONSTRAINT "SAFM_fixed_non_negative" CHECK ("fixedCents" >= 0);

-- 2. Проценты — в базисных пунктах, 0..10000 (2.9% = 290, 20% = 2000).
ALTER TABLE "SiteAcquiringFeeModel" ADD CONSTRAINT "SAFM_percent_range" CHECK ("percentBp" BETWEEN 0 AND 10000);
ALTER TABLE "OwnerTaxPolicy" ADD CONSTRAINT "OTP_share_range" CHECK ("actualShareBp" BETWEEN 0 AND 10000);

-- 3. Период действия не может быть пустым или обратным.
ALTER TABLE "ConsumablesRate" ADD CONSTRAINT "CR_period_valid" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "SiteAcquiringFeeModel" ADD CONSTRAINT "SAFM_period_valid" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");
ALTER TABLE "OwnerTaxPolicy" ADD CONSTRAINT "OTP_period_valid" CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- 4. Ревизия снимка нумеруется с единицы.
ALTER TABLE "OrderFinancialSnapshot" ADD CONSTRAINT "OFS_revision_positive" CHECK ("revision" >= 1);

-- 5. Суммы снимка неотрицательны. distributableCents ИСКЛЮЧЕНИЕ: заказ может уйти
--    в минус (расходы больше выручки), и прятать это нельзя — max(0, …) применяется
--    к сумме дня при начислении, а не к отдельному заказу.
ALTER TABLE "OrderFinancialSnapshot" ADD CONSTRAINT "OFS_amounts_non_negative" CHECK (
    "grossRevenueCents" >= 0 AND "flowerRevenueCents" >= 0 AND "taxCents" >= 0
    AND "deliveryActualCents" >= 0 AND "acquiringFeeCents" >= 0 AND "vaseGiftCostCents" >= 0
    AND "consumablesCents" >= 0 AND "allocatedFlowerCents" >= 0 AND "otherExpenseCents" >= 0
);

-- 6. У непросчитываемого заказа распределяемая прибыль обязана быть нулевой:
--    иначе в отчёт попала бы сумма, которой заказ не заработал.
--    Зарезервированная доля закупки при этом сохраняется — это и есть
--    «нераспределённый остаток» дня.
ALTER TABLE "OrderFinancialSnapshot" ADD CONSTRAINT "OFS_uncalculable_is_zero"
    CHECK ("isCalculable" OR "distributableCents" = 0);

-- 7. Разбор проставляется целиком, а не наполовину: закрытая проблема обязана
--    знать, кто и когда её закрыл, а открытая — не иметь этих полей.
ALTER TABLE "FinanceIssue" ADD CONSTRAINT "FI_resolution_complete" CHECK (
    ("status" IN ('OPEN') AND "resolvedAt" IS NULL AND "resolvedBy" IS NULL)
    OR ("status" = 'AUTO_RESOLVED' AND "resolvedAt" IS NOT NULL)
    OR ("status" IN ('RESOLVED', 'DISMISSED') AND "resolvedAt" IS NOT NULL AND "resolvedBy" IS NOT NULL)
);

-- ─────────────── Непересекающиеся периоды настроек ───────────────
--
-- Тот же приём, что у VasePurchaseCost и FloristFinanceProfile: две действующие
-- настройки на одну дату сделали бы вопрос «какая ставка применялась» без ответа.
-- COALESCE(siteId, '') нужен потому, что NULL (глобальная настройка) в EXCLUDE не
-- сравнивается сам с собой и две глобальные строки прошли бы проверку.

ALTER TABLE "ConsumablesRate"
    ADD CONSTRAINT "CR_no_overlap"
    EXCLUDE USING gist (
        COALESCE("siteId", '') WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    );

ALTER TABLE "SiteAcquiringFeeModel"
    ADD CONSTRAINT "SAFM_no_overlap"
    EXCLUDE USING gist (
        "siteId" WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    );

ALTER TABLE "OwnerTaxPolicy"
    ADD CONSTRAINT "OTP_no_overlap"
    EXCLUDE USING gist (
        COALESCE("siteId", '') WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    );

-- ─────────────── Снимок: жизненный цикл ревизии ───────────────
--
-- DRAFT — черновик пересчёта: изменяем и удаляем свободно, начислением не используется.
-- PUBLISHED и SUPERSEDED — неизменяемы и неудаляемы: ревизия, по которой начислена доля,
-- обязана объяснять её и через год.
--
-- Единственное исключение — переход PUBLISHED → SUPERSEDED при публикации следующей
-- ревизии. Он разрешён РОВНО в этом виде: любое изменение сумм, входа или номера
-- ревизии заодно с ним отклоняется. Без такого исключения вытеснить прежнюю ревизию
-- было бы физически нечем.

CREATE OR REPLACE FUNCTION "order_financial_snapshot_guard"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD."status" = 'DRAFT' THEN
            RETURN OLD;
        END IF;
        RAISE EXCEPTION
            'OrderFinancialSnapshot revision % of order % is % and cannot be deleted.',
            OLD."revision", OLD."orderId", OLD."status"
            USING ERRCODE = 'restrict_violation';
    END IF;

    -- Черновик — рабочая копия, правится как угодно.
    IF OLD."status" = 'DRAFT' THEN
        RETURN NEW;
    END IF;

    -- Единственный разрешённый переход: вытеснение без изменения содержимого.
    IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'SUPERSEDED'
       AND NEW."orderId" = OLD."orderId"
       AND NEW."revision" = OLD."revision"
       AND NEW."isCalculable" = OLD."isCalculable"
       AND NEW."grossRevenueCents" = OLD."grossRevenueCents"
       AND NEW."flowerRevenueCents" = OLD."flowerRevenueCents"
       AND NEW."taxCents" = OLD."taxCents"
       AND NEW."deliveryActualCents" = OLD."deliveryActualCents"
       AND NEW."acquiringFeeCents" = OLD."acquiringFeeCents"
       AND NEW."acquiringFeeSource" = OLD."acquiringFeeSource"
       AND NEW."vaseGiftCostCents" = OLD."vaseGiftCostCents"
       AND NEW."consumablesCents" = OLD."consumablesCents"
       AND NEW."allocatedFlowerCents" = OLD."allocatedFlowerCents"
       AND NEW."otherExpenseCents" = OLD."otherExpenseCents"
       AND NEW."distributableCents" = OLD."distributableCents"
       AND NEW."calcInputJson"::text = OLD."calcInputJson"::text
       AND NEW."createdAt" = OLD."createdAt"
       AND NEW."createdBy" = OLD."createdBy"
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION
        'OrderFinancialSnapshot revision % of order % is %: only PUBLISHED→SUPERSEDED is allowed.',
        OLD."revision", OLD."orderId", OLD."status"
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "OrderFinancialSnapshot_guard_update"
    BEFORE UPDATE ON "OrderFinancialSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "order_financial_snapshot_guard"();

CREATE TRIGGER "OrderFinancialSnapshot_guard_delete"
    BEFORE DELETE ON "OrderFinancialSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "order_financial_snapshot_guard"();
