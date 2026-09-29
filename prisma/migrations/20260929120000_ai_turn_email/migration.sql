-- Ассистент отвечает и на письма: разбор ссылается либо на SMS/звонок, либо на письмо.
-- Только расширение: старый код всегда заполняет communicationId, новая колонка ему не мешает.
ALTER TABLE "AiTurn" ALTER COLUMN "communicationId" DROP NOT NULL;
ALTER TABLE "AiTurn" ADD COLUMN "emailMessageId" TEXT;
CREATE UNIQUE INDEX "AiTurn_emailMessageId_key" ON "AiTurn"("emailMessageId");
ALTER TABLE "AiTurn" ADD CONSTRAINT "AiTurn_emailMessageId_fkey" FOREIGN KEY ("emailMessageId") REFERENCES "OrderEmailMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
