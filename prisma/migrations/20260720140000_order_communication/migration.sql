-- QUO (ex-OpenPhone) единая история коммуникаций по заказу.

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('SMS', 'CALL', 'VOICEMAIL');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CommunicationPartyRole" AS ENUM ('CUSTOMER', 'RECIPIENT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('PENDING', 'SENT', 'DELIVERED', 'RECEIVED', 'COMPLETED', 'MISSED', 'FAILED');

-- CreateTable
CREATE TABLE "OrderCommunication" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'QUO',
    "providerEventId" TEXT,
    "providerResourceId" TEXT,
    "providerConversationId" TEXT,
    "providerUserId" TEXT,
    "providerPhoneNumberId" TEXT,
    "type" "CommunicationType" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL,
    "partyRole" "CommunicationPartyRole" NOT NULL DEFAULT 'UNKNOWN',
    "status" "CommunicationStatus" NOT NULL,
    "storePhone" TEXT,
    "externalPhone" TEXT NOT NULL,
    "externalPhoneNormalized" TEXT NOT NULL,
    "messageText" TEXT,
    "durationSeconds" INTEGER,
    "recordingUrl" TEXT,
    "transcript" TEXT,
    "summary" TEXT,
    "attachmentsJson" JSONB,
    "rawMetadata" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderCommunication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderCommunication_orderId_occurredAt_idx" ON "OrderCommunication"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "OrderCommunication_externalPhoneNormalized_occurredAt_idx" ON "OrderCommunication"("externalPhoneNormalized", "occurredAt");

-- CreateIndex
CREATE INDEX "OrderCommunication_providerResourceId_idx" ON "OrderCommunication"("providerResourceId");

-- CreateIndex
CREATE INDEX "OrderCommunication_orderId_readAt_idx" ON "OrderCommunication"("orderId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommunication_provider_providerEventId_key" ON "OrderCommunication"("provider", "providerEventId");

-- AddForeignKey
ALTER TABLE "OrderCommunication" ADD CONSTRAINT "OrderCommunication_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
