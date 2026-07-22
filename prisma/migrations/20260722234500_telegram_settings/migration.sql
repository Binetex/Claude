-- Настройки Telegram-уведомлений (singleton). Заменяют конфигурацию через .env.
-- Только additive. Токен хранится зашифрованным (AES-256-GCM, lib/crypto/secretBox);
-- открытый текст в БД не попадает и в UI обратно не отдаётся.
CREATE TABLE "TelegramSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "botTokenEncrypted" TEXT,
    "ownerChatId" TEXT,
    "floristsChatId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "botUsername" TEXT,
    "lastErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramSettings_pkey" PRIMARY KEY ("id")
);
