-- Removes the legacy Automation.channel column + AutomationChannel enum (Stage 1 leftover).
-- Confirmed unread anywhere in application code before this migration was written: channel
-- selection is fully determined by Automation.smsEnabled/emailEnabled/emailFallbackEnabled
-- (added in Stage 2) and AutomationJob.channel (per-job, not per-rule).

-- AlterTable
ALTER TABLE "Automation" DROP COLUMN "channel";

-- DropEnum
DROP TYPE "AutomationChannel";
