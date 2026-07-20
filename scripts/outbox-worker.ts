import "dotenv/config";
/**
 * Точка входа outbox-worker'а — ОТДЕЛЬНЫЙ процесс (PM2: floremart-worker), НЕ внутри Next.js.
 *
 * Запуск локально:
 *   NODE_OPTIONS=--conditions=react-server DATABASE_URL=... tsx scripts/outbox-worker.ts
 * (или `npm run worker`). Условие react-server нужно, чтобы `server-only`-модули (Prisma-слой)
 * резолвились как обычные серверные — так же, как в существующих скриптах проекта.
 *
 * ВНИМАНИЕ: требует применённой миграции 20260718040000_outbox_events (в этой сессии НЕ
 * применяется). Провайдеры сообщений — MOCK (реальные Quo/Telegram/SMTP/WebPush подключаются
 * позже за фиче-флагами). Completion-sync во внешние платформы — placeholder (без сетевых вызовов).
 */
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { PrismaProcessedOperationStore } from "@/outbox/prismaProcessedOperations";
import { OutboxWorker, type OutboxHandler } from "@/outbox/worker";
import { OutboxLogger } from "@/outbox/logger";
import { buildDeliveryCompletedHandler } from "@/outbox/handlers";
import { createDeliveryResolver } from "@/outbox/deliveryResolver";
import { buildShopifyWebhookHandler } from "@/integrations/shopify/customApp/webhookHandler";
import { shopifyWebhookHandlerDeps } from "@/integrations/shopify/customApp/webhookHandlerDeps";
import { buildWooWebhookHandler } from "@/integrations/woocommerce/webhookHandler";
import { buildWooSyncHandler } from "@/integrations/woocommerce/syncDispatch";
import { buildBurqDraftCreateHandler } from "@/integrations/delivery/burq/outboxHandler";
import { BURQ_DRAFT_CREATE_EVENT } from "@/integrations/delivery/burq/schedule";
import { buildBurqWebhookHandler, BURQ_WEBHOOK_EVENT } from "@/integrations/delivery/burq/webhookHandler";
import { buildBurqPodRefetchHandler, BURQ_POD_REFETCH_EVENT } from "@/integrations/delivery/burq/podService";
import { buildQuoWebhookHandler, QUO_WEBHOOK_EVENT } from "@/integrations/quo/webhookHandler";
import { reconcileBurqSchedules } from "@/integrations/delivery/burq/recovery";
import { isBurqRuntimeEnabled } from "@/lib/featureFlags";
import { MessagingService } from "@/messaging/service";
import { createMockProviders } from "@/messaging/providers/mock";

function log(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", event, ...extra }));
}

async function main() {
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  const repo = new PrismaOutboxRepository(prisma);
  const idempotency = new PrismaProcessedOperationStore(prisma);

  // Mock-провайдеры: реального сетевого вызова нет. Реальные — за фиче-флагами (follow-up).
  const providers = createMockProviders();
  const messaging = new MessagingService()
    .register(providers.SMS)
    .register(providers.EMAIL)
    .register(providers.TELEGRAM)
    .register(providers.PUSH);

  const handlers: Record<string, OutboxHandler> = {
    "order.delivery.completed": buildDeliveryCompletedHandler({
      messaging,
      idempotency,
      resolve: createDeliveryResolver(prisma),
      // Completion-sync в Shopify/Woo — реальный внешний вызов; здесь placeholder (без сети).
      completionSync: async (orderId: string) => {
        log("completion_sync.placeholder", { orderId });
      },
    }),
    // Shopify Custom App: приём заказов/товаров/событий приложения из webhook (per-Site credentials).
    "shopify.webhook.received": buildShopifyWebhookHandler(shopifyWebhookHandlerDeps),
    // WooCommerce: приём заказов/товаров из webhook и фоновая синхронизация (per-Site credentials).
    "woo.webhook.received": buildWooWebhookHandler(),
    "woo.sync.requested": buildWooSyncHandler(),
    // Burq: отложенное автосоздание черновика доставки (draft-first). Реальные вызовы Burq
    // включаются только при BURQ_ENABLED + креды; иначе mock-клиент (sandbox-gate).
    [BURQ_DRAFT_CREATE_EVENT]: buildBurqDraftCreateHandler(prisma, (event, extra) => log(event, extra)),
    // Burq: приём статус-событий доставки из webhook (anti-rollback, publish completed на DELIVERED).
    [BURQ_WEBHOOK_EVENT]: buildBurqWebhookHandler(prisma),
    // Burq: отложенный ОДНОразовый refetch Proof of Delivery (delivered без фото).
    [BURQ_POD_REFETCH_EVENT]: buildBurqPodRefetchHandler(prisma),
    // QUO (ex-OpenPhone): обработка проверенного webhook-события → OrderCommunication + привязка.
    [QUO_WEBHOOK_EVENT]: buildQuoWebhookHandler(prisma),
  };

  const worker = new OutboxWorker({
    repo,
    handlers,
    logger: new OutboxLogger(),
    workerId: process.env.WORKER_ID,
    policy: {
      batchSize: Number(process.env.OUTBOX_BATCH_SIZE ?? 20),
      pollIntervalMs: Number(process.env.OUTBOX_POLL_MS ?? 1000),
      stuckAfterMs: Number(process.env.OUTBOX_STUCK_MS ?? 60000),
    },
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("worker.shutdown.requested", { signal, workerId: worker.id });
    worker.stop(); // graceful: текущий батч доводится, цикл завершается
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  // Реконсиляция Burq-расписаний — редкая самостраховка (потерянный enqueue). НЕ основной
  // механизм и НЕ вызывает Burq API: только пере-ставит потерянные задачи в outbox.
  // Master gate: при выключенном BURQ_RUNTIME_ENABLED интервал НЕ запускается вовсе.
  const reconcileMs = Number(process.env.BURQ_RECONCILE_MS ?? 3_600_000); // 1ч по умолчанию
  const reconcileTimer = isBurqRuntimeEnabled()
    ? setInterval(() => {
        if (shuttingDown) return;
        reconcileBurqSchedules(prisma)
          .then((r) => log("burq.reconcile.tick", r))
          .catch((err) => log("burq.reconcile.error", { error: err instanceof Error ? err.message : String(err) }));
      }, reconcileMs)
      : null;
  reconcileTimer?.unref?.();
  if (reconcileTimer) log("burq.reconcile.enabled", { intervalMs: reconcileMs });
  else log("burq.reconcile.disabled", { reason: "BURQ_RUNTIME_ENABLED=false" });

  log("worker.started", { workerId: worker.id });
  try {
    await worker.start(); // блокирует до stop()
  } finally {
    if (reconcileTimer) clearInterval(reconcileTimer);
    await prisma.$disconnect();
    log("worker.stopped", { workerId: worker.id });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "worker.fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
