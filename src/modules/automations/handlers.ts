import "server-only";
/**
 * Outbox-handler'ы Automation Engine. Два этапа, оба через существующий durable outbox:
 *
 *  1) sms.automation.trigger → для Site находим активные правила под triggerType, проверяем
 *     условия, разворачиваем аудиторию в адресатов ПО КАЖДОМУ включённому каналу (SMS/EMAIL),
 *     создаём AutomationJob (идемпотентно, ключ включает канал) и публикуем отложенный
 *     sms.automation.send (availableAt = scheduledAt). Адресаты SMS планируются СРАЗУ ПО ВСЕМ
 *     правилам события (`planSmsRecipients`): на один телефон уходит не больше одной SMS, при
 *     споре за номер выигрывает версия заказчика — см. audience.ts.
 *
 *  2) sms.automation.send → берём due job, ПОВТОРНО проверяем на свежих данных (kill switch,
 *     правило/Site активны, заказ не отменён, обязательные переменные есть), рендерим (SMS) или
 *     собираем params (EMAIL) по свежим данным и отправляем через ChannelSender job.channel.
 *     Если SMS-job окончательно провалился (все retry исчерпаны) и у правила включён
 *     «Email, если SMS недоступно» (а «обычный» Email отдельно не включён — иначе дублирование),
 *     здесь же реактивно создаётся EMAIL-fallback-job.
 *
 * Тот же trigger-обработчик стартует ЦЕПОЧКИ (Automation Flows) — отдельной ветвью в конце,
 * на своих моделях и со своим outbox-событием (см. flows/). Одиночные правила это не меняет.
 *
 * Канал-агностично: движок знает про «кому/что», а «как отправить» — в ChannelSender. Реальная
 * отправка НЕ дублируется: sendOrderSms/Brevo дедуплицируют по идемпотентности (движок формирует
 * ключ per-attempt). Журнал выполнения ведётся ТОЛЬКО для реально созданных Job.
 *
 * Идемпотентность с каналом: ключ job'а — `${automationId}:${orderId}:${recipientType}:
 * ${occurrenceKey}:${channel}`. Так для одного события у одного правила возможен и SMS-job, и
 * EMAIL-job одновременно (разные ключи), но НЕ два EMAIL-job'а («обычный» и fallback конкурируют
 * за один и тот же ключ — создание fallback пропускается, если «обычный» Email уже включён).
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationSend, type AutomationTriggerPayload, type AutomationSendPayload } from "./events";
import { getSmsTrigger } from "./triggers";
import { evaluateConditions, type SmsConditions } from "./conditions";
import { isDeliveryToday } from "./dailySchedule";
import { planSmsRecipients, DUPLICATE_PHONE_REASON, DUPLICATE_EMAIL_REASON, type SmsAudience, type SmsRecipientType } from "./audience";
import { resolveCustomerEmail } from "./emailAudience";
import { computeScheduledAt, type SmsDelayUnit } from "./delay";
import { buildOrderVariables } from "./variables";
import { renderTemplate, extractVariables } from "./template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";
import { isAutomationsGloballyDisabled } from "./settings";
import { logExecution } from "./executionLog";
import { startFlowsForTrigger } from "./flows/engine";
import type { ChannelSender } from "./channels/types";
import { SMS_UNAVAILABLE_CODES } from "./channels/sms";

/** Триггеры, для которых заказ ИМЕННО отменён/возвращён — дефолтное исключение не применяем. */
const ALLOW_CANCELLED_REFUNDED = new Set(["ORDER_REFUNDED", "PAYMENT_FAILED", "ORDER_CANCELLED"]);

