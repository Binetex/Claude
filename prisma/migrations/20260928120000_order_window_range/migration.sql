-- Окно доставки строго «с — до» (минуты от полуночи по часам магазина) и начало работы флориста.
-- Только добавляет: старый код про новые колонки не знает и продолжает работать с текстом окна.
ALTER TABLE "Order" ADD COLUMN "windowFrom" INTEGER;
ALTER TABLE "Order" ADD COLUMN "windowTo" INTEGER;
ALTER TABLE "Florist" ADD COLUMN "workStartMin" INTEGER;
