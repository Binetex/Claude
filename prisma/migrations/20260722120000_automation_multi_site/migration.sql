-- Automation: siteId (1:N) → AutomationSite (M:N).
-- Порядок строгий: создать таблицу → скопировать связи → проверить целостность → только потом
-- удалить Automation.siteId. При любом расхождении транзакция миграции падает и колонка остаётся.

CREATE TABLE "AutomationSite" (
    "automationId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationSite_pkey" PRIMARY KEY ("automationId","siteId")
);

CREATE INDEX "AutomationSite_siteId_idx" ON "AutomationSite"("siteId");

ALTER TABLE "AutomationSite" ADD CONSTRAINT "AutomationSite_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AutomationSite" ADD CONSTRAINT "AutomationSite_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Перенос существующих связей (включая soft-deleted правила — историю не теряем).
INSERT INTO "AutomationSite" ("automationId", "siteId", "createdAt")
SELECT "id", "siteId", "createdAt" FROM "Automation";

-- Проверка: у каждого правила ровно одна перенесённая связь, потерянных нет.
DO $$
DECLARE
    src_count  BIGINT;
    dest_count BIGINT;
    orphans    BIGINT;
BEGIN
    SELECT count(*) INTO src_count FROM "Automation";
    SELECT count(*) INTO dest_count FROM "AutomationSite";
    IF src_count <> dest_count THEN
        RAISE EXCEPTION 'AutomationSite backfill mismatch: Automation=%, AutomationSite=%', src_count, dest_count;
    END IF;

    SELECT count(*) INTO orphans
    FROM "Automation" a
    LEFT JOIN "AutomationSite" s ON s."automationId" = a."id" AND s."siteId" = a."siteId"
    WHERE s."automationId" IS NULL;
    IF orphans > 0 THEN
        RAISE EXCEPTION 'AutomationSite backfill left % automation(s) without their site link', orphans;
    END IF;
END $$;

-- Только теперь убираем старый источник правды.
DROP INDEX "Automation_siteId_active_idx";
DROP INDEX "Automation_triggerType_idx";
ALTER TABLE "Automation" DROP CONSTRAINT "Automation_siteId_fkey";
ALTER TABLE "Automation" DROP COLUMN "siteId";

CREATE INDEX "Automation_triggerType_active_idx" ON "Automation"("triggerType", "active");
