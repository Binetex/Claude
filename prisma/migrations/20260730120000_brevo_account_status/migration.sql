-- CreateTable
CREATE TABLE "BrevoAccountStatus" (
    "id" TEXT NOT NULL,
    "connStatus" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "accountEmail" TEXT,
    "errorSafe" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BrevoAccountStatus_pkey" PRIMARY KEY ("id")
);
