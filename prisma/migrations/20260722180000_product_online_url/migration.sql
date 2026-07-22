-- Публичная ссылка на товар в витрине магазина.
-- Woo: permalink (то же, что исторически попадало в adminUrl).
-- Shopify: https://{домен}/products/{handle} — по числовому id витрина не открывается.
-- Только additive: adminUrl не трогаем, для Shopify это по-прежнему ссылка в админку.
-- Заполняется при ближайшей синхронизации каталога; до неё UI использует adminUrl как запасной вариант.

ALTER TABLE "Product" ADD COLUMN "onlineUrl" TEXT;
