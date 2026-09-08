-- Купон за отзыв. Один код на все магазины (решение владельца): клиент обещал отзыв — ему уходит
-- одно и то же вознаграждение, независимо от того, в каком магазине он покупал.
CREATE TABLE "ReviewRewardSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "couponCode" TEXT,
    "couponSms" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewRewardSettings_pkey" PRIMARY KEY ("id")
);

-- Отправленный купон — на самом запросе: «не забыть отправить» и «уже отправлял» это состояние
-- запроса, а не отдельная сущность. Снимок кода нужен, потому что код меняют.
ALTER TABLE "OrderReviewRequest" ADD COLUMN "couponSentAt" TIMESTAMP(3);
ALTER TABLE "OrderReviewRequest" ADD COLUMN "couponCodeSnapshot" TEXT;
