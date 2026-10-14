-- Расходники по флористам (владелец 14.10.2026): у прихода — флорист, у которого он лежит, и общий
-- id двух строк передачи между флористами. Колонки только добавляются и пустые: старый код в окне
-- деплоя их не читает, а пустой флорист означает «не распределено», как все записи до сегодня.
ALTER TABLE "ConsumableReceipt" ADD COLUMN "floristId" TEXT;
ALTER TABLE "ConsumableReceipt" ADD COLUMN "transferId" TEXT;

ALTER TABLE "ConsumableReceipt" ADD CONSTRAINT "ConsumableReceipt_floristId_fkey"
    FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "ConsumableReceipt_floristId_idx" ON "ConsumableReceipt"("floristId");
CREATE INDEX "ConsumableReceipt_transferId_idx" ON "ConsumableReceipt"("transferId");
