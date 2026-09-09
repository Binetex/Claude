-- Предварительная проверка курьеров переезжает с Delivery на Order: она идёт до создания
-- черновика, когда строки Delivery ещё нет. Аддитивно; старые значения на Delivery остаются.
ALTER TABLE "Order" ADD COLUMN "couriersCheckedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "couriersAvailable" INTEGER;
