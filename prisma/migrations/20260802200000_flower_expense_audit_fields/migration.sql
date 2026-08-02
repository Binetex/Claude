-- Кто и когда правил дневную закупку.
--
-- У существующих строк updatedAt = createdAt, а updatedBy остаётся NULL: это честно —
-- они с момента создания не менялись, и приписывать им редактора было бы выдумкой.

ALTER TABLE "DailyFlowerExpense" ADD COLUMN "updatedBy" TEXT;
ALTER TABLE "DailyFlowerExpense" ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "DailyFlowerExpense" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

ALTER TABLE "DailyFlowerExpense" ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE INDEX "DailyFlowerExpense_financeProfileId_expenseDay_idx"
    ON "DailyFlowerExpense"("financeProfileId", "expenseDay");
