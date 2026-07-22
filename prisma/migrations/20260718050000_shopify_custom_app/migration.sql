-- CreateEnum
CREATE TYPE "ShopifyAuthMode" AS ENUM ('CUSTOM_APP');

-- CreateEnum
CREATE TYPE "ShopifyConnStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'DISCONNECTED');

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "accessTokenEncrypted" TEXT,
ADD COLUMN     "accessTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "accessTokenMask" TEXT,
ADD COLUMN     "apiVersion" TEXT,
ADD COLUMN     "authMode" "ShopifyAuthMode",
ADD COLUMN     "clientIdEncrypted" TEXT,
ADD COLUMN     "clientSecretEncrypted" TEXT,
ADD COLUMN     "clientSecretMask" TEXT,
ADD COLUMN     "connectionError" TEXT,
ADD COLUMN     "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "lastConnectionCheckAt" TIMESTAMP(3),
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "normalizedShopDomain" TEXT,
ADD COLUMN     "previousClientSecretEncrypted" TEXT,
ADD COLUMN     "previousSecretValidUntil" TIMESTAMP(3),
ADD COLUMN     "shopifyConnStatus" "ShopifyConnStatus";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "lastSeenSyncRunId" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "lastSeenSyncRunId" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "externalUpdatedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ShopifyWebhook" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyWebhookId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShopifyWebhook_siteId_idx" ON "ShopifyWebhook"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyWebhook_siteId_topic_key" ON "ShopifyWebhook"("siteId", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "Site_platform_normalizedShopDomain_key" ON "Site"("platform", "normalizedShopDomain");

-- AddForeignKey
ALTER TABLE "ShopifyWebhook" ADD CONSTRAINT "ShopifyWebhook_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

