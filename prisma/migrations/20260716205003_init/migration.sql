-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'FLORIST', 'CALL_CENTER');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('WOOCOMMERCE', 'SHOPIFY');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'PENDING');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('UNPAID', 'PAID', 'REFUNDED');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('AWAITING_PAYMENT', 'CONFIRMED', 'ASSIGNED', 'FLORIST_ACCEPTED', 'IN_PROGRESS', 'READY', 'AWAITING_COURIER', 'IN_TRANSIT', 'DELIVERED', 'PROBLEM', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('UNASSIGNED', 'ASSIGNED', 'ACCEPTED');

-- CreateEnum
CREATE TYPE "AssignmentState" AS ENUM ('ASSIGNED', 'ACCEPTED', 'DECLINED', 'REASSIGNED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SCHEDULED', 'IN_TRANSIT', 'DELIVERED', 'FAILED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('LOCAL', 'SYNCED', 'PENDING', 'ERROR');

-- CreateEnum
CREATE TYPE "PriceMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "MessageChannel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageParty" AS ENUM ('SENDER', 'RECIPIENT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" "Role" NOT NULL,
    "telegramId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Florist" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Florist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'PENDING',
    "logo" TEXT,
    "colorTag" TEXT NOT NULL DEFAULT '#64748b',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SiteFloristPriority" (
    "id" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "SiteFloristPriority_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "siteId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "listPrice" DECIMAL(10,2) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FloristProductPrice" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "makeCost" DECIMAL(10,2) NOT NULL,

    CONSTRAINT "FloristProductPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "orderNumber" TEXT NOT NULL,
    "siteId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalCreatedAt" TIMESTAMP(3) NOT NULL,
    "deliveryDate" TIMESTAMP(3) NOT NULL,
    "deliveryWindow" TEXT NOT NULL,
    "senderName" TEXT NOT NULL,
    "senderPhone" TEXT NOT NULL,
    "senderEmail" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientPhone" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "addressLine" TEXT NOT NULL,
    "apartment" TEXT,
    "city" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "cardMessage" TEXT NOT NULL DEFAULT '',
    "originalCardMessage" TEXT NOT NULL DEFAULT '',
    "customerNote" TEXT NOT NULL DEFAULT '',
    "originalCustomerNote" TEXT NOT NULL DEFAULT '',
    "itemsTotal" DECIMAL(10,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "tip" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deliveryCustomerCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "customerTotal" DECIMAL(10,2) NOT NULL,
    "floristTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "deliveryActualCost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "estimatedProfit" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "paymentStatus" "PaymentStatus" NOT NULL DEFAULT 'UNPAID',
    "orderStatus" "OrderStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "assignmentStatus" "AssignmentStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "syncStatus" "SyncStatus" NOT NULL DEFAULT 'LOCAL',
    "currentFloristId" TEXT,
    "priceMode" "PriceMode" NOT NULL DEFAULT 'AUTO',
    "readyAt" TIMESTAMP(3),
    "bouquetPhotoUrl" TEXT,
    "deliveryPhotoUrl" TEXT,
    "trackingUrl" TEXT,
    "externalId" TEXT,
    "platform" "Platform" NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "image" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "options" TEXT NOT NULL DEFAULT '',
    "externalPrice" DECIMAL(10,2) NOT NULL,
    "floristItemPrice" DECIMAL(10,2) NOT NULL DEFAULT 0,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderAssignment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "floristId" TEXT NOT NULL,
    "state" "AssignmentState" NOT NULL DEFAULT 'ASSIGNED',
    "priceMode" "PriceMode" NOT NULL DEFAULT 'AUTO',
    "floristTotalSnapshot" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "OrderAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" "MessageChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "party" "MessageParty" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_idx" ON "User"("role");

-- CreateIndex
CREATE UNIQUE INDEX "Florist_userId_key" ON "Florist"("userId");

-- CreateIndex
CREATE INDEX "SiteFloristPriority_siteId_idx" ON "SiteFloristPriority"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteFloristPriority_siteId_floristId_key" ON "SiteFloristPriority"("siteId", "floristId");

-- CreateIndex
CREATE UNIQUE INDEX "SiteFloristPriority_siteId_position_key" ON "SiteFloristPriority"("siteId", "position");

-- CreateIndex
CREATE INDEX "Product_siteId_idx" ON "Product"("siteId");

-- CreateIndex
CREATE UNIQUE INDEX "FloristProductPrice_productId_floristId_key" ON "FloristProductPrice"("productId", "floristId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderNumber_key" ON "Order"("orderNumber");

-- CreateIndex
CREATE INDEX "Order_siteId_idx" ON "Order"("siteId");

-- CreateIndex
CREATE INDEX "Order_deliveryDate_idx" ON "Order"("deliveryDate");

-- CreateIndex
CREATE INDEX "Order_currentFloristId_idx" ON "Order"("currentFloristId");

-- CreateIndex
CREATE INDEX "Order_orderStatus_idx" ON "Order"("orderStatus");

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderAssignment_orderId_idx" ON "OrderAssignment"("orderId");

-- CreateIndex
CREATE INDEX "OrderAssignment_floristId_idx" ON "OrderAssignment"("floristId");

-- CreateIndex
CREATE INDEX "Message_orderId_idx" ON "Message"("orderId");

-- AddForeignKey
ALTER TABLE "Florist" ADD CONSTRAINT "Florist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteFloristPriority" ADD CONSTRAINT "SiteFloristPriority_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SiteFloristPriority" ADD CONSTRAINT "SiteFloristPriority_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristProductPrice" ADD CONSTRAINT "FloristProductPrice_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FloristProductPrice" ADD CONSTRAINT "FloristProductPrice_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_currentFloristId_fkey" FOREIGN KEY ("currentFloristId") REFERENCES "Florist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAssignment" ADD CONSTRAINT "OrderAssignment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAssignment" ADD CONSTRAINT "OrderAssignment_floristId_fkey" FOREIGN KEY ("floristId") REFERENCES "Florist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
