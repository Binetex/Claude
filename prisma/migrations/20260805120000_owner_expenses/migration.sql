-- Раздел «Мои расходы»: ежедневный журнал расходов бизнеса у владельца.

CREATE TABLE "OwnerExpenseCategory" (
  "id"           TEXT NOT NULL,
  "name"         TEXT NOT NULL,
  "isBuiltin"    BOOLEAN NOT NULL DEFAULT false,
  "sortOrder"    INTEGER NOT NULL DEFAULT 100,
  "archivedAt"   TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerExpenseCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerExpenseCategory_name_key" ON "OwnerExpenseCategory"("name");
CREATE INDEX "OwnerExpenseCategory_archivedAt_sortOrder_idx" ON "OwnerExpenseCategory"("archivedAt", "sortOrder");

CREATE TABLE "OwnerExpenseSubcategory" (
  "id"         TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "name"       TEXT NOT NULL,
  "sortOrder"  INTEGER NOT NULL DEFAULT 100,
  "archivedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OwnerExpenseSubcategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OwnerExpenseSubcategory_categoryId_name_key" ON "OwnerExpenseSubcategory"("categoryId", "name");
CREATE INDEX "OwnerExpenseSubcategory_categoryId_archivedAt_sortOrder_idx" ON "OwnerExpenseSubcategory"("categoryId", "archivedAt", "sortOrder");

ALTER TABLE "OwnerExpenseSubcategory"
  ADD CONSTRAINT "OwnerExpenseSubcategory_categoryId_fkey" FOREIGN KEY ("categoryId")
  REFERENCES "OwnerExpenseCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OwnerExpense" (
  "id"            TEXT NOT NULL,
  "categoryId"    TEXT NOT NULL,
  "subcategoryId" TEXT,
  "title"         TEXT,
  "amountCents"   INTEGER NOT NULL,
  "currency"      TEXT NOT NULL DEFAULT 'USD',
  "kind"          TEXT NOT NULL,
  "startDay"      TIMESTAMP(3) NOT NULL,
  "endDay"        TIMESTAMP(3),
  "createdBy"     TEXT NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"     TEXT,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnerExpense_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "OwnerExpense_startDay_idx" ON "OwnerExpense"("startDay");
CREATE INDEX "OwnerExpense_endDay_idx" ON "OwnerExpense"("endDay");
CREATE INDEX "OwnerExpense_categoryId_idx" ON "OwnerExpense"("categoryId");
CREATE INDEX "OwnerExpense_subcategoryId_idx" ON "OwnerExpense"("subcategoryId");

ALTER TABLE "OwnerExpense"
  ADD CONSTRAINT "OwnerExpense_categoryId_fkey" FOREIGN KEY ("categoryId")
  REFERENCES "OwnerExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OwnerExpense"
  ADD CONSTRAINT "OwnerExpense_subcategoryId_fkey" FOREIGN KEY ("subcategoryId")
  REFERENCES "OwnerExpenseSubcategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Сумма расхода неотрицательна: минус означал бы доход, а это другой раздел.
ALTER TABLE "OwnerExpense" ADD CONSTRAINT "OwnerExpense_amount_nonneg" CHECK ("amountCents" >= 0);
-- Срок не может кончаться раньше, чем начался.
ALTER TABLE "OwnerExpense" ADD CONSTRAINT "OwnerExpense_period_order" CHECK ("endDay" IS NULL OR "endDay" >= "startDay");

-- Стартовый набор категорий. Дальше владелец правит список сам.
INSERT INTO "OwnerExpenseCategory" ("id", "name", "isBuiltin", "sortOrder") VALUES
  ('oec_hosting',       'Хостинг',   true, 10),
  ('oec_domains',       'Домены',    true, 20),
  ('oec_marketing',     'Маркетинг', true, 30),
  ('oec_subscriptions', 'Подписки',  true, 40),
  ('oec_ads',           'Реклама',   true, 50),
  ('oec_telephony',     'Телефония', true, 60),
  ('oec_other',         'Прочее',    true, 70);
