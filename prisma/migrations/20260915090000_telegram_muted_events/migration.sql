-- Выключенные по одному типы Telegram-уведомлений. Пустой массив = отправляем всё, как раньше.
ALTER TABLE "TelegramSettings" ADD COLUMN "mutedEvents" TEXT[] NOT NULL DEFAULT '{}';
