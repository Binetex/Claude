-- Stage 2: Email channel for automations. Additive only; defaults preserve current behavior
-- exactly (smsEnabled=true, emailEnabled=false, emailFallbackEnabled=false for existing rows).

-- AlterTable: Automation
ALTER TABLE "Automation" ADD COLUMN "smsEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Automation" ADD COLUMN "emailEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Automation" ADD COLUMN "emailFallbackEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: AutomationJob
ALTER TABLE "AutomationJob" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'SMS';
ALTER TABLE "AutomationJob" ADD COLUMN "emailNormalized" TEXT;
ALTER TABLE "AutomationJob" ADD COLUMN "occurrenceKey" TEXT;
ALTER TABLE "AutomationJob" ALTER COLUMN "phoneNormalized" DROP NOT NULL;
