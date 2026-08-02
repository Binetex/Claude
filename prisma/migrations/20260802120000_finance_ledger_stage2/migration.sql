-- Stage 2: append-only ledger начислений и выплат флористам + финансовый профиль.
--
-- ТОЛЬКО добавление. Существующие таблицы, колонки и данные не изменяются.
-- Миграция НИЧЕГО не начисляет и не создаёт ни одного профиля: наполнение — отдельным
-- скриптом с dry-run и подтверждением владельца.
--
-- Ограничения, которые Prisma выразить не может (CHECK, EXCLUDE, триггеры), заданы ниже
-- вручную — как это уже сделано в 20260801120000_catalog_finance_classification.

-- btree_gist уже установлен миграцией каталога; повторный вызов безопасен и нужен, чтобы
-- миграция была самодостаточной при накатке на чистую БД.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- CreateEnum
CREATE TYPE "FinanceModel" AS ENUM ('PRIMARY', 'SECONDARY');

-- CreateEnum
CREATE TYPE "FinanceScope" AS ENUM ('ALL_SITES', 'SELECTED_SITES');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('ORDER_ACCRUAL', 'PRIMARY_FLORIST_SHARE', 'BONUS', 'DEDUCTION', 'PAYMENT', 'PAYMENT_REVERSAL', 'MANUAL_ADJUSTMENT', 'CORRECTION');

-- CreateEnum
CREATE TYPE "LedgerDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "orderId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "direction" "LedgerDirection" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "description" TEXT NOT NULL,
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdByRole" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT,
    "sourceVersion" INTEGER NOT NULL DEFAULT 1,
    "idempotencyKey" TEXT NOT NULL,
    "reversedEntryId" TEXT,
    "metadata" JSONB,
    "floristNameSnapshot" TEXT NOT NULL,
    "orderNumberSnapshot" TEXT,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloristFinanceProfile" (
    "id" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "model" "FinanceModel" NOT NULL,
    "sharePercentBp" INTEGER,
    "scope" "FinanceScope" NOT NULL DEFAULT 'ALL_SITES',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "comment" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FloristFinanceProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloristFinanceProfileSite" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,

    CONSTRAINT "FloristFinanceProfileSite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_reversedEntryId_key" ON "LedgerEntry"("reversedEntryId");

