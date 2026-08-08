import "server-only";
/**
 * Периодический опрос статусов открытых доставок у Burq.
 *
 * ЗАЧЕМ. Раньше единственным источником статуса был webhook. Он приходит с НАШЕЙ меткой
 * (`external_order_ref`), которую мы кладём в заказ, когда создаём его сами. У доставки,
 * заведённой руками в кабинете Burq, такой метки нет — событие приходит, не находит, к чему
 * прицепиться, и выбрасывается. Заказ навсегда остаётся в том статусе, что был на момент
 * привязки (M-THEFLOW-002: курьер уже привёз и загрузил фото, а у нас «едет за букетом»).
 *
 * Опрос идёт ПО НОМЕРУ ЗАКАЗА В BURQ (`Delivery.externalDeliveryId`) — тем же путём, что и
 * кнопка «обновить фото»: она работает всегда, потому что метка ей не нужна. Поэтому опрос
 * закрывает не один случай, а целый класс: ручные доставки, потерянный webhook, недоступный
 * приёмник, любая рассинхронизация.
 *
 * Webhook остаётся основным каналом — он быстрее. Опрос это подстраховка, и работает он
 * через ту же `applyDeliveryStatusUpdate`: те же anti-rollback, дедуп, маппинг статуса
 * заказа и публикация `order.delivery.completed`. Второй ветки «а если polling» нет и
 * заводить её нельзя — разойдётся с webhook.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { DeliveryProviderStatus } from "@/generated/prisma/enums";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { getBurqRuntimeClient } from "./settings";
import { applyDeliveryStatusUpdate } from "./statusIngest";
import { makeCompletedPublisher } from "./webhookHandler";
import { refetchPodForDelivery } from "./podService";

/**
 * Статусы, после которых спрашивать больше нечего. Всё остальное считается «в работе»,
 * включая PROBLEM: проблемная доставка ещё может доехать.
 */
const TERMINAL: DeliveryProviderStatus[] = ["DELIVERED", "CANCELLED", "RETURNED"];

/** Сколько доставок опрашиваем за один проход. Ограничение бережёт чужой API. */
const BATCH = 25;

export type StatusSyncResult = { scanned: number; updated: number; failed: number };

export async function syncOpenDeliveryStatuses(
  prisma: PrismaClient,
  now: Date = new Date()
): Promise<StatusSyncResult> {
  if (!isBurqRuntimeEnabled()) return { scanned: 0, updated: 0, failed: 0 };

  const open = await prisma.delivery.findMany({
    where: {
      isCurrentAttempt: true,
      isDraft: false, // черновик ещё не доставка: у него нет курьера и статуса, который меняется
      externalDeliveryId: { not: null },
      status: { notIn: TERMINAL },
      // Заказы старше недели не опрашиваем: если за неделю статус не пришёл, он и не придёт,
      // а Burq незачем дёргать вечно. Такие разбираются руками.
      order: { deliveryDate: { gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000) } },
    },
    select: { id: true, externalDeliveryId: true },
    orderBy: { updatedAt: "asc" }, // самые залежавшиеся — первыми
    take: BATCH,
  });
  if (open.length === 0) return { scanned: 0, updated: 0, failed: 0 };

  const client = await getBurqRuntimeClient();
  const publishCompleted = makeCompletedPublisher(prisma);
  let updated = 0;
  let failed = 0;

  for (const delivery of open) {
    try {
      const o = await client.getOrder(delivery.externalDeliveryId!);
      const res = await applyDeliveryStatusUpdate(prisma, publishCompleted, {
        // Ищем по НАШЕМУ id: метка Burq здесь не нужна и может отсутствовать — ровно в этом
        // и была причина, по которой доставка оставалась немой.
        deliveryId: delivery.id,
        rawStatus: o.status,
        source: "POLLING",
        courierName: o.courierName ?? null,
        courierPhone: o.courierPhone ?? null,
        trackingUrl: o.trackingUrl ?? null,
      });
      if (res.outcome === "applied") {
        updated += 1;
        // Доставлено — сразу тянем фото: на этом пути webhook его не принесёт.
        if (res.delivered) await refetchPodForDelivery(prisma, delivery.id).catch(() => undefined);
      }
    } catch {
      // Одна недоступная доставка не должна ронять проход: остальные важнее.
      failed += 1;
    }
  }

  return { scanned: open.length, updated, failed };
}
