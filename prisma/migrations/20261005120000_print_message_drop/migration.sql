-- Печать записок: текст открытки можно опустить ниже середины карточки (владелец 05.10.2026).
-- Колонка только добавляется; у существующих строк сдвиг 0 — печать остаётся прежней.
ALTER TABLE "PrintLayoutSettings" ADD COLUMN "messageDropPx" INTEGER NOT NULL DEFAULT 0;
