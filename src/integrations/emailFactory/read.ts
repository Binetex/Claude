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
  /** Ответ клиента, которого ещё никто не открывал. Помечается в ленте и считается на вкладке. */
  isNew: boolean;
};

export type OrderEmailPanel = {
  emails: OrderEmailItem[];
  /** Сколько ответов клиента ещё не открывали — цифра на вкладке «Email». */
  unread: number;
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
  // Считаем по уже загруженным письмам, а не отдельным запросом: один и тот же список, и
  // цифра на вкладке не может разойтись с тем, что помечено в ленте.
  return { emails, unread: emails.filter((e) => e.isNew).length, customerEmail: order?.senderEmail ?? null };
}

/**
 * Письма заказа, НОВЫЕ СВЕРХУ — тем же порядком, что лента SMS рядом.
 *
 * Раньше почта шла наоборот, старыми вверх: на одном экране две ленты читались в разные
 * стороны, и свежий ответ клиента прятался под низ переписки — ровно там, куда не смотрят.
 */
export async function loadOrderEmails(prisma: PrismaClient, orderId: string): Promise<OrderEmailItem[]> {
  const rows = await prisma.orderEmailMessage.findMany({
    where: { orderId },
    orderBy: { occurredAt: "desc" },
    select: { id: true, direction: true, status: true, fromEmail: true, subject: true, text: true, occurredAt: true, errorSafe: true, readAt: true },
  });
  return rows.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString(), isNew: r.direction === "INBOUND" && r.readAt === null }));
}

/** Сколько ответов клиента по заказу ещё никто не открывал. Считать ДО пометки прочитанным. */
export async function countUnreadEmails(prisma: PrismaClient, orderId: string): Promise<number> {
  return prisma.orderEmailMessage.count({ where: { orderId, direction: "INBOUND", readAt: null } });
}

/** Карточку открыли — входящие письма этого заказа считаются увиденными. */
export async function markOrderEmailsRead(prisma: PrismaClient, orderId: string): Promise<number> {
  const r = await prisma.orderEmailMessage.updateMany({
    where: { orderId, direction: "INBOUND", readAt: null },
    data: { readAt: new Date() },
  });
  return r.count;
}
