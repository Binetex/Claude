import "server-only";
/**
 * «Этому получателю не писать никогда» — список номеров (`QuietRecipient`). Владелец 12.10.2026:
 * получательница всегда на месте, а её заваливало вопросами, а заказчика — «не можем связаться».
 * Проверяется перед отправкой автоматизаций (`handlers.ts`): решение принимают в любой момент, в
 * том числе пока цепочка уже ждёт ответа.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";

export async function isQuietRecipient(prisma: PrismaClient, phone: string | null | undefined): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  return !!(await prisma.quietRecipient.findUnique({ where: { phone: e164 }, select: { phone: true } }));
}

export async function setQuietRecipient(prisma: PrismaClient, phone: string | null | undefined, quiet: boolean, userId: string | null): Promise<boolean> {
  const e164 = toE164(phone);
  if (!e164) return false;
  if (quiet) await prisma.quietRecipient.upsert({ where: { phone: e164 }, create: { phone: e164, createdBy: userId }, update: {} });
  else await prisma.quietRecipient.deleteMany({ where: { phone: e164 } });
  return true;
}
