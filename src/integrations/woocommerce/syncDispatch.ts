import "server-only";
/**
 * Постановка задач синхронизации WooCommerce в outbox и их обработка в worker'е (а НЕ внутри
 * HTTP-запроса страницы). UI-кнопки только ставят событие; тяжёлый импорт выполняет worker.
 */
import { prisma } from "@/lib/db";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { syncProducts } from "@/modules/catalog/sync";
import { syncWooOrders } from "./orderSync";

export type WooSyncKind = "PRODUCTS" | "ORDERS";

/**
 * Ставит задачу синхронизации в outbox. `fullHistory` (только для ORDERS) — импорт всей истории
 * с игнорированием watermark (по явному подтверждению «Полной синхронизации»). Возвращает true,
 * если событие создано.
 */
export async function enqueueWooSync(siteId: string, kind: WooSyncKind, opts: { fullHistory?: boolean } = {}): Promise<boolean> {
  const repo = new PrismaOutboxRepository(prisma);
  const full = kind === "ORDERS" && !!opts.fullHistory;
  const { created } = await repo.enqueue({
    eventType: "woo.sync.requested",
    aggregateType: "site",
    aggregateId: siteId,
    payload: { siteId, kind, fullHistory: full },
    // Уникальный ключ на запуск (минутное окно) — не плодим дубли при быстрых повторных кликах,
    // но разрешаем повторную синхронизацию позже. Параллельный запуск гасит RUNNING-guard в sync.
    // full в ключе — чтобы «полная» и обычная синхронизация в одну минуту не схлопнулись в одну.
    idempotencyKey: `woo:sync:${siteId}:${kind}:${full ? "full" : "inc"}:${Math.floor(Date.now() / 60000)}`,
  });
  return created;
}

export function buildWooSyncHandler(): OutboxHandler {
  return async (record: OutboxRecord) => {
    const { siteId, kind, fullHistory } = (record.payload ?? {}) as { siteId?: string; kind?: WooSyncKind; fullHistory?: boolean };
    if (!siteId || !kind) return;
    if (kind === "PRODUCTS") {
      await syncProducts(siteId); // общий движок каталога (адаптер Woo); окна нет — все товары
      await prisma.wooCommerceConnection.update({ where: { siteId }, data: { lastProductSyncAt: new Date() } }).catch(() => {});
    } else if (kind === "ORDERS") {
      await syncWooOrders(siteId, { fullHistory: !!fullHistory });
    }
  };
}
