-- AlterTable: order-level dimensions для Burq Create Order V2 (настраиваемые в BurqSettings)
ALTER TABLE "BurqSettings" ADD COLUMN     "dimensionUnit" TEXT NOT NULL DEFAULT 'in',
ADD COLUMN     "packageHeight" DOUBLE PRECISION,
ADD COLUMN     "packageLength" DOUBLE PRECISION,
ADD COLUMN     "packageWeight" DOUBLE PRECISION,
ADD COLUMN     "packageWidth" DOUBLE PRECISION,
ADD COLUMN     "weightUnit" TEXT NOT NULL DEFAULT 'lb';
