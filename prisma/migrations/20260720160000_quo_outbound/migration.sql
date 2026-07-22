-- QUO исходящие SMS: номер магазина + app-level идемпотентность/автор отправки.

-- AlterTable
ALTER TABLE "OrderCommunication" ADD COLUMN     "sendKey" TEXT,
ADD COLUMN     "sentByUserId" TEXT;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "quoPhoneNumber" TEXT,
ADD COLUMN     "quoPhoneNumberId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "OrderCommunication_sendKey_key" ON "OrderCommunication"("sendKey");
