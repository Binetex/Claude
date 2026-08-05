-- Недоступность флориста: выходные по дням недели и отдельные даты.
-- Массивы на самой строке флориста: значений единицы, отдельная таблица с индексами
-- и каскадами стоила бы дороже, чем даёт.
ALTER TABLE "Florist"
  ADD COLUMN "weekendDays" INTEGER[] NOT NULL DEFAULT ARRAY[]::INTEGER[],
  ADD COLUMN "daysOff" TIMESTAMP(3)[] NOT NULL DEFAULT ARRAY[]::TIMESTAMP(3)[];
