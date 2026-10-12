-- Получатели, которым автоматические сообщения не пишем никогда (по номеру). Только новая таблица.
CREATE TABLE "QuietRecipient" (
    "phone" TEXT NOT NULL,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "QuietRecipient_pkey" PRIMARY KEY ("phone")
);
