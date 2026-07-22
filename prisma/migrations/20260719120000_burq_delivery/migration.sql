
-- CreateEnum
CREATE TYPE "DeliveryProvider" AS ENUM ('BURQ');

-- CreateEnum
CREATE TYPE "DeliveryProviderStatus" AS ENUM ('DRAFT_PENDING', 'DRAFT_CREATED', 'SCHEDULED', 'COURIER_ASSIGNED', 'COURIER_EN_ROUTE_TO_PICKUP', 'AT_PICKUP', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM', 'CANCEL_REQUESTED', 'CANCELLED', 'FAILED', 'RETURNING', 'RETURNED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "DeliveryIntentStatus" AS ENUM ('SCHEDULED', 'WAITING_FOR_FLORIST', 'DRAFT_CREATED', 'SKIPPED', 'FAILED');

-- CreateEnum
CREATE TYPE "DeliveryEventSource" AS ENUM ('BURQ_WEBHOOK', 'MANUAL_ADMIN', 'POLLING', 'SYSTEM');

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "burqDraftAutoCreateEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "burqDraftCreationLocalTime" TEXT NOT NULL DEFAULT '04:00';

-- CreateTable
CREATE TABLE "FloristPickupLocation" (
    "id" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "locationName" TEXT NOT NULL,
    "contactName" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "addressLine" TEXT NOT NULL,
    "apartmentOrSuite" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "courierInstructions" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FloristPickupLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryIntent" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "scheduleVersion" INTEGER NOT NULL DEFAULT 0,
    "scheduledAvailableAt" TIMESTAMP(3),
    "intentStatus" "DeliveryIntentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "lastSkipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryIntent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Delivery" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "provider" "DeliveryProvider" NOT NULL DEFAULT 'BURQ',
    "floristId" TEXT,
    "pickupLocationId" TEXT,
    "expectedFloristId" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "isCurrentAttempt" BOOLEAN NOT NULL DEFAULT true,
    "externalDeliveryId" TEXT,
    "externalOrderRef" TEXT,
    "checkoutUrl" TEXT,
    "isDraft" BOOLEAN NOT NULL DEFAULT true,
    "status" "DeliveryProviderStatus" NOT NULL DEFAULT 'DRAFT_PENDING',
    "rawProviderStatus" TEXT,
    "providerEventAt" TIMESTAMP(3),
    "idempotencyKey" TEXT,
    "quoteAmount" DECIMAL(10,2),
    "currency" TEXT,
    "trackingUrl" TEXT,
    "courierName" TEXT,
    "courierPhone" TEXT,
    "estimatedPickupAt" TIMESTAMP(3),
    "estimatedDeliveryAt" TIMESTAMP(3),
    "pickedUpAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "failureCode" TEXT,
    "failureMessageSafe" TEXT,
    "proofOfDeliveryUrl" TEXT,
    "supersedesDeliveryId" TEXT,
    "supersededByDeliveryId" TEXT,
    "resolutionSource" "DeliveryEventSource",
    "resolvedByUserId" TEXT,
    "lastWebhookAt" TIMESTAMP(3),
    "lastStatusCheckAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryStatusEvent" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "providerEventId" TEXT,
    "rawStatus" TEXT,
    "normalizedStatus" "DeliveryProviderStatus" NOT NULL,
    "source" "DeliveryEventSource" NOT NULL,
    "userId" TEXT,
    "previousStatus" "DeliveryProviderStatus",
    "newStatus" "DeliveryProviderStatus",
    "safeReason" TEXT,
    "occurredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliveryStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FloristPickupLocation_floristId_key" ON "FloristPickupLocation"("floristId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryIntent_orderId_key" ON "DeliveryIntent"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_orderId_idx" ON "Delivery"("orderId");

-- CreateIndex
CREATE INDEX "Delivery_externalDeliveryId_idx" ON "Delivery"("externalDeliveryId");

-- CreateIndex
CREATE INDEX "DeliveryStatusEvent_deliveryId_idx" ON "DeliveryStatusEvent"("deliveryId");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryStatusEvent_deliveryId_providerEventId_key" ON "DeliveryStatusEvent"("deliveryId", "providerEventId");

-- AddForeignKey
ALTER TABLE "FloristPickupLocation" ADD CONSTRAINT "FloristPickupLocation_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryIntent" ADD CONSTRAINT "DeliveryIntent_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Delivery" ADD CONSTRAINT "Delivery_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryStatusEvent" ADD CONSTRAINT "DeliveryStatusEvent_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "Delivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Partial unique index: не более одной актуальной попытки доставки (isCurrentAttempt=true) на заказ.
-- Prisma-схемой partial unique не выражается — задаём напрямую здесь.
CREATE UNIQUE INDEX "Delivery_orderId_current_key" ON "Delivery" ("orderId") WHERE "isCurrentAttempt" = true;
