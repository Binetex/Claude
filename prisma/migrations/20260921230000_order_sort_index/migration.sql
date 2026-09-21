-- Ручной порядок заказов внутри дня доставки: 0 — делать первым, NULL — ещё не расставляли.
ALTER TABLE "Order" ADD COLUMN "sortIndex" INTEGER;
CREATE INDEX "Order_deliveryDate_sortIndex_idx" ON "Order"("deliveryDate", "sortIndex");
