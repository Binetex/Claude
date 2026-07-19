-- CreateEnum
CREATE TYPE "BurqEnvironment" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateTable
CREATE TABLE "BurqSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "environment" "BurqEnvironment" NOT NULL DEFAULT 'SANDBOX',
    "apiKeyEncrypted" TEXT,
    "apiKeyMask" TEXT,
    "webhookSecretEncrypted" TEXT,
    "webhookSecretMask" TEXT,
    "apiBaseUrl" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "draftCreationEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastConnectionCheckAt" TIMESTAMP(3),
    "connectionStatus" TEXT,
    "connectionErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BurqSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BurqSettingsAudit" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "environment" "BurqEnvironment" NOT NULL,
    "detailSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BurqSettingsAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BurqSettingsAudit_createdAt_idx" ON "BurqSettingsAudit"("createdAt");

