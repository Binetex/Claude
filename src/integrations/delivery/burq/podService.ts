import "server-only";
/**
 * Повторное получение Proof of Delivery: GET Burq order → извлечь POD → записать на КОНКРЕТНУЮ
 * Delivery. Меняет ТОЛЬКО POD-поля (не статус/оплату/заказ). Используется:
 *  - ручной кнопкой «Обновить Proof of delivery»;
 *  - ОДНИМ отложенным retry, если delivered пришёл, а фото пусто (без бесконечного polling).
 * URL не логируются, не кладутся в outbox, не уходят во внешние уведомления.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { getBurqRuntimeClient } from "./settings";
import { decidePodUpdate } from "./podCapture";

export const BURQ_POD_REFETCH_EVENT = "burq.pod.refetch.requested";
/** Отложка одного refetch после delivered без фото (фото загружается драйвером не мгновенно). */
export const BURQ_POD_REFETCH_DELAY_MS = Number(process.env.BURQ_POD_REFETCH_DELAY_MS ?? 5 * 60 * 1000);

export type RefetchPodResult = { outcome: "updated" | "no_photo" | "not_found" | "no_external"; count: number };

export async function refetchPodForDelivery(prisma: PrismaClient, deliveryId: string): Promise<RefetchPodResult> {
  const delivery = await prisma.delivery.findUnique({ where: { id: deliveryId }, select: { id: true, externalDeliveryId: true } });
  if (!delivery) return { outcome: "not_found", count: 0 };
  if (!delivery.externalDeliveryId) return { outcome: "no_external", count: 0 };

  const client = await getBurqRuntimeClient();
  const o = await client.getOrder(delivery.externalDeliveryId); // throw → outbox retry (bounded)
  const pod = decidePodUpdate({ proofOfDeliveryUrls: o.proofOfDeliveryUrls, signatureImageUrl: o.signatureImageUrl });
  if (!pod.apply) return { outcome: "no_photo", count: 0 };

  await prisma.delivery.update({
    where: { id: delivery.id },
    data: {
      ...(pod.proofOfDeliveryUrls ? { proofOfDeliveryUrls: pod.proofOfDeliveryUrls } : {}),
      ...(pod.signatureImageUrl ? { signatureImageUrl: pod.signatureImageUrl } : {}),
      proofOfDeliveryFetchedAt: new Date(),
    },
  });
  return { outcome: "updated", count: pod.proofOfDeliveryUrls?.length ?? 0 };
}

/** Outbox-handler отложенного refetch. ОДНОразовый (задача дедуплицируется по ключу delivery). */
export function buildBurqPodRefetchHandler(prisma: PrismaClient): OutboxHandler {
  return async (record: OutboxRecord) => {
    if (!isBurqRuntimeEnabled()) return; // master gate
    const { deliveryId } = record.payload as { deliveryId: string };
    await refetchPodForDelivery(prisma, deliveryId);
  };
}
