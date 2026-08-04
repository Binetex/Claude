-- Выключатель записи статуса в WooCommerce: подтверждённая Airwallex оплата (PAID)
-- проставляет заказу в магазине `processing`. По умолчанию выключено — включается
-- владельцем в настройках конкретного сайта.
ALTER TABLE "WooCommerceConnection"
  ADD COLUMN "pushPaidStatusToWoo" BOOLEAN NOT NULL DEFAULT false;