function isP2002(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

/** `automationId:orderId:recipientType:occurrenceKey:channel` — единый формат ключа для всех job'ов. */
function jobIdempotencyKey(automationId: string, orderId: string, recipientType: string, occurrenceKey: string, channel: string): string {
  return `${automationId}:${orderId}:${recipientType}:${occurrenceKey}:${channel}`;
}

/**
 * Идемпотентно создаёт AutomationJob (SCHEDULED или SKIPPED) и, если он реально новый и
 * SCHEDULED, публикует отложенную отправку. При гонке (P2002) находит уже существующий job по
 * тому же ключу и ничего не дублирует. Общий примитив для обычного trigger-flow и для реактивного
 * Email-fallback (создаётся на SEND-стадии при финальном провале SMS).
 */
async function createOrFindJob(
  prisma: PrismaClient,
  repo: PrismaOutboxRepository,
  data: {
    automationId: string;
    orderId: string;
    recipientType: SmsRecipientType;
    channel: "SMS" | "EMAIL";
    phoneNormalized: string | null;
    emailNormalized: string | null;
    occurrenceKey: string;
    scheduledAt: Date;
    status: "SCHEDULED" | "SKIPPED";
    lastErrorSafe?: string;
    logDetail: string;
  }
): Promise<void> {
  const idempotencyKey = jobIdempotencyKey(data.automationId, data.orderId, data.recipientType, data.occurrenceKey, data.channel);
  const now = new Date();
  let jobId: string | null = null;
  let created = false;
  try {
    const job = await prisma.automationJob.create({
      data: {
        automationId: data.automationId,
        orderId: data.orderId,
        recipientType: data.recipientType,
        channel: data.channel,
        phoneNormalized: data.phoneNormalized,
        emailNormalized: data.emailNormalized,
        occurrenceKey: data.occurrenceKey,
        scheduledAt: data.scheduledAt,
        status: data.status,
        ...(data.status === "SKIPPED" ? { skippedAt: now, lastErrorSafe: data.lastErrorSafe } : {}),
        idempotencyKey,
      },
      select: { id: true },
    });
    jobId = job.id;
    created = true;
  } catch (err) {
    if (isP2002(err)) {
      const existing = await prisma.automationJob.findUnique({ where: { idempotencyKey }, select: { id: true } });
      jobId = existing?.id ?? null;
    } else {
      throw err;
    }
  }
  if (!jobId) return;
  if (created) {
    await logExecution(prisma, {
      jobId,
      automationId: data.automationId,
      orderId: data.orderId,
      stage: data.status === "SKIPPED" ? "skipped" : "scheduled",
      detailSafe: data.status === "SKIPPED" ? (data.lastErrorSafe ?? null) : data.logDetail,
    });
  }
  if (data.status === "SCHEDULED") {
    await publishAutomationSend(repo, { jobId, orderId: data.orderId }, data.scheduledAt);
  }
}

/** Создаёт (или находит) EMAIL-job для CUSTOMER — обычный или fallback, реактивно или на триггере. */
async function createCustomerEmailJob(
  prisma: PrismaClient,
  repo: PrismaOutboxRepository,
  args: { automationId: string; orderId: string; occurrenceKey: string; senderEmail: string | null; scheduledAt: Date; logDetail: string }
): Promise<void> {
  const res = resolveCustomerEmail({ senderEmail: args.senderEmail });
  if (!res.ok) {
    await createOrFindJob(prisma, repo, {
      automationId: args.automationId,
      orderId: args.orderId,
      recipientType: "CUSTOMER",
      channel: "EMAIL",
      phoneNormalized: null,
      emailNormalized: null,
      occurrenceKey: args.occurrenceKey,
      scheduledAt: args.scheduledAt,
      status: "SKIPPED",
      lastErrorSafe: res.skipped.reason,
      logDetail: args.logDetail,
    });
    return;
  }
  await createOrFindJob(prisma, repo, {
    automationId: args.automationId,
    orderId: args.orderId,
    recipientType: "CUSTOMER",
    channel: "EMAIL",
    phoneNormalized: null,
    emailNormalized: res.recipient.emailNormalized,
    occurrenceKey: args.occurrenceKey,
    scheduledAt: args.scheduledAt,
    status: "SCHEDULED",
    logDetail: args.logDetail,
  });
}

/**
 * Подстраховка дедупа: правило, погашенное как DUPLICATE_PHONE, оживает, если ВЫИГРАВШЕЕ правило
 * так и не отправило сообщение (пропуск на свежих проверках или терминальный провал). Без этого
 * дедуп превращал одну осечку в полное молчание: человек не получал ни одной версии.
 *
 * Оживление безопасно по построению: job возвращается в SCHEDULED и проходит send-обработчик
 * заново, со ВСЕМИ проверками (рубильник, активность правила, магазин, условия). Поэтому здесь
 * не нужен разбор причины провала — «разбудить нельзя, потому что нельзя отправлять» решается на
 * общем пути. Единственное исключение — глобальный рубильник: будить соседей, когда всё
 * выключено, бессмысленно.
 *
 * Цикл невозможен: оживлённый job перестаёт быть SKIPPED/DUPLICATE_PHONE и вторым поиском уже не
 * находится, а число правил события конечно.
 */
async function reviveDuplicateSibling(
  prisma: PrismaClient,
  repo: PrismaOutboxRepository,
  job: { id: string; orderId: string; occurrenceKey: string | null; phoneNormalized: string | null; channel: string }
): Promise<void> {
  if (job.channel !== "SMS" || !job.occurrenceKey || !job.phoneNormalized) return;

  const sibling = await prisma.automationJob.findFirst({
    where: {
      orderId: job.orderId,
      occurrenceKey: job.occurrenceKey,
      channel: "SMS",
      status: "SKIPPED",
      lastErrorSafe: DUPLICATE_PHONE_REASON,
      phoneNormalized: job.phoneNormalized,
      id: { not: job.id },
    },
    orderBy: { createdAt: "asc" },
    select: { id: true, automationId: true },
  });
  if (!sibling) return;

  // Условный апдейт вместо update(): два воркера могут добраться сюда одновременно, и оживить
  // соседа должен ровно один — иначе send-событие опубликуется дважды.
  const revived = await prisma.automationJob.updateMany({
    where: { id: sibling.id, status: "SKIPPED", lastErrorSafe: DUPLICATE_PHONE_REASON },
    data: { status: "SCHEDULED", skippedAt: null, lastErrorSafe: null, scheduledAt: new Date() },
  });
  if (revived.count === 0) return;

  await logExecution(prisma, {
    jobId: sibling.id,
    automationId: sibling.automationId,
    orderId: job.orderId,
    stage: "scheduled",
    detailSafe: "revived_after_winner_did_not_send",
  });
  await publishAutomationSend(repo, { jobId: sibling.id, orderId: job.orderId }, new Date());
}

// ─────────────────────────────  ЭТАП 1: TRIGGER → JOBS  ─────────────────────────────

export function buildAutomationTriggerHandler(prisma: PrismaClient): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as AutomationTriggerPayload;
    if (!p?.orderId || !p?.siteId || !p?.triggerType || !p?.occurrenceKey) return;

    // Global kill switch: новые job'ы не создаём вовсе.
    if (await isAutomationsGloballyDisabled(prisma)) return;

    // Правило может быть привязано к нескольким Site — выбираем по связи AutomationSite.
    // Цепочки (Automation Flows) отбираются по тем же признакам, но живут в своих моделях:
    // одиночные правила и цепочки не влияют друг на друга.
    const [automations, flows] = await Promise.all([
      prisma.automation.findMany({
        where: { sites: { some: { siteId: p.siteId } }, triggerType: p.triggerType, active: true, deletedAt: null },
      }),
      prisma.automationFlow.findMany({
        where: { sites: { some: { siteId: p.siteId } }, triggerType: p.triggerType, active: true, deletedAt: null },
        include: { steps: { orderBy: { position: "asc" } } },
      }),
    ]);
    if (automations.length === 0 && flows.length === 0) return;

    const order = await prisma.order.findUnique({ where: { id: p.orderId }, include: SMS_ORDER_INCLUDE });
    if (!order) return; // заказ исчез — планировать нечего

    const now = new Date();

    // Задача «доставка сегодня» ставится заранее; к моменту срабатывания дату могли перенести.
    if (p.triggerType === "DELIVERY_TODAY" && !isDeliveryToday(order.deliveryDate, order.site.timezone, now)) return;

    // Условия проверяем ДО планирования адресатов: правило, не прошедшее условие, не должно
    // занимать телефон и лишать сообщения то правило, которое реально сработало.
    const eligible = automations.filter(
      (a) =>
        evaluateConditions(a.conditionsJson as SmsConditions | null, {
          orderStatus: order.orderStatus,
          paymentStatus: order.paymentStatus,
          deliveryDate: order.deliveryDate,
          apartment: order.apartment,
          timezone: order.site.timezone,
          allowCancelledRefunded: ALLOW_CANCELLED_REFUNDED.has(p.triggerType),
          now,
        }).ok
    );

    // Один телефон — одна SMS на событие, даже если правил несколько (заказчику и получателю).
    // При споре за номер выигрывает версия заказчика; проигравшее правило получает SKIPPED-job.
    const smsPlans = planSmsRecipients(
      eligible.filter((a) => a.smsEnabled).map((a) => ({ id: a.id, audience: a.audience as SmsAudience })),
      { senderPhone: order.senderPhone, recipientPhone: order.recipientPhone }
    );

    // То же правило для Email. Адрес у письма всегда ОДИН — заказчика (получательского email в
    // заказе нет), поэтому правило «Получателю» с включённым Email пишет тому же человеку, что и
    // правило «Заказчику». Если письмо заказчику по этому событию уже создаётся, второе гасим.
    const customerEmailTaken =
      resolveCustomerEmail({ senderEmail: order.senderEmail }).ok &&
      eligible.some((a) => a.audience !== "RECIPIENT" && a.emailEnabled);

    for (const a of eligible) {
      const emailIsDuplicate = customerEmailTaken && a.audience === "RECIPIENT";
      const scheduledAt = computeScheduledAt(now, a.delayAmount, a.delayUnit as SmsDelayUnit);

      // ── SMS ──
      const plan = smsPlans.get(a.id);
      if (a.smsEnabled && plan) {
        const { recipients, duplicates, skipped } = plan;

        for (const r of recipients) {
          await createOrFindJob(prisma, repo, {
            automationId: a.id,
            orderId: p.orderId,
            recipientType: r.recipientType,
            channel: "SMS",
            phoneNormalized: r.phoneNormalized,
            emailNormalized: null,
            occurrenceKey: p.occurrenceKey,
            scheduledAt,
            status: "SCHEDULED",
            logDetail: `channel=SMS recipient=${r.recipientType}`,
          });
        }

        // Номер уже занят более приоритетным правилом события — фиксируем SKIPPED-job, чтобы в
        // истории было видно, ПОЧЕМУ правило промолчало. Email-fallback тут не нужен: человек
        // уже получит SMS от выигравшего правила, это не «не смогли доставить».
        for (const d of duplicates) {
          await createOrFindJob(prisma, repo, {
            automationId: a.id,
            orderId: p.orderId,
            recipientType: d.recipientType,
            channel: "SMS",
            phoneNormalized: d.phoneNormalized,
            emailNormalized: null,
            occurrenceKey: p.occurrenceKey,
            scheduledAt: now,
            status: "SKIPPED",
            lastErrorSafe: DUPLICATE_PHONE_REASON,
            logDetail: "",
          });
        }

        // Адресаты без валидного телефона — фиксируем SKIPPED-job для видимости (идемпотентно).
        for (const sk of skipped) {
          await createOrFindJob(prisma, repo, {
            automationId: a.id,
            orderId: p.orderId,
            recipientType: sk.recipientType,
            channel: "SMS",
            phoneNormalized: null,
            emailNormalized: null,
            occurrenceKey: p.occurrenceKey,
            scheduledAt: now,
            status: "SKIPPED",
            lastErrorSafe: sk.reason,
            logDetail: "",
          });

          // Fallback: телефон отсутствует/некорректен → сразу Email (если разрешено и «обычный»
          // Email не включён отдельно — иначе он и так будет запланирован ниже, дублировать не надо).
          // Если письмо заказчику уже создаёт другое правило события — молчим по той же причине.
          if (a.emailFallbackEnabled && !a.emailEnabled && !emailIsDuplicate) {
            await createCustomerEmailJob(prisma, repo, {
              automationId: a.id,
              orderId: p.orderId,
              occurrenceKey: p.occurrenceKey,
              senderEmail: order.senderEmail,
              scheduledAt: now,
              logDetail: `channel=EMAIL recipient=CUSTOMER fallback_reason=${sk.reason}`,
            });
          }
        }
      }

      // ── EMAIL (обычный, независимо от SMS) ──
      if (a.emailEnabled) {
        if (emailIsDuplicate) {
          // Письмо тому же заказчику уже создаёт правило, нацеленное на него. Фиксируем SKIPPED,
          // чтобы в истории было видно, почему правило «Получателю» промолчало по Email.
          await createOrFindJob(prisma, repo, {
            automationId: a.id,
            orderId: p.orderId,
            recipientType: "CUSTOMER",
            channel: "EMAIL",
            phoneNormalized: null,
            emailNormalized: null,
            occurrenceKey: p.occurrenceKey,
            scheduledAt: now,
            status: "SKIPPED",
            lastErrorSafe: DUPLICATE_EMAIL_REASON,
            logDetail: "",
          });
        } else {
          await createCustomerEmailJob(prisma, repo, {
            automationId: a.id,
            orderId: p.orderId,
            occurrenceKey: p.occurrenceKey,
            senderEmail: order.senderEmail,
            scheduledAt,
            logDetail: "channel=EMAIL recipient=CUSTOMER",
          });
        }
      }
    }

    // Цепочки — отдельной ветвью, ПОСЛЕ одиночных правил: свой eventType, свои модели,
    // на поведение правил выше не влияет. Условия правил к цепочкам не применяются
    // (у цепочек их нет), проверка «отменён/возвращён» делается при выполнении шага.
    await startFlowsForTrigger(prisma, repo, { flows, orderId: p.orderId, siteId: p.siteId, now });
  };
}

