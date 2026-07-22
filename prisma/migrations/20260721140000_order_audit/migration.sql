-- Аудит ручного редактирования полей заказа сотрудниками (owner/call-center/florist).
-- Пишется в той же транзакции, что и обновление заказа (updateOrderBlock). `changed`
-- содержит только before/after изменившихся полей — без секретов и полного payload.

-- CreateTable
CREATE TABLE "OrderAudit" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "block" TEXT NOT NULL,
    "changed" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderAudit_orderId_createdAt_idx" ON "OrderAudit"("orderId", "createdAt");

-- CreateIndex
CREATE INDEX "OrderAudit_userId_createdAt_idx" ON "OrderAudit"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "OrderAudit" ADD CONSTRAINT "OrderAudit_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderAudit" ADD CONSTRAINT "OrderAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
