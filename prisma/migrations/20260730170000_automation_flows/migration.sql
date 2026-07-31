-- CreateEnum
CREATE TYPE "FlowStepType" AS ENUM ('WAIT', 'EMAIL', 'SMS');

-- CreateEnum
CREATE TYPE "FlowRunStatus" AS ENUM ('ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateTable
CREATE TABLE "AutomationFlow" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "triggerType" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationFlow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationFlowSite" (
    "flowId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationFlowSite_pkey" PRIMARY KEY ("flowId","siteId")
);

-- CreateTable
CREATE TABLE "AutomationFlowStep" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "FlowStepType" NOT NULL,
    "waitAmount" INTEGER,
    "waitUnit" "SmsDelayUnit",
    "brevoTemplateId" INTEGER,
    "template" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "AutomationFlowStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationFlowRun" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "status" "FlowRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStepId" TEXT,
    "nextRunAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "cancelledReason" TEXT,

    CONSTRAINT "AutomationFlowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationFlowRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "type" "FlowStepType" NOT NULL,
    "status" "SmsJobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT,
    "phoneNormalized" TEXT,
    "emailNormalized" TEXT,
    "renderedTextSnapshot" TEXT,
    "communicationId" TEXT,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorSafe" TEXT,
    "sentAt" TIMESTAMP(3),
    "skippedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AutomationFlowRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationFlow_triggerType_active_idx" ON "AutomationFlow"("triggerType", "active");

-- CreateIndex
CREATE INDEX "AutomationFlowSite_siteId_idx" ON "AutomationFlowSite"("siteId");

-- CreateIndex
CREATE INDEX "AutomationFlowStep_flowId_position_idx" ON "AutomationFlowStep"("flowId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationFlowStep_flowId_position_key" ON "AutomationFlowStep"("flowId", "position");

-- CreateIndex
CREATE INDEX "AutomationFlowRun_status_nextRunAt_idx" ON "AutomationFlowRun"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "AutomationFlowRun_orderId_idx" ON "AutomationFlowRun"("orderId");

-- CreateIndex
CREATE INDEX "AutomationFlowRun_siteId_status_idx" ON "AutomationFlowRun"("siteId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationFlowRun_flowId_orderId_key" ON "AutomationFlowRun"("flowId", "orderId");

-- CreateIndex
CREATE INDEX "AutomationFlowRunStep_runId_position_idx" ON "AutomationFlowRunStep"("runId", "position");

-- CreateIndex
CREATE INDEX "AutomationFlowRunStep_status_scheduledAt_idx" ON "AutomationFlowRunStep"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "AutomationFlowRunStep_communicationId_idx" ON "AutomationFlowRunStep"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationFlowRunStep_runId_stepId_key" ON "AutomationFlowRunStep"("runId", "stepId");

-- AddForeignKey
ALTER TABLE "AutomationFlowSite" ADD CONSTRAINT "AutomationFlowSite_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "AutomationFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowSite" ADD CONSTRAINT "AutomationFlowSite_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowStep" ADD CONSTRAINT "AutomationFlowStep_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "AutomationFlow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRun" ADD CONSTRAINT "AutomationFlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "AutomationFlow"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRun" ADD CONSTRAINT "AutomationFlowRun_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRun" ADD CONSTRAINT "AutomationFlowRun_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRunStep" ADD CONSTRAINT "AutomationFlowRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AutomationFlowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRunStep" ADD CONSTRAINT "AutomationFlowRunStep_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "AutomationFlowStep"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationFlowRunStep" ADD CONSTRAINT "AutomationFlowRunStep_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "OrderCommunication"("id") ON DELETE SET NULL ON UPDATE CASCADE;
