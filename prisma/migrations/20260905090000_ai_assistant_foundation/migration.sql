-- Фундамент ИИ-ассистента клиентской переписки: настройки на магазине, выключатель на заказе и
-- журнал разборов. Отправки здесь ещё нет — по умолчанию ассистент выключен, а у включённого
-- стоит сухой прогон (`aiDryRun`), при котором наружу не уходит ничего.
--
-- Только добавление: deploy.sh применяет миграции ДО перезапуска, и несколько минут с новой
-- схемой работает старый код.
CREATE TYPE "AiAssistantMode" AS ENUM ('OFF', 'DRAFT', 'AUTO_SIMPLE');
CREATE TYPE "AiTurnStatus" AS ENUM ('DRAFT', 'SENT', 'DISCARDED', 'SKIPPED', 'FAILED');

ALTER TABLE "Site"
  ADD COLUMN "aiMode" "AiAssistantMode" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "aiDryRun" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "aiKnowledgeBase" TEXT,
  ADD COLUMN "aiUnknownKnowledgeBase" TEXT;

ALTER TABLE "Order" ADD COLUMN "aiDisabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "AiTurn" (
  "id" TEXT NOT NULL,
  "siteId" TEXT NOT NULL,
  "orderId" TEXT,
  "communicationId" TEXT NOT NULL,
  "status" "AiTurnStatus" NOT NULL DEFAULT 'DRAFT',
  "source" TEXT NOT NULL,
  "intent" TEXT,
  "important" BOOLEAN NOT NULL DEFAULT false,
  "needsHuman" BOOLEAN NOT NULL DEFAULT false,
  "replyText" TEXT,
  "skipReason" TEXT,
  "promptText" TEXT,
  "responseText" TEXT,
  "modelName" TEXT,
  "latencyMs" INTEGER,
  "telegramChatId" TEXT,
  "telegramMessageId" TEXT,
  "sentCommunicationId" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiTurn_pkey" PRIMARY KEY ("id")
);

-- Одно входящее — один разбор: повторный заход обработчика второго ответа не создаст.
CREATE UNIQUE INDEX "AiTurn_communicationId_key" ON "AiTurn"("communicationId");
CREATE INDEX "AiTurn_siteId_status_idx" ON "AiTurn"("siteId", "status");
CREATE INDEX "AiTurn_orderId_idx" ON "AiTurn"("orderId");
CREATE INDEX "AiTurn_telegramMessageId_idx" ON "AiTurn"("telegramMessageId");

ALTER TABLE "AiTurn" ADD CONSTRAINT "AiTurn_siteId_fkey"
  FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiTurn" ADD CONSTRAINT "AiTurn_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiTurn" ADD CONSTRAINT "AiTurn_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "OrderCommunication"("id") ON DELETE CASCADE ON UPDATE CASCADE;