-- CreateIndex
CREATE INDEX "LedgerEntry_floristId_effectiveDate_idx" ON "LedgerEntry"("floristId", "effectiveDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_floristId_type_effectiveDate_idx" ON "LedgerEntry"("floristId", "type", "effectiveDate");

-- CreateIndex
CREATE INDEX "LedgerEntry_orderId_idx" ON "LedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "LedgerEntry_createdAt_idx" ON "LedgerEntry"("createdAt");

-- CreateIndex
CREATE INDEX "FloristFinanceProfile_floristId_effectiveFrom_idx" ON "FloristFinanceProfile"("floristId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "FloristFinanceProfile_effectiveTo_idx" ON "FloristFinanceProfile"("effectiveTo");

-- CreateIndex
CREATE UNIQUE INDEX "FloristFinanceProfileSite_profileId_siteId_key" ON "FloristFinanceProfileSite"("profileId", "siteId");

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_reversedEntryId_fkey" FOREIGN KEY ("reversedEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristFinanceProfile" ADD CONSTRAINT "FloristFinanceProfile_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristFinanceProfileSite" ADD CONSTRAINT "FloristFinanceProfileSite_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "FloristFinanceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristFinanceProfileSite" ADD CONSTRAINT "FloristFinanceProfileSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─────────────────── Ограничения целостности ledger (raw SQL) ───────────────────

-- 1. Сумма не бывает отрицательной. Ноль — ПОДТВЕРЖДЁННОЕ «за этот заказ не платим»;
--    «не решено» выражается отсутствием записи, а не нулём. Знак операции живёт
--    в direction, поэтому отрицательных сумм в книге не существует в принципе.
ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_amount_non_negative"
    CHECK ("amountCents" >= 0);

-- 2. Тип операции жёстко задаёт направление там, где выбора нет. Начисление не может
--    уменьшать долг, а выплата — увеличивать. Свобода оставлена только двум ручным типам.
ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_type_direction"
    CHECK (
        ("type" IN ('ORDER_ACCRUAL', 'PRIMARY_FLORIST_SHARE', 'BONUS', 'PAYMENT_REVERSAL')
             AND "direction" = 'CREDIT')
        OR ("type" IN ('DEDUCTION', 'PAYMENT') AND "direction" = 'DEBIT')
        OR ("type" IN ('MANUAL_ADJUSTMENT', 'CORRECTION'))
    );

-- 3. Сторнировать умеют только два типа. PAYMENT_REVERSAL — отмена выплаты,
--    CORRECTION — исправление всего остального.
ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_reversal_type"
    CHECK ("reversedEntryId" IS NULL OR "type" IN ('PAYMENT_REVERSAL', 'CORRECTION'));

-- 4. Запись не может сторнировать саму себя.
ALTER TABLE "LedgerEntry"
    ADD CONSTRAINT "LedgerEntry_reversal_not_self"
    CHECK ("reversedEntryId" IS NULL OR "reversedEntryId" <> "id");

-- ─────────────────── Append-only: физический запрет правки ───────────────────
--
-- Не «строгая защита в коде», а запрет на уровне БД: Prisma, ad-hoc скрипт и psql
-- получают одну и ту же ошибку. Именно поэтому у LedgerEntry нет колонки updatedAt —
-- обновить строку нельзя ничем.
--
-- Побочное следствие, которое надо помнить: каскадное удаление флориста или заказа
-- тоже упрётся в этот триггер, но раньше сработает ON DELETE RESTRICT на внешних ключах.

CREATE OR REPLACE FUNCTION "ledger_entry_immutable"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'LedgerEntry is append-only: % denied (id=%). Correct it with a reversal/correction row.',
        TG_OP, COALESCE(OLD."id", '?')
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerEntry_no_update"
    BEFORE UPDATE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "ledger_entry_immutable"();

CREATE TRIGGER "LedgerEntry_no_delete"
    BEFORE DELETE ON "LedgerEntry"
    FOR EACH ROW EXECUTE FUNCTION "ledger_entry_immutable"();

-- ─────────────────── Ограничения финансового профиля ───────────────────

-- 5. Доля бывает только у основного флориста. У SECONDARY процент — бессмыслица,
--    и молча хранить его нельзя: следующий этап начнёт по нему считать.
ALTER TABLE "FloristFinanceProfile"
    ADD CONSTRAINT "FFP_share_only_primary"
    CHECK ("model" = 'PRIMARY' OR "sharePercentBp" IS NULL);

-- 6. Доля в базисных пунктах: 0..10000 (66.6% = 6660).
ALTER TABLE "FloristFinanceProfile"
    ADD CONSTRAINT "FFP_share_range"
    CHECK ("sharePercentBp" IS NULL OR ("sharePercentBp" BETWEEN 0 AND 10000));

-- 7. Период действия не может быть пустым или обратным.
ALTER TABLE "FloristFinanceProfile"
    ADD CONSTRAINT "FFP_period_valid"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

-- 8. У одного флориста не может быть двух ДЕЙСТВУЮЩИХ профилей на пересекающиеся даты:
--    иначе «какая модель оплаты сейчас» перестаёт иметь однозначный ответ. Полуинтервал
--    '[)' — конец предыдущего периода совпадает с началом следующего.
ALTER TABLE "FloristFinanceProfile"
    ADD CONSTRAINT "FFP_no_overlap"
    EXCLUDE USING gist (
        "floristId" WITH =,
        tsrange("effectiveFrom", COALESCE("effectiveTo", 'infinity'::timestamp), '[)') WITH &&
    ) WHERE ("active");
