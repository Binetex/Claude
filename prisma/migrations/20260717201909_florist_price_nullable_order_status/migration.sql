-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'PARTIALLY_REFUNDED';

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "floristPrice" DROP NOT NULL,
ALTER COLUMN "floristPrice" DROP DEFAULT;

-- Data: прежний дефолт floristPrice=0 означал «не задано» → переводим в NULL,
-- чтобы такие товары давали флористу полную стоимость заказа (0 теперь = явная цена).
UPDATE "Product" SET "floristPrice" = NULL WHERE "floristPrice" = 0;

