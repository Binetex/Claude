-- Общее правило ассистента на все магазины: «сегодня выходной», «заказы со вторника».
-- Отдельная singleton-таблица, а не колонка у Site: правило одно на систему, и дублировать его
-- по магазинам значит гарантированно забыть снять в одном из них. Только добавление.
CREATE TABLE "AiAssistantSettings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "globalNote" TEXT,
    "activeUntil" TIMESTAMP(3),
    "updatedByUserId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAssistantSettings_pkey" PRIMARY KEY ("id")
);
