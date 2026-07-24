-- Airwallex Payment Monitoring, Фаза B: состояние платежа заказа + журнал сверок.
-- Только additive. Режим наблюдения: business status заказа этими таблицами не меняется.

CREATE TYPE "AirwallexNormalizedStatus" AS ENUM (
  'PAID', 'AUTHORIZED_NOT_CAPTURED', 'PENDING', 'ACTION_REQUIRED',
  'FAILED', 'NOT_STARTED', 'CANCELLED', 'NOT_FOUND', 'UNKNOWN'
);

CREATE TABLE "AirwallexPayment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "paymentMethod" TEXT,
    "lastRawStatus" TEXT,
    "lastAttemptId" TEXT,
    "lastAttemptStatus" TEXT,
    "normalizedStatus" "AirwallexNormalizedStatus",
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstPendingAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "nextCheckAt" TIMESTAMP(3),
    "stopCheckingAt" TIMESTAMP(3),
    "pendingAlertSentAt" TIMESTAMP(3),
    "failedAlertAttemptId" TEXT,
    "notFoundCount" INTEGER NOT NULL DEFAULT 0,
    "consecutiveErrorCount" INTEGER NOT NULL DEFAULT 0,
    "monitoringActive" BOOLEAN NOT NULL DEFAULT true,
    "safeError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AirwallexPayment_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AirwallexPayment_orderId_key" ON "AirwallexPayment"("orderId");
-- Единственный SELECT диспетчера идёт по этому индексу.
CREATE INDEX "AirwallexPayment_siteId_monitoringActive_nextCheckAt_idx"
    ON "AirwallexPayment"("siteId", "monitoringActive", "nextCheckAt");
ALTER TABLE "AirwallexPayment" ADD CONSTRAINT "AirwallexPayment_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AirwallexCheck" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "paymentIntentId" TEXT,
    "attemptId" TEXT,
    "rawStatus" TEXT,
    "attemptStatus" TEXT,
    "normalizedStatus" "AirwallexNormalizedStatus",
    "outcome" TEXT NOT NULL,
    "safeError" TEXT,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AirwallexCheck_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AirwallexCheck_orderId_checkedAt_idx" ON "AirwallexCheck"("orderId", "checkedAt");
CREATE INDEX "AirwallexCheck_siteId_checkedAt_idx" ON "AirwallexCheck"("siteId", "checkedAt");
ALTER TABLE "AirwallexCheck" ADD CONSTRAINT "AirwallexCheck_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
