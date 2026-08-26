-- Точки магазина на картах Google: где клиент оставляет отзыв.
CREATE TABLE "GoogleLocation" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "googleLocationId" TEXT,
    "reviewUrl" TEXT NOT NULL,
    "zips" TEXT[],
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastScanAt" TIMESTAMP(3),
    "lastScanErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GoogleLocation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GoogleLocation_siteId_idx" ON "GoogleLocation"("siteId");

ALTER TABLE "GoogleLocation" ADD CONSTRAINT "GoogleLocation_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Запасная точка у магазина ровно одна. Проверка в коде рано или поздно разойдётся с базой:
-- две запасные точки означали бы, что заказу с неизвестным ZIP достаётся случайная ссылка.
CREATE UNIQUE INDEX "GoogleLocation_one_default_per_site"
    ON "GoogleLocation"("siteId") WHERE "isDefault";
