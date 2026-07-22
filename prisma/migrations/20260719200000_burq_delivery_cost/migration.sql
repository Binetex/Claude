-- AlterTable: фактическая стоимость доставки Uber на Delivery (Path A, post-dispatch)
ALTER TABLE "Delivery" ADD COLUMN     "costSource" TEXT,
ADD COLUMN     "finalCost" DECIMAL(10,2),
ADD COLUMN     "finalCostUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "providerExternalId" TEXT,
ADD COLUMN     "providerName" TEXT,
ADD COLUMN     "quoteId" TEXT;
