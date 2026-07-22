-- CreateIndex
-- NULL допустим много раз в Postgres (NULL != NULL для UNIQUE) — не ломает заказы
-- без внешнего источника (externalId = NULL).
CREATE UNIQUE INDEX "Order_siteId_externalId_key" ON "Order"("siteId", "externalId");
