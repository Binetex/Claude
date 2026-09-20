-- Заготовки ответов клиенту. Общие на все магазины: текст один и тот же, различия подставляются
-- переменными заказа.
CREATE TABLE "MessageTemplate" (
  "id"        TEXT NOT NULL,
  "title"     TEXT NOT NULL,
  "text"      TEXT NOT NULL,
  "position"  INTEGER NOT NULL DEFAULT 0,
  "active"    BOOLEAN NOT NULL DEFAULT true,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MessageTemplate_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MessageTemplate_active_position_idx" ON "MessageTemplate"("active", "position");
