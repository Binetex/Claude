-- Внутренние Telegram-уведомления: хранение message_id для editMessage вместо дублей.
-- Только additive: существующие таблицы не изменяются.
--
-- dedupeKey включает аудиторию, поэтому основное сообщение флористам и основное сообщение
-- владельцу по одному заказу живут независимо, а срочные уведомления владельцу
-- (payment.pending / delivery.problem) имеют собственные ключи и не затирают основное.
-- chatId/messageId — TEXT: id супергрупп Telegram — большие отрицательные числа; строка
-- исключает потерю точности, арифметика над ними не нужна.

CREATE TYPE "TelegramAudience" AS ENUM ('FLORIST', 'OWNER');

CREATE TABLE "TelegramMessage" (
    "id" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "audience" "TelegramAudience" NOT NULL,
    "chatId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "orderId" TEXT,
    "eventType" TEXT NOT NULL,
    "lastText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TelegramMessage_dedupeKey_key" ON "TelegramMessage"("dedupeKey");
CREATE INDEX "TelegramMessage_orderId_idx" ON "TelegramMessage"("orderId");

-- Заказ удаляют редко (используется soft-delete), но при физическом удалении историю
-- уведомлений не теряем — просто отвязываем.
ALTER TABLE "TelegramMessage" ADD CONSTRAINT "TelegramMessage_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
