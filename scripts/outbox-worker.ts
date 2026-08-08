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
import { buildWooStatusPushHandler } from "@/integrations/woocommerce/statusPushHandler";
import { WOO_STATUS_PUSH_EVENT } from "@/integrations/woocommerce/statusPushEvents";
import { buildBurqDraftCreateHandler } from "@/integrations/delivery/burq/outboxHandler";
import { BURQ_DRAFT_CREATE_EVENT } from "@/integrations/delivery/burq/schedule";
import { buildBurqWebhookHandler, BURQ_WEBHOOK_EVENT } from "@/integrations/delivery/burq/webhookHandler";
import { buildBurqPodRefetchHandler, BURQ_POD_REFETCH_EVENT } from "@/integrations/delivery/burq/podService";
import { buildQuoWebhookHandler, QUO_WEBHOOK_EVENT } from "@/integrations/quo/webhookHandler";
import { buildAutomationTriggerHandler, buildAutomationSendHandler } from "@/modules/automations/handlers";
import { AUTOMATION_TRIGGER_EVENT, AUTOMATION_SEND_EVENT } from "@/modules/automations/events";
import { buildFlowStepHandler } from "@/modules/automations/flows/handler";
import { FLOW_STEP_EVENT } from "@/modules/automations/flows/events";
import { buildTelegramNotifyHandler } from "@/integrations/telegram/handler";
import { buildDeadLetterAlert } from "@/integrations/telegram/deadLetterAlert";
import { TELEGRAM_NOTIFY_EVENT } from "@/integrations/telegram/events";
import { buildAirwallexVerifyHandler } from "@/integrations/airwallex/handler";
import { AIRWALLEX_VERIFY_EVENT } from "@/integrations/airwallex/events";
import { dispatchAirwallexChecks } from "@/integrations/airwallex/dispatcher";
import { primaryShareGate } from "@/modules/finance/config";
import { dispatchPrimaryShare } from "@/modules/finance/shareDispatcher";
import { createSmsChannelSender } from "@/modules/automations/channels/sms";
import { createEmailChannelSender } from "@/modules/automations/channels/email";
import { getQuoConfig } from "@/integrations/quo/config";
import { createQuoClient } from "@/integrations/quo/client";
import { reconcileBurqSchedules } from "@/integrations/delivery/burq/recovery";
import { syncOpenDeliveryStatuses } from "@/integrations/delivery/burq/statusSync";
import { isBurqRuntimeEnabled, featureFlags } from "@/lib/featureFlags";
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

  // Каналы автоматизаций — ОДИН реестр на одиночные правила и на цепочки: «как отправить»
  // не должно разъезжаться между ними.
  const automationChannels = {
    SMS: createSmsChannelSender(() => {
      const cfg = getQuoConfig();
      return cfg && featureFlags.quo ? createQuoClient({ ...cfg, maxRetries: 0 }) : null;
    }),
    EMAIL: createEmailChannelSender(prisma),
  };

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
    // WooCommerce: единственная запись Floremart в чужой заказ — перевод в `processing` после
    // подтверждения оплаты мониторингом Airwallex (под галочкой сайта).
    [WOO_STATUS_PUSH_EVENT]: buildWooStatusPushHandler(prisma),
    // Burq: отложенное автосоздание черновика доставки (draft-first). Реальные вызовы Burq
    // включаются только при BURQ_ENABLED + креды; иначе mock-клиент (sandbox-gate).
    [BURQ_DRAFT_CREATE_EVENT]: buildBurqDraftCreateHandler(prisma, (event, extra) => log(event, extra)),
    // Burq: приём статус-событий доставки из webhook (anti-rollback, publish completed на DELIVERED).
    [BURQ_WEBHOOK_EVENT]: buildBurqWebhookHandler(prisma),
    // Burq: отложенный ОДНОразовый refetch Proof of Delivery (delivered без фото).
    [BURQ_POD_REFETCH_EVENT]: buildBurqPodRefetchHandler(prisma),
    // QUO (ex-OpenPhone): обработка проверенного webhook-события → OrderCommunication + привязка.
    [QUO_WEBHOOK_EVENT]: buildQuoWebhookHandler(prisma),
    // Automation Engine: событие заказа → создать job'ы под активные правила Site (отложенно),
    // затем отправка job'а в канал и шаги цепочек. Без этих трёх строк любое событие
    // автоматизаций уходит в DEAD_LETTER с «no handler», и авто-SMS молча не отправляются.
    [AUTOMATION_TRIGGER_EVENT]: buildAutomationTriggerHandler(prisma),
    [AUTOMATION_SEND_EVENT]: buildAutomationSendHandler(prisma, { channels: automationChannels }),
    [FLOW_STEP_EVENT]: buildFlowStepHandler(prisma, { channels: automationChannels }),
    // Внутренние Telegram-уведомления сотрудникам: один обработчик на все типы событий.
    [TELEGRAM_NOTIFY_EVENT]: buildTelegramNotifyHandler(prisma),
    // Сверка платежа с Airwallex (режим наблюдения: business status заказа не меняется).
    [AIRWALLEX_VERIFY_EVENT]: buildAirwallexVerifyHandler(prisma),
  };

  const worker = new OutboxWorker({
    repo,
    handlers,
    logger: new OutboxLogger(),
    // Потеря события больше не проходит молча — владельцу уходит сигнал в Telegram.
    onDeadLetter: buildDeadLetterAlert(prisma),
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

  // Опрос статусов открытых доставок. Webhook — основной канал и быстрее, но он находит
  // доставку по НАШЕЙ метке, а у заведённой руками в кабинете Burq её нет: событие приходит
  // и выбрасывается. Опрос спрашивает Burq по ЕГО номеру заказа — тем же путём, что кнопка
  // «обновить фото», которая работает всегда. Закрывает и ручные доставки, и потерянные
  // события, и молчание приёмника.
  const burqStatusMs = Number(process.env.BURQ_STATUS_SYNC_MS ?? 600_000); // 10 мин
  const burqStatusTimer = isBurqRuntimeEnabled()
    ? setInterval(() => {
        if (shuttingDown) return;
        syncOpenDeliveryStatuses(prisma)
          .then((r) => { if (r.scanned > 0) log("burq.status.sync.tick", r); })
          .catch((err) => log("burq.status.sync.error", { error: err instanceof Error ? err.message : String(err) }));
      }, burqStatusMs)
    : null;
  burqStatusTimer?.unref?.();
  log(burqStatusTimer ? "burq.status.sync.enabled" : "burq.status.sync.disabled", { intervalMs: burqStatusTimer ? burqStatusMs : undefined });

  // Диспетчер Airwallex: один индексированный SELECT раз в 5 минут, LIMIT 50, задачи — в outbox.
  // Отдельного планировщика нет. Выключается флагом AIRWALLEX_MONITORING_ENABLED=false.
  const awMs = Number(process.env.AIRWALLEX_DISPATCH_MS ?? 300_000); // 5 мин
  const awTimer = process.env.AIRWALLEX_MONITORING_ENABLED === "true"
    ? setInterval(() => {
        if (shuttingDown) return;
        dispatchAirwallexChecks(prisma)
          .then((r) => { if (r.selected > 0) log("airwallex.dispatch.tick", r); })
          .catch((err) => log("airwallex.dispatch.error", { error: err instanceof Error ? err.message : String(err) }));
      }, awMs)
    : null;
  awTimer?.unref?.();
  log(awTimer ? "airwallex.dispatch.enabled" : "airwallex.dispatch.disabled", { intervalMs: awTimer ? awMs : undefined });

  // Диспетчер начислений флористам: один индексированный SELECT раз в 10 минут, LIMIT 100,
  // задачи — в тот же outbox. Гейт двойной (флаг + дата старта), при закрытом гейте интервал
  // не запускается вовсе — деплой сам по себе не начисляет ничего.

  // Доля основного флориста: пересчёт итогов дней начиная с даты запуска. Долг выводится
  // из этих итогов и денег не переводит — реальная выплата только вручную от владельца,
  // поэтому автоматический пересчёт ничего не может «заплатить» по ошибке.
  const shareGate = primaryShareGate();
  const shareMs = Number(process.env.FINANCE_SHARE_DISPATCH_MS ?? 900_000); // 15 мин
  const shareTimer = shareGate.enabled
    ? setInterval(() => {
        if (shuttingDown) return;
        dispatchPrimaryShare(prisma)
          .then((r) => { if (r.days > 0) log("finance.share.tick", r); })
          .catch((err) => log("finance.share.error", { error: err instanceof Error ? err.message : String(err) }));
      }, shareMs)
    : null;
  shareTimer?.unref?.();
  if (shareTimer) log("finance.share.enabled", { intervalMs: shareMs });
  else log("finance.share.disabled", { reason: shareGate.enabled ? "unknown" : shareGate.reason });

  log("worker.started", { workerId: worker.id });
  try {
    await worker.start(); // блокирует до stop()
  } finally {
    if (reconcileTimer) clearInterval(reconcileTimer);
    if (awTimer) clearInterval(awTimer);
    if (shareTimer) clearInterval(shareTimer);
    await prisma.$disconnect();
    log("worker.stopped", { workerId: worker.id });
  }
}

main().catch((err) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", event: "worker.fatal", error: err instanceof Error ? err.message : String(err) }));
  process.exit(1);
});
