-- Раздел «Расходники»: справочник позиций, ручной расход по заказу и приход на склад.
-- Аддитивно: три новые таблицы, существующие не меняются.

CREATE TABLE "ConsumableItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "siteId" TEXT,
    "autoRule" TEXT,
    "autoKey" TEXT,
    "archivedAt" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsumableItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsumableItem_archivedAt_sortOrder_idx" ON "ConsumableItem"("archivedAt", "sortOrder");

CREATE TABLE "ConsumableUsage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "updatedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConsumableUsage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ConsumableUsage_orderId_itemId_key" ON "ConsumableUsage"("orderId", "itemId");
CREATE INDEX "ConsumableUsage_itemId_idx" ON "ConsumableUsage"("itemId");
ALTER TABLE "ConsumableUsage" ADD CONSTRAINT "ConsumableUsage_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConsumableUsage" ADD CONSTRAINT "ConsumableUsage_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "ConsumableItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConsumableReceipt" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "day" TIMESTAMP(3) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsumableReceipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ConsumableReceipt_itemId_day_idx" ON "ConsumableReceipt"("itemId", "day");
CREATE INDEX "ConsumableReceipt_day_idx" ON "ConsumableReceipt"("day");
ALTER TABLE "ConsumableReceipt" ADD CONSTRAINT "ConsumableReceipt_itemId_fkey"
    FOREIGN KEY ("itemId") REFERENCES "ConsumableItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
