-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "description",
ADD COLUMN     "defaultFloristComposition" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "floristComposition" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" DROP COLUMN "description",
ADD COLUMN     "floristCompositionSnapshot" TEXT;

