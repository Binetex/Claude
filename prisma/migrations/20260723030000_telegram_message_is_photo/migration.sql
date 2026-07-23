-- Тип сообщения (фото/текст): у фото-сообщения подпись правится editMessageCaption, у текстового
-- — editMessageText, и одно в другое не превращается. Флаг нужен, чтобы при передаче заказа
-- выбрать правильный метод редактирования. Только additive.
ALTER TABLE "TelegramMessage" ADD COLUMN "isPhoto" BOOLEAN NOT NULL DEFAULT false;
