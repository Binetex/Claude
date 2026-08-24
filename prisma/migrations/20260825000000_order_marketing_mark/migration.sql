-- Пометка владельца о работе с клиентом по заказу: молчать или попросить отзыв.
-- NULL = обычный заказ; это состояние подавляющего большинства.
CREATE TYPE "OrderMarketingMark" AS ENUM ('MUTED', 'ASK_REVIEW');
ALTER TABLE "Order" ADD COLUMN "marketingMark" "OrderMarketingMark";

-- Уведомления теперь адресуются и колл-центру (бот с purpose = CUSTOMER_SERVICE уже был).
ALTER TYPE "TelegramAudience" ADD VALUE 'CUSTOMER_SERVICE';
