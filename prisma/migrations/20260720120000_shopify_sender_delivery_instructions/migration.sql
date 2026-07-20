-- AlterTable: Shopify sender (billing) address + native local-delivery instructions on Order.
ALTER TABLE "Order" ADD COLUMN     "deliveryInstructions" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "senderAddressLine" TEXT,
ADD COLUMN     "senderApartment" TEXT,
ADD COLUMN     "senderCity" TEXT,
ADD COLUMN     "senderCountry" TEXT,
ADD COLUMN     "senderProvince" TEXT,
ADD COLUMN     "senderZip" TEXT;
