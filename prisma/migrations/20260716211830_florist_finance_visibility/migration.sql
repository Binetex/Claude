-- CreateEnum
CREATE TYPE "FloristFinanceVisibility" AS ENUM ('MAKER_ONLY', 'FULL');

-- AlterTable
ALTER TABLE "Florist" ADD COLUMN     "financeVisibility" "FloristFinanceVisibility" NOT NULL DEFAULT 'MAKER_ONLY';
