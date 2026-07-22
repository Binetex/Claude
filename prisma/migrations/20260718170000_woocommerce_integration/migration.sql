
-- CreateEnum
CREATE TYPE "WooConnStatus" AS ENUM ('CONNECTING', 'CONNECTED', 'DEGRADED', 'REAUTH_REQUIRED', 'DISCONNECTED');

-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PAY_LATER_APPROVED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "externalStatus" TEXT,
ADD COLUMN     "paymentClassification" TEXT,
ADD COLUMN     "paymentMethod" TEXT,
ADD COLUMN     "paymentMethodTitle" TEXT,
ADD COLUMN     "paymentWarning" TEXT,
ADD COLUMN     "remoteDeleted" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "WooCommerceConnection" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "storeUrl" TEXT NOT NULL,
    "apiBaseUrl" TEXT NOT NULL,
    "apiVersion" TEXT NOT NULL DEFAULT 'wc/v3',
    "consumerKeyEncrypted" TEXT NOT NULL,
    "consumerSecretEncrypted" TEXT NOT NULL,
    "consumerSecretMask" TEXT NOT NULL,
    "webhookSecretEncrypted" TEXT,
    "connStatus" "WooConnStatus" NOT NULL DEFAULT 'CONNECTING',
    "connectionError" TEXT,
    "storeName" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "wooVersion" TEXT,
    "wpVersion" TEXT,
    "lastConnectionCheckAt" TIMESTAMP(3),
    "lastProductSyncAt" TIMESTAMP(3),
    "lastOrderSyncAt" TIMESTAMP(3),
    "orderMetaMapping" JSONB,
    "airwallexEnabled" BOOLEAN NOT NULL DEFAULT false,
    "klarnaPayLaterPendingIsConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "airwallexPaymentMethodIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "airwallexMetaKeys" JSONB,
    "payLaterMaxWaitMinutes" INTEGER NOT NULL DEFAULT 1440,
    "unknownBehavior" TEXT NOT NULL DEFAULT 'HOLD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WooCommerceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WooCommerceWebhook" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "externalId" TEXT,
    "deliveryUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastDeliveryAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WooCommerceWebhook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WooCommerceConnection_siteId_key" ON "WooCommerceConnection"("siteId");

-- CreateIndex
CREATE INDEX "WooCommerceWebhook_siteId_idx" ON "WooCommerceWebhook"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "WooCommerceWebhook_siteId_topic_key" ON "WooCommerceWebhook"("siteId", "topic");

-- AddForeignKey
ALTER TABLE "WooCommerceConnection" ADD CONSTRAINT "WooCommerceConnection_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WooCommerceWebhook" ADD CONSTRAINT "WooCommerceWebhook_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

