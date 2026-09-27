-- Загрузка утра: лимит флориста в баллах и ручное закрытие утра на дату.
ALTER TABLE "Florist" ADD COLUMN "morningCapacity" INTEGER NOT NULL DEFAULT 4;

CREATE TABLE "MorningClosure" (
    "day" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MorningClosure_pkey" PRIMARY KEY ("day")
);
