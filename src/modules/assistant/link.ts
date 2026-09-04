import "server-only";
/**
 * Привязка разговора с незнакомого номера к заказу — по тому, что человек сам назвал.
 *
 * Привязываем ТОЛЬКО при однозначном совпадении: два кандидата — это два разных получателя, и
 * ответить одному про заказ другого хуже, чем переспросить. Ищем среди недавних заказов этого
 * магазина: старый заказ по имени «Мария» с вероятностью девять из десяти не тот.
 */
import type { PrismaClient } from "@/generated/prisma/client";

const RECENT_DAYS = 45;

/** Номер заказа — это цифры; имя и адрес — всё остальное. */
export function hintKind(hint: string): "number" | "text" {
  return /\d{3,}/.test(hint) && hint.replace(/\D/g, "").length >= 3 && hint.trim().length <= 16 ? "number" : "text";
}

export async function findOrderByHint(prisma: PrismaClient, siteId: string, hint: string): Promise<string | null> {
  const clean = hint.trim();
  if (clean.length < 3) return null;
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

  const where =
    hintKind(clean) === "number"
      ? { orderNumber: { contains: clean.replace(/\D/g, "") } }
      : {
          OR: [
            { recipientName: { contains: clean, mode: "insensitive" as const } },
            { senderName: { contains: clean, mode: "insensitive" as const } },
            { addressLine: { contains: clean, mode: "insensitive" as const } },
          ],
        };

  const candidates = await prisma.order.findMany({
    where: { siteId, createdAt: { gte: since }, ...where },
    select: { id: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Привязывает это входящее и недавние непривязанные сообщения с того же номера к заказу —
 * разговор обязан читаться целиком в карточке заказа, а не начинаться с середины.
 */
export async function linkConversation(prisma: PrismaClient, orderId: string, phoneNormalized: string): Promise<void> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  await prisma.orderCommunication.updateMany({
    where: { orderId: null, externalPhoneNormalized: phoneNormalized, occurredAt: { gte: since } },
    data: { orderId },
  });
}
