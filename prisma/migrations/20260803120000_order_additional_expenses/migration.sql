-- Дополнительные расходы по заказу.
--
-- Новых enum-значений нет: удержание оформляется существующим типом DEDUCTION, а отмена —
-- существующим CORRECTION. Ничего в уже работающем расчёте не переопределяется: PRIMARY
-- получает сумму через уже существующее поле otherExpenseCents снимка.

CREATE TABLE "OrderAdditionalExpense" (
    "id"                TEXT NOT NULL,
    "orderId"           TEXT NOT NULL,
    "amountCents"       INTEGER NOT NULL,
    "description"       TEXT NOT NULL,
    "expenseDate"       TIMESTAMP(3) NOT NULL,
    "floristIdSnapshot" TEXT NOT NULL,
    "createdBy"         TEXT NOT NULL,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedBy"         TEXT,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    "reversedAt"        TIMESTAMP(3),
    "reversedBy"        TEXT,
    "reversalReason"    TEXT,

    CONSTRAINT "OrderAdditionalExpense_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OrderAdditionalExpense_orderId_idx" ON "OrderAdditionalExpense"("orderId");
CREATE INDEX "OrderAdditionalExpense_floristIdSnapshot_reversedAt_idx"
    ON "OrderAdditionalExpense"("floristIdSnapshot", "reversedAt");

ALTER TABLE "OrderAdditionalExpense"
    ADD CONSTRAINT "OrderAdditionalExpense_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderAdditionalExpense"
    ADD CONSTRAINT "OrderAdditionalExpense_floristIdSnapshot_fkey"
    FOREIGN KEY ("floristIdSnapshot") REFERENCES "Florist"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ноль и отрицательная сумма расхода бессмысленны: «расхода не было» выражается
-- отсутствием строки, а не нулём.
ALTER TABLE "OrderAdditionalExpense"
    ADD CONSTRAINT "OAE_amount_positive" CHECK ("amountCents" > 0);

-- Отмена — это три поля разом. Половина заполненных полей означала бы, что неизвестно,
-- отменён расход или нет.
ALTER TABLE "OrderAdditionalExpense"
    ADD CONSTRAINT "OAE_reversal_complete" CHECK (
        ("reversedAt" IS NULL AND "reversedBy" IS NULL)
        OR ("reversedAt" IS NOT NULL AND "reversedBy" IS NOT NULL)
    );
