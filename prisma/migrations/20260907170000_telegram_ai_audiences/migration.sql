-- Отдельные адресаты для уведомлений ассистента (ИИ): черновики ответов, «клиент назвал время»,
-- «клиент просит позвонить». Владельцу нужно уметь выключить ИИ-поток, не трогая уведомления о
-- заказах, оплатах и доставке. Значения по умолчанию — как было: пишем всем. Только добавление.
ALTER TABLE "TelegramSettings" ADD COLUMN "aiNotifyOwner" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TelegramSettings" ADD COLUMN "aiNotifyFlorists" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TelegramSettings" ADD COLUMN "aiNotifyCustomerService" BOOLEAN NOT NULL DEFAULT true;
