import "server-only";
/**
 * Read-only предсказание исхода обработки события QUO (для DRY-RUN backfill): что БЫЛО БЫ сделано,
 * без записи в БД. Зеркалит решения ingestQuoEvent (dedup по providerEventId, апдейт по resourceId,
 * привязка к заказу через matcher). Никаких мутаций.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { toE164 } from "@/lib/phone";
import { findCandidateOrdersByPhone } from "./ingest";
import { matchCommunicationToOrder } from "./matching";
import type { NormalizedQuoEvent } from "./types";

export type PlanOutcome = { outcome: "created" | "updated" | "duplicate" | "skipped"; linked: boolean };

export async function planQuoEvent(prisma: PrismaClient, event: NormalizedQuoEvent): Promise<PlanOutcome> {
  if (event.kind === "recording" || event.kind === "transcript" || event.kind === "summary") {
    if (!event.resourceId) return { outcome: "skipped", linked: false };
    const parent = await prisma.orderCommunication.findFirst({ where: { provider: "QUO", providerResourceId: event.resourceId, type: { in: ["CALL", "VOICEMAIL"] } }, select: { id: true, orderId: true } });
    return parent ? { outcome: "updated", linked: parent.orderId != null } : { outcome: "skipped", linked: false };
  }
  const dup = await prisma.orderCommunication.findUnique({ where: { provider_providerEventId: { provider: "QUO", providerEventId: event.providerEventId } }, select: { orderId: true } });
  if (dup) return { outcome: "duplicate", linked: dup.orderId != null };
  const existing = event.resourceId ? await prisma.orderCommunication.findFirst({ where: { provider: "QUO", providerResourceId: event.resourceId }, select: { orderId: true } }) : null;
  if (existing) return { outcome: "updated", linked: existing.orderId != null };

  const e164 = toE164(event.externalPhone);
  let linked = false;
  if (e164) {
    const candidates = await findCandidateOrdersByPhone(prisma, e164);
    linked = matchCommunicationToOrder(e164, new Date(event.occurredAt), candidates).matched;
  }
  return { outcome: "created", linked };
}
