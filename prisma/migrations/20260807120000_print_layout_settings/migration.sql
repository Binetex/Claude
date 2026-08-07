-- Настройки печати записок: по строке на раскладку (альбомная 2×2 / портретная 1×2).
-- Строки НЕ создаются здесь: отсутствие строки означает «значения по умолчанию»
-- (PRINT_DEFAULTS в src/modules/print/settings.ts), и печать работает до первого захода
-- владельца в настройки.

CREATE TYPE "PrintLayoutKind" AS ENUM ('WIDE', 'TALL');

CREATE TABLE "PrintLayoutSettings" (
    "layout" "PrintLayoutKind" NOT NULL,
    "safeMarginMils" INTEGER NOT NULL,
    "textWidthPx" INTEGER NOT NULL,
    "textHeightPx" INTEGER NOT NULL,
    "basePt" INTEGER NOT NULL,
    "minPt" INTEGER NOT NULL,
    "baseMaxLines" INTEGER NOT NULL,
    "crowdedStepPt" INTEGER NOT NULL,
    "lineHeightPct" INTEGER NOT NULL,
    "recipientPt" INTEGER NOT NULL,
    "recipientLiftPx" INTEGER NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrintLayoutSettings_pkey" PRIMARY KEY ("layout")
);
