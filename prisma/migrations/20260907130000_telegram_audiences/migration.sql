-- Кому уходят внутренние Telegram-уведомления. Выключенная аудитория молчит целиком: это
-- быстрый способ увести весь поток в один чат, не разбирая ботов по одному и не теряя их
-- настройки. Значение по умолчанию — как было до этой миграции: пишем всем. Только добавление.
ALTER TABLE "TelegramSettings" ADD COLUMN "notifyOwner" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TelegramSettings" ADD COLUMN "notifyFlorists" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TelegramSettings" ADD COLUMN "notifyCustomerService" BOOLEAN NOT NULL DEFAULT true;
