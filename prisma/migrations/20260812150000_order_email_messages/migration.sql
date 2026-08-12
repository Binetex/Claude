-- Переписка по email, относящаяся к заказу (Email Factory): входящие от клиента и наши ручные
-- ответы. Автоматические письма Brevo сюда НЕ попадают — у них своя история в AutomationJob.
--
-- "orderId" NULL допустим намеренно: опрос сохраняет все входящие, а к заказу привязываются не
-- все. Непривязанные нигде не показываются и нужны только как курсор опроса.

-- CreateEnum
CREATE TYPE "EmailMessageStatus" AS ENUM ('RECEIVED', 'PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "OrderEmailMessage" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'EMAIL_FACTORY',
    "providerMessageId" TEXT,
    "threadId" TEXT,
    "direction" "CommunicationDirection" NOT NULL,
    "status" "EmailMessageStatus" NOT NULL DEFAULT 'RECEIVED',
    "fromEmail" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT,
    "text" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "sendKey" TEXT,
    "sentByUserId" TEXT,
    "errorSafe" TEXT,

    CONSTRAINT "OrderEmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderEmailMessage_providerMessageId_key" ON "OrderEmailMessage"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderEmailMessage_sendKey_key" ON "OrderEmailMessage"("sendKey");

-- CreateIndex
CREATE INDEX "OrderEmailMessage_orderId_occurredAt_idx" ON "OrderEmailMessage"("orderId", "occurredAt");

-- CreateIndex
CREATE INDEX "OrderEmailMessage_direction_occurredAt_idx" ON "OrderEmailMessage"("direction", "occurredAt");

-- AddForeignKey
ALTER TABLE "OrderEmailMessage" ADD CONSTRAINT "OrderEmailMessage_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
