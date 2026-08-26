-- Воронка запроса отзыва: карточка на заказе, журнал её движения и настройки модуля на магазин.

CREATE TYPE "ReviewRequestStatus" AS ENUM (
    'NEW', 'CALLING', 'LINK_SENT', 'PROMISED', 'FORGOT', 'READY_TO_CHECK', 'CONFIRMED', 'DECLINED', 'GAVE_UP'
);
CREATE TYPE "ReviewLinkChannel" AS ENUM ('SMS', 'EMAIL');
CREATE TYPE "ReviewConfirmVia" AS ENUM ('GOOGLE_MATCH', 'MANUAL');
CREATE TYPE "ReviewEventKind" AS ENUM (
    'CREATED', 'CALL_NO_ANSWER', 'CALL_TALKED', 'LINK_SENT', 'LINK_FAILED', 'PROMISED', 'REMINDED',
    'CONFIRMED', 'DECLINED', 'GAVE_UP', 'LOCATION_CHANGED', 'REOPENED'
);

CREATE TABLE "OrderReviewRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "locationId" TEXT,
    "reviewUrlSnapshot" TEXT,
    "status" "ReviewRequestStatus" NOT NULL DEFAULT 'NEW',
    "callAttempts" INTEGER NOT NULL DEFAULT 0,
    "nextActionAt" TIMESTAMP(3),
    "linkSentAt" TIMESTAMP(3),
    "linkChannel" "ReviewLinkChannel",
    "promisedAt" TIMESTAMP(3),
    "remindedAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "confirmedVia" "ReviewConfirmVia",
    "confirmedByUserId" TEXT,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderReviewRequest_pkey" PRIMARY KEY ("id")
);

-- Один заказ — один запрос. Второй запрос по тому же заказу означал бы два звонка клиенту.
CREATE UNIQUE INDEX "OrderReviewRequest_orderId_key" ON "OrderReviewRequest"("orderId");
-- Очередь оператора строится по сроку следующего действия, а не по статусу.
CREATE INDEX "OrderReviewRequest_status_nextActionAt_idx" ON "OrderReviewRequest"("status", "nextActionAt");
CREATE INDEX "OrderReviewRequest_locationId_idx" ON "OrderReviewRequest"("locationId");

ALTER TABLE "OrderReviewRequest" ADD CONSTRAINT "OrderReviewRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Точку могли удалить; запрос при этом обязан выжить — в нём снимок ссылки, которую получил клиент.
ALTER TABLE "OrderReviewRequest" ADD CONSTRAINT "OrderReviewRequest_locationId_fkey"
    FOREIGN KEY ("locationId") REFERENCES "GoogleLocation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderReviewRequest" ADD CONSTRAINT "OrderReviewRequest_confirmedByUserId_fkey"
    FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ReviewRequestEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "ReviewEventKind" NOT NULL,
    "userId" TEXT,
    "detailSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewRequestEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReviewRequestEvent_requestId_createdAt_idx" ON "ReviewRequestEvent"("requestId", "createdAt");

ALTER TABLE "ReviewRequestEvent" ADD CONSTRAINT "ReviewRequestEvent_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "OrderReviewRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewRequestEvent" ADD CONSTRAINT "ReviewRequestEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "SiteReviewSettings" (
    "siteId" TEXT NOT NULL,
    "askSmsTemplate" TEXT,
    "askBrevoTemplateId" INTEGER,
    "reminderSmsTemplate" TEXT,
    "reminderBrevoTemplateId" INTEGER,
    "promiseWaitDays" INTEGER NOT NULL DEFAULT 14,
    "maxCallAttempts" INTEGER NOT NULL DEFAULT 2,
    "callRetryDays" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SiteReviewSettings_pkey" PRIMARY KEY ("siteId")
);

ALTER TABLE "SiteReviewSettings" ADD CONSTRAINT "SiteReviewSettings_siteId_fkey"
    FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;
