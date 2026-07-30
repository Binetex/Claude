-- Email-рассылки (Brevo), этап 1: настройки отправителя и шаблоны — отдельно для каждого магазина.
-- Только additive: две новые таблицы, существующие не изменяются. Секретов не хранит —
-- API-ключ Brevo общий и живёт в переменных окружения.
-- enabled = false по умолчанию, поэтому применение миграции ничего не рассылает.

CREATE TABLE "SiteEmailSettings" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "senderEmail" TEXT,
    "senderName" TEXT,
    "replyTo" TEXT,
    "brevoSenderId" TEXT,
    "domainVerifiedAt" TIMESTAMP(3),
    "lastTestAt" TIMESTAMP(3),
    "lastTestStatus" TEXT,
    "lastErrorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteEmailSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SiteEmailSettings_siteId_key" ON "SiteEmailSettings"("siteId");
ALTER TABLE "SiteEmailSettings" ADD CONSTRAINT "SiteEmailSettings_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SiteEmailTemplate" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "brevoTemplateId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteEmailTemplate_pkey" PRIMARY KEY ("id")
);
-- Один шаблон на пару «магазин + событие»: письмо одного магазина не может уйти по шаблону другого.
CREATE UNIQUE INDEX "SiteEmailTemplate_siteId_triggerType_key" ON "SiteEmailTemplate"("siteId", "triggerType");
CREATE INDEX "SiteEmailTemplate_siteId_idx" ON "SiteEmailTemplate"("siteId");
ALTER TABLE "SiteEmailTemplate" ADD CONSTRAINT "SiteEmailTemplate_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
