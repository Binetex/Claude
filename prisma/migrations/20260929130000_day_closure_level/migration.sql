-- Замок дня: кроме утра — «только вечер» и «весь день». Колонка только добавляется; прежние
-- строки остаются утренними замками.
ALTER TABLE "MorningClosure" ADD COLUMN "level" TEXT NOT NULL DEFAULT 'MORNING';
