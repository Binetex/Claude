-- Stage 2.1: per-rule Brevo Template ID override. Additive, nullable — existing rules keep
-- using the site-level SiteEmailTemplate (siteId+triggerType) unchanged until set explicitly.

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN "brevoTemplateId" INTEGER;
