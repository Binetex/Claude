import "server-only";
/**
 * Привязка разговора с незнакомого номера к заказу — по тому, что человек сам назвал.
 *
 * Привязываем ТОЛЬКО при однозначном и ТОЧНОМ совпадении: подстрока «Mari» нашла бы и Marianne,
 * и Marina Blvd, а ошибка здесь — это переписка постороннего в чужом заказе, откатить которую
 * нечем. Поэтому имя сравнивается целиком, адрес — от восьми знаков, номер — по цифрам целиком.
 * Два кандидата — не привязываем: ответить одному про заказ другого хуже, чем переспросить.
 */
import type { PrismaClient } from "@/generated/prisma/client";

const RECENT_DAYS = 45;
const MIN_NAME_LEN = 4;
const MIN_ADDRESS_LEN = 8;

/** Номер заказа — это цифры; имя и адрес — всё остальное. */
export function hintKind(hint: string): "number" | "text" {
  return /\d{3,}/.test(hint) && hint.replace(/\D/g, "").length >= 3 && hint.trim().length <= 16 ? "number" : "text";
}

export async function findOrderByHint(prisma: PrismaClient, siteId: string, hint: string): Promise<string | null> {
  const clean = hint.trim().replace(/\s+/g, " ");
  if (clean.length < MIN_NAME_LEN) return null;
  const since = new Date(Date.now() - RECENT_DAYS * 86_400_000);

  const where =
    hintKind(clean) === "number"
      ? // Номер целиком: «20654» не должен находить «120654».
        { orderNumber: { endsWith: clean.replace(/\D/g, "") } }
      : {
          OR: [
            { recipientName: { equals: clean, mode: "insensitive" as const } },
            { senderName: { equals: clean, mode: "insensitive" as const } },
            ...(clean.length >= MIN_ADDRESS_LEN ? [{ addressLine: { contains: clean, mode: "insensitive" as const } }] : []),
          ],
        };

  const candidates = await prisma.order.findMany({
    where: { siteId, createdAt: { gte: since }, orderStatus: { not: "CANCELLED" }, ...where },
    select: { id: true },
    take: 2,
  });
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * Привязывает это входящее и недавние непривязанные сообщения с того же номера К ЭТОМУ МАГАЗИНУ
 * к заказу — разговор обязан читаться целиком в карточке заказа, а не начинаться с середины.
 * Сообщения, которые владелец пометил «игнорировать», не трогаем: он уже решил, что это шум.
 */
export async function linkConversation(prisma: PrismaClient, orderId: string, phoneNormalized: string, storePhone: string | null): Promise<void> {
  const since = new Date(Date.now() - 7 * 86_400_000);
  await prisma.orderCommunication.updateMany({
    where: {
      orderId: null,
      ignoredAt: null,
      externalPhoneNormalized: phoneNormalized,
      ...(storePhone ? { storePhone } : {}),
      occurredAt: { gte: since },
    },
    data: { orderId },
  });
}
