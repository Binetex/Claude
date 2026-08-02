-- Stage 3b: связь начисления с ревизиями снимков, из которых оно собрано.
--
-- Только добавление. Существующие таблицы и данные не изменяются, начислений миграция
-- не создаёт.
--
-- Связь многие-ко-многим, а не колонка на LedgerEntry: дневная доля основного флориста
-- собирается из снимков ВСЕХ его заказов этого дня, и один-к-одному тут неверно.
-- Ссылка идёт на конкретную РЕВИЗИЮ, а не на заказ: ревизия неизменяема, а действующий
-- снимок заказа со временем станет другим — и объяснение расчёта разъехалось бы.

-- CreateTable
CREATE TABLE "LedgerEntrySnapshot" (
    "id" TEXT NOT NULL,
    "ledgerEntryId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,

    CONSTRAINT "LedgerEntrySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntrySnapshot_ledgerEntryId_snapshotId_key" ON "LedgerEntrySnapshot"("ledgerEntryId", "snapshotId");
CREATE INDEX "LedgerEntrySnapshot_snapshotId_idx" ON "LedgerEntrySnapshot"("snapshotId");

-- AddForeignKey
-- RESTRICT с обеих сторон: ни начисление, ни ревизия, объясняющая деньги, не должны
-- исчезать из-за каскада.
ALTER TABLE "LedgerEntrySnapshot" ADD CONSTRAINT "LedgerEntrySnapshot_ledgerEntryId_fkey" FOREIGN KEY ("ledgerEntryId") REFERENCES "LedgerEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntrySnapshot" ADD CONSTRAINT "LedgerEntrySnapshot_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "OrderFinancialSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