// ─────────────────────────────  ЭТАП 2: SEND JOB  ─────────────────────────────

export type AutomationSendDeps = {
  /** Реестр каналов: channel → ChannelSender. Неизвестный канал → job SKIPPED. */
  channels: Record<string, ChannelSender>;
};

export function buildAutomationSendHandler(prisma: PrismaClient, deps: AutomationSendDeps): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as AutomationSendPayload;
    if (!p?.jobId) return;

    const job = await prisma.automationJob.findUnique({
      where: { id: p.jobId },
      include: { automation: true, order: { include: SMS_ORDER_INCLUDE } },
    });
    if (!job) return; // job исчез
    if (job.status !== "SCHEDULED") return; // уже отправлен/пропущен/отменён — идемпотентно выходим

    const automation = job.automation;
    const order = job.order;
    const site = order.site;

    await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "picked" });

    // reviveSibling=false только там, где отправка запрещена глобально: будить погашенное дедупом
    // правило незачем, оно упрётся в тот же запрет.
    const skip = async (reason: string, { reviveSibling = true }: { reviveSibling?: boolean } = {}) => {
      await prisma.automationJob.update({ where: { id: job.id }, data: { status: "SKIPPED", skippedAt: new Date(), lastErrorSafe: reason } });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "skipped", detailSafe: reason });
      if (reviveSibling) await reviveDuplicateSibling(prisma, repo, job);
    };

    // Global kill switch: уже запланированный job при включённом рубильнике не отправляем.
    if (await isAutomationsGloballyDisabled(prisma)) return skip("global_kill_switch", { reviveSibling: false });

    // Повторные проверки на СВЕЖИХ данных.
    if (!automation.active) return skip("automation_disabled");
    if (automation.deletedAt) return skip("automation_deleted");

    // Набор магазинов правила мог измениться, пока job ждал отправки: магазин заказа могли отвязать.
    const stillLinked = await prisma.automationSite.findUnique({
      where: { automationId_siteId: { automationId: automation.id, siteId: site.id } },
      select: { siteId: true },
    });
    if (!stillLinked) return skip("automation_not_enabled_for_site");

    const cond = evaluateConditions(automation.conditionsJson as SmsConditions | null, {
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      deliveryDate: order.deliveryDate,
      apartment: order.apartment,
      timezone: site.timezone,
      allowCancelledRefunded: ALLOW_CANCELLED_REFUNDED.has(automation.triggerType),
    });
    if (!cond.ok) return skip(cond.skipReason);

    // Канал: резолвим отправителя ПО ЭТОМУ job'у (не по automation.channel — правило может
    // одновременно породить и SMS-job, и EMAIL-job). Неизвестный/неподдержанный канал → SKIP.
    const sender = deps.channels[job.channel];
    if (!sender) return skip(`unsupported_channel:${job.channel}`);

    // Рендер по свежим данным.
    const vars = buildOrderVariables(orderToVariableSource(order));
    const trigger = getSmsTrigger(automation.triggerType);

    // Гейтинг обязательных переменных — общий для ЛЮБОГО канала (иначе не отправляем): без
    // реального трека TRACKING-письмо/SMS одинаково бессмысленны обоим каналам.
    for (const key of trigger?.requiredVars ?? []) {
      if (!vars[key]) return skip(`missing_required_variable:${key}`);
    }

    let text = "";
    if (job.channel === "SMS") {
      const referenced = new Set(extractVariables(automation.template));
      if (referenced.has("review_url") && !vars["review_url"]) return skip("missing_required_variable:review_url");
      const render = renderTemplate(automation.template, vars);
      if (!render.text) return skip("empty_render");
      text = render.text;
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "rendered" });
    }

    // Отправка через канал. Идемпотентность send-ключа — per-attempt (job.attempts): в пределах
    // одной попытки повтор не шлёт второй раз; реальный retry после сбоя увеличивает attempts →
    // новый ключ → действительная повторная отправка.
    const result = await sender.send({
      prisma,
      orderId: order.id,
      siteId: site.id,
      recipientType: job.recipientType as "CUSTOMER" | "RECIPIENT",
      phoneNormalized: job.phoneNormalized,
      emailNormalized: job.emailNormalized,
      triggerType: automation.triggerType,
      emailTemplateIdOverride: automation.brevoTemplateId,
      text,
      vars,
      idempotencyKey: `${job.idempotencyKey}:a${job.attempts}`,
    });

    if (result.ok) {
      await prisma.automationJob.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          communicationId: result.communicationId ?? null,
          providerMessageId: result.providerMessageId ?? null,
          renderedTextSnapshot: job.channel === "SMS" ? text : null, // снимок в момент фактической отправки
          lastErrorSafe: null,
        },
      });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "provider_accepted", detailSafe: result.providerMessageId ?? null });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "sent" });
      return;
    }

    // Precondition/config-проблема (канал вернул skip) → SKIPPED, не FAILED. Но «SMS не смогла
    // уйти» (телефон непригоден, у магазина нет номера-отправителя) — это ровно тот случай, ради
    // которого настройка «Email, если SMS недоступно» и существует: пропускаем SMS и шлём письмо.
    if (result.skip) {
      if (SMS_UNAVAILABLE_CODES.has(result.code)) {
        await sendFallbackEmail(prisma, repo, { job, automation, order, reason: result.code });
      }
      await skip(result.code);
      return;
    }

    // Ошибка отправки: временную повторяем через outbox (job остаётся SCHEDULED), пока не исчерпаны
    // попытки события; иначе — терминальный FAILED (без бесконечного повтора).
    const isLastAttempt = record.attempts >= record.maxAttempts;
    if (result.retryable && !isLastAttempt) {
      await prisma.automationJob.update({ where: { id: job.id }, data: { attempts: { increment: 1 }, lastErrorSafe: result.code } });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "failed", detailSafe: `${result.code} (retry)` });
      throw new Error(`automation_send_transient:${result.code}`); // plain Error → outbox backoff/retry
    }
    // Fallback: SMS окончательно не отправилось → Email. ДО перевода job в FAILED — по той же
    // причине, что и на skip-пути.
    await sendFallbackEmail(prisma, repo, { job, automation, order, reason: "SMS_FAILED" });

    await prisma.automationJob.update({ where: { id: job.id }, data: { status: "FAILED", failedAt: new Date(), attempts: { increment: 1 }, lastErrorSafe: result.code } });
    await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "failed", detailSafe: result.code });

    // Сообщение так и не ушло — будим правило, погашенное дедупом по этому же номеру.
    await reviveDuplicateSibling(prisma, repo, job);
  };
}

