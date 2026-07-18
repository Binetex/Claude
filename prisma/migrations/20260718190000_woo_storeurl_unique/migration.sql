-- Идемпотентность подключения WooCommerce: один магазин (storeUrl) — одна запись.
-- CreateIndex
CREATE UNIQUE INDEX "WooCommerceConnection_storeUrl_key" ON "WooCommerceConnection"("storeUrl");
