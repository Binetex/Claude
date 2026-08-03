-- Финансовый итог дня основного флориста.
--
-- Только СОЗДАНИЕ таблицы. Старые позаказные снимки пока не трогаются: они уйдут
-- отдельной миграцией, когда расчёт и экраны переедут сюда целиком. Так на каждом шаге
-- система остаётся рабочей.
--
-- Ревизий и статусов здесь нет: строка одна на день и изменяемая. Замораживаются деньги,
-- а не расчёт, — цифры копируются в запись книги в момент начисления.

CREATE TABLE "DayFinance" (
    "id"                  TEXT NOT NULL,
    "financeProfileId"    TEXT NOT NULL,
    "day"                 TIMESTAMP(3) NOT NULL,
    "complete"            BOOLEAN NOT NULL,
    "blockers"            TEXT[],
    "ordersTotal"         INTEGER NOT NULL,
    "grossRevenueCents"   INTEGER NOT NULL,
    "tipsCents"           INTEGER NOT NULL,
    "taxCents"            INTEGER NOT NULL,
    "deliveryCents"       INTEGER NOT NULL,
    "acquiringFeeCents"   INTEGER NOT NULL,
    "vaseGiftCostCents"   INTEGER NOT NULL,
    "consumablesCents"    INTEGER NOT NULL,
    "flowerPurchaseCents" INTEGER NOT NULL,
    "additionalCents"     INTEGER NOT NULL,
    "distributableCents"  INTEGER NOT NULL,
    "ordersJson"          JSONB NOT NULL,
    "updatedBy"           TEXT NOT NULL,
    "updatedAt"           TIMESTAMP(3) NOT NULL,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DayFinance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DayFinance_financeProfileId_day_key" ON "DayFinance"("financeProfileId", "day");
CREATE INDEX "DayFinance_day_idx" ON "DayFinance"("day");

ALTER TABLE "DayFinance"
    ADD CONSTRAINT "DayFinance_financeProfileId_fkey"
    FOREIGN KEY ("financeProfileId") REFERENCES "FloristFinanceProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Незаполненный день не имеет распределяемой прибыли: показывать частичную сумму значит
-- обещать деньги, которых начисление не создаст.
ALTER TABLE "DayFinance"
    ADD CONSTRAINT "DF_incomplete_has_no_profit"
    CHECK ("complete" OR "distributableCents" = 0);
