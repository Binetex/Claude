-- Ежедневная рассылка («Доставка сегодня») переезжает с 09:00 на 08:00 местного времени магазина.
-- Меняем и умолчание для новых магазинов, и уже заведённые: 09:00 стояло у всех, своего времени
-- никто не выставлял, поэтому массовое обновление ничего не затирает.
ALTER TABLE "Site" ALTER COLUMN "automationDailyLocalTime" SET DEFAULT '08:00';
UPDATE "Site" SET "automationDailyLocalTime" = '08:00' WHERE "automationDailyLocalTime" = '09:00';

-- Уже запланированные рассылки настройка не двигает: момент вычислен при создании заказа и лежит
-- в очереди. Без этого завтрашние заказы всё равно ушли бы в 09:00, а смысл правки — чтобы они
-- ушли в 08:00. Сдвиг ровно на час корректен и при переходе на летнее время: перевод часов
-- случается в 02:00, между 08:00 и 09:00 местного дня разрыва нет.
UPDATE "OutboxEvent"
SET "availableAt" = "availableAt" - interval '1 hour'
WHERE "eventType" = 'sms.automation.trigger'
  AND "status" = 'PENDING'
  AND "payload"->>'triggerType' = 'DELIVERY_TODAY';
