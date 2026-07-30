import "server-only";
/**
 * Outbox-handler'ы Automation Engine. Два этапа, оба через существующий durable outbox:
 *
 *  1) sms.automation.trigger → для Site находим активные правила под triggerType, проверяем
 *     условия, разворачиваем аудиторию в адресатов ПО КАЖДОМУ включённому каналу (SMS/EMAIL),
 *     создаём AutomationJob (идемпотентно, ключ включает канал) и публикуем отложенный
 *     sms.automation.send (availableAt = scheduledAt).
 *
 *  2) sms.automation.send → берём due job, ПОВТОРНО проверяем на свежих данных (kill switch,
 *     правило/Site активны, заказ не отменён, обязательные переменные есть), рендерим (SMS) или
 *     собираем params (EMAIL) по свежим данным и отправляем через ChannelSender job.channel.
 *     Если SMS-job окончательно провалился (все retry исчерпаны) и у правила включён
 *     «Email, если SMS недоступно» (а «обычный» Email отдельно не включён — иначе дублирование),
 *     здесь же реактивно создаётся EMAIL-fallback-job.
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
import { resolveRecipients, type SmsAudience, type SmsRecipientType } from "./audience";
import { resolveCustomerEmail } from "./emailAudience";
import { computeScheduledAt, type SmsDelayUnit } from "./delay";
import { buildOrderVariables } from "./variables";
import { renderTemplate, extractVariables } from "./template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";
import { isAutomationsGloballyDisabled } from "./settings";
import { logExecution } from "./executionLog";
import type { ChannelSender } from "./channels/types";

/** Триггеры, для которых заказ ИМЕННО отменён/возвращён — дефолтное исключение не применяем. */
const ALLOW_CANCELLED_REFUNDED = new Set(["ORDER_REFUNDED", "PAYMENT_FAILED"]);

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

// ─────────────────────────────  ЭТАП 1: TRIGGER → JOBS  ─────────────────────────────

export function buildAutomationTriggerHandler(prisma: PrismaClient): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as AutomationTriggerPayload;
    if (!p?.orderId || !p?.siteId || !p?.triggerType || !p?.occurrenceKey) return;

    // Global kill switch: новые job'ы не создаём вовсе.
    if (await isAutomationsGloballyDisabled(prisma)) return;

    // Правило может быть привязано к нескольким Site — выбираем по связи AutomationSite.
    const automations = await prisma.automation.findMany({
      where: { sites: { some: { siteId: p.siteId } }, triggerType: p.triggerType, active: true, deletedAt: null },
    });
    if (automations.length === 0) return;

    const order = await prisma.order.findUnique({ where: { id: p.orderId }, include: SMS_ORDER_INCLUDE });
    if (!order) return; // заказ исчез — планировать нечего

    const now = new Date();

    // Задача «доставка сегодня» ставится заранее; к моменту срабатывания дату могли перенести.
    if (p.triggerType === "DELIVERY_TODAY" && !isDeliveryToday(order.deliveryDate, order.site.timezone, now)) return;

    for (const a of automations) {
      const cond = evaluateConditions(a.conditionsJson as SmsConditions | null, {
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        deliveryDate: order.deliveryDate,
        apartment: order.apartment,
        timezone: order.site.timezone,
        allowCancelledRefunded: ALLOW_CANCELLED_REFUNDED.has(p.triggerType),
        now,
      });
      if (!cond.ok) continue; // условие не выполнено на момент триггера — job не создаём

      const scheduledAt = computeScheduledAt(now, a.delayAmount, a.delayUnit as SmsDelayUnit);

      // ── SMS ──
      if (a.smsEnabled) {
        const { recipients, skipped } = resolveRecipients(a.audience as SmsAudience, {
          senderPhone: order.senderPhone,
          recipientPhone: order.recipientPhone,
        });

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
          if (a.emailFallbackEnabled && !a.emailEnabled) {
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

    const skip = async (reason: string) => {
      await prisma.automationJob.update({ where: { id: job.id }, data: { status: "SKIPPED", skippedAt: new Date(), lastErrorSafe: reason } });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "skipped", detailSafe: reason });
    };

    // Global kill switch: уже запланированный job при включённом рубильнике не отправляем.
    if (await isAutomationsGloballyDisabled(prisma)) return skip("global_kill_switch");

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

    // Precondition/config-проблема (канал вернул skip) → SKIPPED, не FAILED.
    if (result.skip) return skip(result.code);

    // Ошибка отправки: временную повторяем через outbox (job остаётся SCHEDULED), пока не исчерпаны
    // попытки события; иначе — терминальный FAILED (без бесконечного повтора).
    const isLastAttempt = record.attempts >= record.maxAttempts;
    if (result.retryable && !isLastAttempt) {
      await prisma.automationJob.update({ where: { id: job.id }, data: { attempts: { increment: 1 }, lastErrorSafe: result.code } });
      await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "failed", detailSafe: `${result.code} (retry)` });
      throw new Error(`automation_send_transient:${result.code}`); // plain Error → outbox backoff/retry
    }
    await prisma.automationJob.update({ where: { id: job.id }, data: { status: "FAILED", failedAt: new Date(), attempts: { increment: 1 }, lastErrorSafe: result.code } });
    await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "failed", detailSafe: result.code });

    // Fallback: SMS окончательно не отправилось → Email, если разрешено и «обычный» Email не
    // включён отдельно (иначе он уже независимо запланирован при триггере — дублировать не надо).
    if (job.channel === "SMS" && automation.emailFallbackEnabled && !automation.emailEnabled && job.occurrenceKey) {
      await createCustomerEmailJob(prisma, repo, {
        automationId: automation.id,
        orderId: order.id,
        occurrenceKey: job.occurrenceKey,
        senderEmail: order.senderEmail,
        scheduledAt: new Date(),
        logDetail: "channel=EMAIL recipient=CUSTOMER fallback_reason=SMS_FAILED",
      });
    }
  };
}
