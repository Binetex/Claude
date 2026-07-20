-- QUO: история запусков backfill + лок одного активного LIVE-запуска.

-- CreateEnum
CREATE TYPE "BackfillMode" AS ENUM ('DRY_RUN', 'LIVE');

-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "QuoBackfillRun" (
    "id" TEXT NOT NULL,
    "mode" "BackfillMode" NOT NULL,
    "status" "BackfillStatus" NOT NULL DEFAULT 'RUNNING',
    "fromAt" TIMESTAMP(3) NOT NULL,
    "toAt" TIMESTAMP(3) NOT NULL,
    "siteId" TEXT,
    "quoPhoneNumberId" TEXT,
    "counters" JSONB,
    "breakdown" JSONB,
    "initiatedByUserId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "safeError" TEXT,
    "activeLock" TEXT,

    CONSTRAINT "QuoBackfillRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QuoBackfillRun_activeLock_key" ON "QuoBackfillRun"("activeLock");

-- CreateIndex
CREATE INDEX "QuoBackfillRun_startedAt_idx" ON "QuoBackfillRun"("startedAt");
