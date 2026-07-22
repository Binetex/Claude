-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "isBackfilled" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Order_isBackfilled_idx" ON "Order"("isBackfilled");
