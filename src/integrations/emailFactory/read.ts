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

export type OrderEmailPanel = {
  emails: OrderEmailItem[];
  /** Адресат первого письма, когда переписки ещё нет. */
  customerEmail: string | null;
};

/**
 * Всё, что нужно почтовой вкладке. Одним вызовом, а не двумя запросами в каждой из трёх страниц:
 * адрес заказчика без писем бесполезен, а письма без адреса не дают написать первым.
 */
export async function loadOrderEmailPanel(prisma: PrismaClient, orderId: string): Promise<OrderEmailPanel> {
  const [emails, order] = await Promise.all([
    loadOrderEmails(prisma, orderId),
    prisma.order.findUnique({ where: { id: orderId }, select: { senderEmail: true } }),
  ]);
  return { emails, customerEmail: order?.senderEmail ?? null };
}

/** Письма заказа по времени, старые сверху — как читается переписка. */
export async function loadOrderEmails(prisma: PrismaClient, orderId: string): Promise<OrderEmailItem[]> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: { orderId },
    orderBy: { occurredAt: "asc" },
    select: { id: true, direction: true, status: true, fromEmail: true, subject: true, text: true, occurredAt: true, errorSafe: true },
  });
  return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }));
}
