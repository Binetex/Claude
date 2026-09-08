-- Дополнительные QUO-номера магазина. Аддитивно: новая таблица, существующие поля Site не трогаем.
CREATE TABLE "SiteQuoNumber" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "quoPhoneNumberId" TEXT NOT NULL,
    "quoPhoneNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteQuoNumber_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SiteQuoNumber_quoPhoneNumberId_key" ON "SiteQuoNumber"("quoPhoneNumberId");
CREATE INDEX "SiteQuoNumber_siteId_idx" ON "SiteQuoNumber"("siteId");

ALTER TABLE "SiteQuoNumber" ADD CONSTRAINT "SiteQuoNumber_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
