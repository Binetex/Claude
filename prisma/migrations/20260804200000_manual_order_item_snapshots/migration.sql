-- Ручной заказ: позиция БЕЗ каталога.
--
-- У позиции ручного заказа, созданной «своим текстом», productId и variantId пусты, и
-- финансовый тип вывести неоткуда. По умолчанию это обычный цветочный товар, и расчёт дня
-- такую позицию уже переживает (resolveItemsFinance даёт costRequired=false, день не
-- блокируется). Снимки нужны для редкого случая из блока «Дополнительно»: позиция сама
-- является вазой или подарком со своей закупочной стоимостью.
--
-- Обе колонки NULLABLE и без DEFAULT: NULL — обычное состояние всех существующих позиций,
-- у которых тип по-прежнему берётся из Product/ProductVariant. Backfill не нужен.

ALTER TABLE "OrderItem" ADD COLUMN "financialTypeSnapshot" "FinancialItemType";
ALTER TABLE "OrderItem" ADD COLUMN "purchaseCostSnapshotCents" INTEGER;
