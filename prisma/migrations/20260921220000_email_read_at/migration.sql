-- Отметка «письмо увидел человек»: значок новых писем на вкладке «Email» карточки заказа.
ALTER TABLE "OrderEmailMessage" ADD COLUMN "readAt" TIMESTAMP(3);
CREATE INDEX "OrderEmailMessage_orderId_direction_readAt_idx" ON "OrderEmailMessage"("orderId", "direction", "readAt");

-- Накопившееся помечаем прочитанным, КРОМЕ писем, привязанных к заказу: непривязанные нигде не
-- показываются, а привязанные — это ровно те ответы клиентов, которые до сих пор никто не видел
-- (входящая почта не доходила до карточки вообще, починено 21.09.2026). Они и должны гореть
-- новыми при первом открытии.
UPDATE "OrderEmailMessage" SET "readAt" = "occurredAt" WHERE "direction" = 'INBOUND' AND "orderId" IS NULL;
