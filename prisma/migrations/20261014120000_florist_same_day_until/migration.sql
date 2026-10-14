-- До какого часа флорист получает заказы на сегодня (владелец 14.10.2026: Арине — до 13:00, после
-- заказ на сегодня уходит Ольге). Колонка только добавляется и пустая у всех: старый код в окне
-- деплоя её не читает, а пустое значение означает «без ограничения, как раньше».
ALTER TABLE "Florist" ADD COLUMN "sameDayUntilMin" INTEGER;

ALTER TABLE "Florist" ADD CONSTRAINT "Florist_sameDayUntilMin_check"
    CHECK ("sameDayUntilMin" IS NULL OR ("sameDayUntilMin" BETWEEN 0 AND 1440));
