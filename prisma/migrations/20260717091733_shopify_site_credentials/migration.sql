-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "shopifyShopDomain" TEXT,
ADD COLUMN     "shopifyAccessToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Site_shopifyShopDomain_key" ON "Site"("shopifyShopDomain");
