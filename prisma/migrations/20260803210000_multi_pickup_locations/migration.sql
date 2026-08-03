-- Несколько точек забора у флориста.
--
-- Было: FloristPickupLocation 1:1 Florist (unique floristId). Стало: список точек, ровно одна
-- основная (isPrimary). У заказа появляется ручное переопределение точки — Order.pickupLocationOverrideId.

-- AlterTable: флаг основной точки.
ALTER TABLE "FloristPickupLocation" ADD COLUMN "isPrimary" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: до этой миграции у флориста была ровно одна точка — она и становится основной.
UPDATE "FloristPickupLocation" SET "isPrimary" = true;

-- DropIndex: floristId больше не уникален (у флориста несколько точек).
DROP INDEX "FloristPickupLocation_floristId_key";

-- CreateIndex
CREATE INDEX "FloristPickupLocation_floristId_idx" ON "FloristPickupLocation"("floristId");

-- Partial unique index: не более одной основной точки (isPrimary=true) на флориста.
-- Prisma-схемой partial unique не выражается — задаём напрямую здесь.
CREATE UNIQUE INDEX "FloristPickupLocation_floristId_primary_key" ON "FloristPickupLocation" ("floristId") WHERE "isPrimary" = true;

-- AlterTable: ручной выбор точки забора в конкретном заказе (null = основная точка флориста).
ALTER TABLE "Order" ADD COLUMN "pickupLocationOverrideId" TEXT;

-- AddForeignKey: точку не удаляем, а деактивируем; SET NULL — страховка на случай удаления.
ALTER TABLE "Order" ADD CONSTRAINT "Order_pickupLocationOverrideId_fkey" FOREIGN KEY ("pickupLocationOverrideId") REFERENCES "FloristPickupLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
