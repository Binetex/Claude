-- Персональные боты: у каждого флориста свой бот и свой личный чат.
-- Только additive: колонки TelegramSettings сохраняются (перестают читаться), ничего не удаляется.
-- Откат сводится к возврату кода — данные остаются на месте.

CREATE TYPE "TelegramBotPurpose" AS ENUM ('OWNER', 'FLORIST', 'CUSTOMER_SERVICE');

CREATE TABLE "TelegramBot" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "purpose" "TelegramBotPurpose" NOT NULL,
    "tokenEncrypted" TEXT,
    "botUsername" TEXT,
    "chatId" TEXT,
    "floristId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "lastErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramBot_pkey" PRIMARY KEY ("id")
);

-- Один бот на флориста; chatId НЕ уникален — разные боты могут писать в один чат.
CREATE UNIQUE INDEX "TelegramBot_floristId_key" ON "TelegramBot"("floristId");
CREATE INDEX "TelegramBot_purpose_idx" ON "TelegramBot"("purpose");

ALTER TABLE "TelegramBot" ADD CONSTRAINT "TelegramBot_floristId_fkey"
    FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Каким ботом отправлено сообщение: нужен, чтобы редактировать его ТЕМ ЖЕ токеном.
ALTER TABLE "TelegramMessage" ADD COLUMN "botId" TEXT;
ALTER TABLE "TelegramMessage" ADD CONSTRAINT "TelegramMessage_botId_fkey"
    FOREIGN KEY ("botId") REFERENCES "TelegramBot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Текущий бот владельца переезжает в новую таблицу. Шифртекст копируется как есть,
-- расшифровка не требуется и ключ шифрования здесь не нужен.
INSERT INTO "TelegramBot" ("id", "label", "purpose", "tokenEncrypted", "botUsername", "chatId", "enabled", "verifiedAt", "createdAt", "updatedAt")
SELECT 'owner-bot', 'Владелец', 'OWNER', "botTokenEncrypted", "botUsername", "ownerChatId", "enabled", "verifiedAt", now(), now()
FROM "TelegramSettings"
WHERE "botTokenEncrypted" IS NOT NULL;

-- Проверка: если бот владельца был настроен, он обязан перенестись.
DO $$
DECLARE src BIGINT; dst BIGINT;
BEGIN
    SELECT count(*) INTO src FROM "TelegramSettings" WHERE "botTokenEncrypted" IS NOT NULL;
    SELECT count(*) INTO dst FROM "TelegramBot" WHERE purpose = 'OWNER';
    IF src <> dst THEN
        RAISE EXCEPTION 'Перенос бота владельца не удался: было %, стало %', src, dst;
    END IF;
END $$;
