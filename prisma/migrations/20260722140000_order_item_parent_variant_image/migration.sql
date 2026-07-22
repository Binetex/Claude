-- OrderItem: раздельные снимки родительского и вариационного изображений.
-- ТОЛЬКО additive: существующий "image" не переименовывается и не удаляется — в старых
-- заказах он хранит эффективное изображение (variant.image ?? product.image), и определить
-- задним числом, что именно там лежит, невозможно. Backfill из текущего каталога НЕ делаем:
-- это переписало бы исторические снимки.

ALTER TABLE "OrderItem"
    ADD COLUMN "parentImageUrl" TEXT,
    ADD COLUMN "variantImageUrl" TEXT;
