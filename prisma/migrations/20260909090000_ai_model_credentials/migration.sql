-- Доступ к модели ассистента задаётся в интерфейсе, а не только переменными окружения.
-- Аддитивно: все колонки nullable, пустые значения означают «как раньше, из окружения».
ALTER TABLE "AiAssistantSettings" ADD COLUMN "apiKeyEncrypted" TEXT;
ALTER TABLE "AiAssistantSettings" ADD COLUMN "apiKeyMask" TEXT;
ALTER TABLE "AiAssistantSettings" ADD COLUMN "baseUrl" TEXT;
ALTER TABLE "AiAssistantSettings" ADD COLUMN "model" TEXT;
ALTER TABLE "AiAssistantSettings" ADD COLUMN "checkStatus" TEXT;
ALTER TABLE "AiAssistantSettings" ADD COLUMN "checkAt" TIMESTAMP(3);
ALTER TABLE "AiAssistantSettings" ADD COLUMN "checkErrorSafe" TEXT;
