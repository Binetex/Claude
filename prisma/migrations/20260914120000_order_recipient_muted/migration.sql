-- Сюрприз: по этому заказу мы сами не пишем получателю. Заказчик получает всё как обычно.
ALTER TABLE "Order" ADD COLUMN "recipientMuted" BOOLEAN NOT NULL DEFAULT false;
