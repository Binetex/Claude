-- SMS-маркетинг: движок правил авто-SMS (SmsAutomation + SmsAutomationJob) и Site.reviewUrl.
-- Строго ADDITIVE: существующие таблицы/колонки не изменяются. Правила создаются выключенными;
-- seed-правил и авто-отправок эта миграция не создаёт. Отложенное исполнение — через существующий
-- durable outbox; реальная отправка — через sendOrderSms (номер Site). См. src/modules/sms/*.

-- CreateEnum
CREATE TYPE "SmsAudience" AS ENUM ('CUSTOMER', 'RECIPIENT', 'BOTH');

-- CreateEnum
CREATE TYPE "SmsRecipientType" AS ENUM ('CUSTOMER', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "SmsDelayUnit" AS ENUM ('IMMEDIATE', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH');

-- CreateEnum
CREATE TYPE "SmsJobStatus" AS ENUM ('SCHEDULED', 'PROCESSING', 'SENT', 'SKIPPED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "reviewUrl" TEXT;

-- CreateTable
CREATE TABLE "SmsAutomation" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "triggerType" TEXT NOT NULL,
    "audience" "SmsAudience" NOT NULL,
    "delayAmount" INTEGER NOT NULL DEFAULT 0,
    "delayUnit" "SmsDelayUnit" NOT NULL DEFAULT 'IMMEDIATE',
    "template" TEXT NOT NULL,
    "conditionsJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "SmsAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SmsAutomationJob" (
    "id" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "recipientType" "SmsRecipientType" NOT NULL,
    "phoneNormalized" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "SmsJobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "renderedTextSnapshot" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "communicationId" TEXT,
    "sentAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SmsAutomationJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsAutomation_siteId_active_idx" ON "SmsAutomation"("siteId", "active");

-- CreateIndex
CREATE INDEX "SmsAutomation_triggerType_idx" ON "SmsAutomation"("triggerType");

-- CreateIndex
CREATE UNIQUE INDEX "SmsAutomationJob_idempotencyKey_key" ON "SmsAutomationJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SmsAutomationJob_status_scheduledAt_idx" ON "SmsAutomationJob"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "SmsAutomationJob_automationId_status_idx" ON "SmsAutomationJob"("automationId", "status");

-- CreateIndex
CREATE INDEX "SmsAutomationJob_orderId_idx" ON "SmsAutomationJob"("orderId");

-- CreateIndex
CREATE INDEX "SmsAutomationJob_communicationId_idx" ON "SmsAutomationJob"("communicationId");

-- AddForeignKey
ALTER TABLE "SmsAutomation" ADD CONSTRAINT "SmsAutomation_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsAutomationJob" ADD CONSTRAINT "SmsAutomationJob_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "SmsAutomation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsAutomationJob" ADD CONSTRAINT "SmsAutomationJob_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SmsAutomationJob" ADD CONSTRAINT "SmsAutomationJob_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "OrderCommunication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
