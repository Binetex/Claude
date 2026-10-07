-- Отзыв можно просить и у получателя букета: у запроса появляется сторона, и на заказ бывает
-- по одному запросу на каждую сторону. Уникальность по заказу заменяется уникальностью по паре
-- «заказ + сторона»: старый код в окне деплоя читает и пишет запросы заказчика как прежде
-- (сторона по умолчанию — CUSTOMER, дубль заказчика по-прежнему отвергается индексом).
CREATE TYPE "ReviewParty" AS ENUM ('CUSTOMER', 'RECIPIENT');

ALTER TABLE "OrderReviewRequest" ADD COLUMN "party" "ReviewParty" NOT NULL DEFAULT 'CUSTOMER';

DROP INDEX "OrderReviewRequest_orderId_key";

CREATE UNIQUE INDEX "OrderReviewRequest_orderId_party_key" ON "OrderReviewRequest"("orderId", "party");
