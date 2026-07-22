-- QUO: «Игнорировать» для нераспознанных коммуникаций.
ALTER TABLE "OrderCommunication" ADD COLUMN     "ignoredAt" TIMESTAMP(3);
