-- Обобщение SMS-движка в универсальный Automation Engine. Таблицы SmsAutomation/SmsAutomationJob
-- ПУСТЫ на момент миграции (проверено на prod), поэтому используем чистый RENAME без копирования
-- данных и без параллельных таблиц. FK-цели автоматически следуют за переименованием таблиц.
-- Добавляем channel, глобальный kill switch и журнал выполнения. Строго без seed/backfill.

-- 1) RENAME таблиц
ALTER TABLE "SmsAutomation" RENAME TO "Automation";
ALTER TABLE "SmsAutomationJob" RENAME TO "AutomationJob";

-- 2) RENAME primary-key constraints
ALTER TABLE "Automation" RENAME CONSTRAINT "SmsAutomation_pkey" TO "Automation_pkey";
ALTER TABLE "AutomationJob" RENAME CONSTRAINT "SmsAutomationJob_pkey" TO "AutomationJob_pkey";

-- 3) RENAME индексов (включая idempotency unique)
ALTER INDEX "SmsAutomation_siteId_active_idx" RENAME TO "Automation_siteId_active_idx";
ALTER INDEX "SmsAutomation_triggerType_idx" RENAME TO "Automation_triggerType_idx";
ALTER INDEX "SmsAutomationJob_idempotencyKey_key" RENAME TO "AutomationJob_idempotencyKey_key";
ALTER INDEX "SmsAutomationJob_status_scheduledAt_idx" RENAME TO "AutomationJob_status_scheduledAt_idx";
ALTER INDEX "SmsAutomationJob_automationId_status_idx" RENAME TO "AutomationJob_automationId_status_idx";
ALTER INDEX "SmsAutomationJob_orderId_idx" RENAME TO "AutomationJob_orderId_idx";
ALTER INDEX "SmsAutomationJob_communicationId_idx" RENAME TO "AutomationJob_communicationId_idx";

-- 4) RENAME foreign-key constraints (цели уже указывают на переименованные таблицы)
ALTER TABLE "Automation" RENAME CONSTRAINT "SmsAutomation_siteId_fkey" TO "Automation_siteId_fkey";
ALTER TABLE "AutomationJob" RENAME CONSTRAINT "SmsAutomationJob_automationId_fkey" TO "AutomationJob_automationId_fkey";
ALTER TABLE "AutomationJob" RENAME CONSTRAINT "SmsAutomationJob_orderId_fkey" TO "AutomationJob_orderId_fkey";
ALTER TABLE "AutomationJob" RENAME CONSTRAINT "SmsAutomationJob_communicationId_fkey" TO "AutomationJob_communicationId_fkey";

-- 5) Канал доставки (пока только SMS)
CREATE TYPE "AutomationChannel" AS ENUM ('SMS');
ALTER TABLE "Automation" ADD COLUMN     "channel" "AutomationChannel" NOT NULL DEFAULT 'SMS';

-- 6) Глобальный kill switch (singleton-конфиг; строка создаётся лениво при первом переключении)
CREATE TABLE "AutomationSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "disableAll" BOOLEAN NOT NULL DEFAULT false,
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationSettings_pkey" PRIMARY KEY ("id")
);

-- 7) Журнал выполнения (только для реально созданных Job)
CREATE TABLE "AutomationExecutionLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "orderId" TEXT,
    "stage" TEXT NOT NULL,
    "detailSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationExecutionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_jobId_createdAt_idx" ON "AutomationExecutionLog"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationExecutionLog_automationId_createdAt_idx" ON "AutomationExecutionLog"("automationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AutomationExecutionLog" ADD CONSTRAINT "AutomationExecutionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "AutomationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
