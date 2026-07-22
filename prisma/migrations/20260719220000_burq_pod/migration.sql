-- AlterTable: Proof of Delivery поля на Delivery (Path A, храним Burq URL как есть)
ALTER TABLE "Delivery" ADD COLUMN     "proofOfDeliveryFetchedAt" TIMESTAMP(3),
ADD COLUMN     "proofOfDeliveryUrls" JSONB,
ADD COLUMN     "signatureImageUrl" TEXT;