/**
 * Email вместо не ушедшей SMS. Один вход на оба повода — «SMS не смогла уйти» (skip) и «отправка
 * провалилась» (FAILED): две копии этой проверки уже расходились бы при первой же правке условий.
 * Проверка канала живёт ЗДЕСЬ, а не в местах вызова: забыть её в третьем месте слишком легко.
 *
 * ВАЖЕН ПОРЯДОК: оба места вызывают эту функцию ДО того, как переведут SMS-job в терминальный
 * статус. Повторный заход обработчика выходит по проверке `job.status !== "SCHEDULED"`, поэтому
 * сбой между «пометили job» и «создали письмо» терял бы fallback навсегда. Обратный порядок
 * безопасен: `createOrFindJob` идемпотентен по ключу, повтор второго письма не создаёт.
 *
 * Не шлём в трёх случаях:
 *  - fallback выключен у правила;
 *  - «обычный» Email включён отдельно — письмо и так запланировано при триггере;
 *  - это правило «Получателю», а письмо заказчику по событию уже идёт от правила, нацеленного
 *    на заказчика.
 *
 * Последнее — ТОТ ЖЕ дедуп, что делает планировщик (`customerEmailTaken` + `emailIsDuplicate`),
 * только на пути отправки. Условие обязано совпадать с ним дословно, включая асимметрию по
 * аудитории: гасится ТОЛЬКО правило «Получателю» и ТОЛЬКО правилом, целящим в заказчика. Два
 * правила с одной аудиторией друг друга не глушат — это осознанная настройка владельца (два
 * разных текста на событие), и более широкий дедуп молча съедал бы одно из двух задуманных
 * сообщений. Восстановить его нечем: у писем нет механизма оживления, как `reviveDuplicateSibling`
 * у телефонов.
 *
 * Зачем это на пути отправки вообще: без проверки дедуп по телефону оборачивался двумя письмами —
 * правило-победитель падало, будило соседа с тем же номером, и оба слали заказчику по письму на
 * одно событие. Порядок здесь гарантирован структурно: победитель создаёт письмо ДО того, как
 * `skip()`/FAILED-ветка разбудят соседа, поэтому проигравший всегда видит уже существующее письмо.
 *
 * Адресат всегда ЗАКАЗЧИК: e-mail получателя в заказе нет.
 */
