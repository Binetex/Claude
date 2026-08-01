-- Ваза внутри букета — ССЫЛКА на вариант настоящего товара-вазы вместо дублирования цены.
-- Закупочная стоимость остаётся только у самой вазы (VasePurchaseCost, тип STANDALONE_VASE).
-- INCLUDED_VASE в enum не трогаем: применённую миграцию задним числом не меняем, новый код
-- этот тип не пишет и не читает (в production по нему 0 строк).
--
-- Только добавление nullable-полей. Существующие данные не изменяются.

-- AlterTable
ALTER TABLE "Product" ADD COLUMN "defaultIncludedVaseVariantId" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN "includedVaseVariantId" TEXT;

-- CreateIndex
CREATE INDEX "Product_defaultIncludedVaseVariantId_idx" ON "Product"("defaultIncludedVaseVariantId");

-- CreateIndex
CREATE INDEX "ProductVariant_includedVaseVariantId_idx" ON "ProductVariant"("includedVaseVariantId");

-- AddForeignKey
-- SetNull, а не Cascade: удаление вазы не должно уносить букет. Основной сценарий вывода
-- вазы из оборота — архивирование (remoteDeleted/deletedAt), а не физическое удаление;
-- история VasePurchaseCost при этом защищена собственным Restrict.
ALTER TABLE "Product" ADD CONSTRAINT "Product_defaultIncludedVaseVariantId_fkey"
  FOREIGN KEY ("defaultIncludedVaseVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_includedVaseVariantId_fkey"
  FOREIGN KEY ("includedVaseVariantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Ссылка на саму себя запрещена на уровне БД. Цепочки длиннее одного шага невозможны по
-- правилам сервиса: привязать можно только вариант с эффективным типом VASE, а вариант
-- типа VASE сам ссылку иметь не может — значит цикл не построить.
ALTER TABLE "ProductVariant"
  ADD CONSTRAINT "ProductVariant_vase_not_self"
  CHECK ("includedVaseVariantId" IS NULL OR "includedVaseVariantId" <> "id");
