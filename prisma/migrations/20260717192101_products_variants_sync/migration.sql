-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'DRAFT', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SyncKind" AS ENUM ('PRODUCTS', 'ORDERS');

-- CreateEnum
CREATE TYPE "SiteSyncStatus" AS ENUM ('RUNNING', 'DONE', 'ERROR');

-- DropIndex
DROP INDEX "FloristProductPrice_productId_floristId_key";

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "active",
DROP COLUMN "listPrice",
ADD COLUMN     "adminUrl" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "floristPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "lastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "maxPrice" DECIMAL(10,2),
ADD COLUMN     "minPrice" DECIMAL(10,2),
ADD COLUMN     "productType" TEXT,
ADD COLUMN     "remoteDeleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "FloristProductPrice" ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "productExternalId" TEXT,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "variantExternalId" TEXT,
ADD COLUMN     "variantId" TEXT,
ADD COLUMN     "variantName" TEXT;

-- CreateTable
CREATE TABLE "SiteSync" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "kind" "SyncKind" NOT NULL,
    "status" "SiteSyncStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "updated" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errors" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "SiteSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "listPrice" DECIMAL(10,2) NOT NULL,
    "compareAtPrice" DECIMAL(10,2),
    "image" TEXT,
    "option1" TEXT,
    "option2" TEXT,
    "option3" TEXT,
    "inventoryQty" INTEGER,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "floristPrice" DECIMAL(10,2),
    "position" INTEGER,
    "adminUrl" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "remoteDeleted" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteSync_siteId_idx" ON "SiteSync"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteSync_siteId_kind_key" ON "SiteSync"("siteId", "kind");

-- CreateIndex
CREATE INDEX "ProductVariant_productId_idx" ON "ProductVariant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_productId_externalId_key" ON "ProductVariant"("productId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_siteId_externalId_key" ON "Product"("siteId", "externalId");

-- CreateIndex
CREATE INDEX "FloristProductPrice_productId_idx" ON "FloristProductPrice"("productId");

-- CreateIndex
CREATE INDEX "FloristProductPrice_variantId_idx" ON "FloristProductPrice"("variantId");

-- CreateIndex
CREATE UNIQUE INDEX "FloristProductPrice_floristId_productId_variantId_key" ON "FloristProductPrice"("floristId", "productId", "variantId");

-- AddForeignKey
ALTER TABLE "SiteSync" ADD CONSTRAINT "SiteSync_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristProductPrice" ADD CONSTRAINT "FloristProductPrice_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