async function sendFallbackEmail(
  prisma: PrismaClient,
  repo: PrismaOutboxRepository,
  args: {
    job: { channel: string; occurrenceKey: string | null };
    automation: { id: string; audience: string; emailFallbackEnabled: boolean; emailEnabled: boolean };
    order: { id: string; senderEmail: string | null };
    reason: string;
  }
): Promise<void> {
  const { job, automation, order } = args;
  if (job.channel !== "SMS") return;
  if (!automation.emailFallbackEnabled || automation.emailEnabled || !job.occurrenceKey) return;

  // Считаются только письма, которые реально в пути или уже дошли. SKIPPED/FAILED/CANCELLED
  // заказчика не достигли — гасить из-за них живой fallback значило бы менять одно молчание на другое.
  // Правило-источник обязано целить в ЗАКАЗЧИКА (CUSTOMER или BOTH): письмо от другого правила
  // «Получателю» — не тот случай, ради которого планировщик вводил дедуп.
  const alreadyGoing =
    automation.audience !== "RECIPIENT"
      ? null
      : await prisma.automationJob.findFirst({
          where: {
            orderId: order.id,
            occurrenceKey: job.occurrenceKey,
            channel: "EMAIL",
            recipientType: "CUSTOMER",
            status: { in: ["SCHEDULED", "PROCESSING", "SENT"] },
            automationId: { not: automation.id },
            automation: { audience: { not: "RECIPIENT" } },
          },
          select: { id: true },
        });

  if (alreadyGoing) {
    // Фиксируем SKIPPED-job, чтобы в истории было видно, ПОЧЕМУ правило промолчало по Email —
    // так же, как это делает планировщик для правила «Получателю».
    await createOrFindJob(prisma, repo, {
      automationId: automation.id,
      orderId: order.id,
      recipientType: "CUSTOMER",
      channel: "EMAIL",
      phoneNormalized: null,
      emailNormalized: null,
      occurrenceKey: job.occurrenceKey,
      scheduledAt: new Date(),
      status: "SKIPPED",
      lastErrorSafe: DUPLICATE_EMAIL_REASON,
      logDetail: "",
    });
    return;
  }

  await createCustomerEmailJob(prisma, repo, {
    automationId: automation.id,
    orderId: order.id,
    occurrenceKey: job.occurrenceKey,
    senderEmail: order.senderEmail,
    scheduledAt: new Date(),
    logDetail: `channel=EMAIL recipient=CUSTOMER fallback_reason=${args.reason}`,
  });
}
