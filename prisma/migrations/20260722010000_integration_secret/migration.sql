-- Зашифрованные секреты интеграций (глобально). Сейчас — QUO webhook signing secrets.
-- Аддитивно: только новая таблица. Env-переменные (QUO_WEBHOOK_SIGNING_KEYS) не затрагиваются.

-- CreateTable
CREATE TABLE "IntegrationSecret" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "encryptedValue" TEXT NOT NULL,
    "maskedSuffix" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IntegrationSecret_provider_kind_active_idx" ON "IntegrationSecret"("provider", "kind", "active");
