import "server-only";
/**
 * Чтение переписки заказа для карточки. Отдельным модулем, потому что карточку рисуют ТРИ роли
 * (владелец, флорист, колл-центр) из одних и тех же компонентов — три копии этого запроса
 * разъехались бы при первой же правке.
 */
import type { PrismaClient } from "@/generated/prisma/client";

export type OrderEmailItem = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  fromEmail: string;
  subject: string | null;
  text: string;
  occurredAt: string;
  errorSafe: string | null;
};

/** Письма заказа по времени, старые сверху — как читается переписка. */
export async function loadOrderEmails(prisma: PrismaClient, orderId: string): Promise<OrderEmailItem[]> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: { orderId },
    orderBy: { occurredAt: "asc" },
    select: { id: true, direction: true, status: true, fromEmail: true, subject: true, text: true, occurredAt: true, errorSafe: true },
  });
  return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
}
