import "server-only";
/**
 * Outbox-handler'ы движка авто-SMS. Два этапа, оба через существующий durable outbox:
 *
 *  1) sms.automation.trigger → для Site находим активные правила под triggerType, проверяем
 *     условия, разворачиваем аудиторию в адресатов, создаём SmsAutomationJob (идемпотентно) и
 *     публикуем отложенный sms.automation.send (availableAt = scheduledAt).
 *
 *  2) sms.automation.send → берём due job, ПОВТОРНО проверяем на свежих данных (правило/Site
 *     активны, заказ не отменён, номер магазина есть, обязательные переменные есть), рендерим по
 *     свежим данным, фиксируем снимок текста и отправляем через sendOrderSms (номер Site,
 *     OrderCommunication). Идемпотентность отправки — sendKey = job.idempotencyKey.
 *
 * Реальная отправка НЕ дублируется: sendOrderSms дедуплицирует по sendKey; повторная доставка
 * события или рестарт worker'а не создаёт второй SMS.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { sendOrderSms, type SendTarget } from "@/integrations/quo/send";
import type { QuoClient } from "@/integrations/quo/client";
import { publishSmsSend, type SmsTriggerPayload, type SmsSendPayload } from "./events";
import { getSmsTrigger } from "./triggers";
import { evaluateConditions, type SmsConditions } from "./conditions";
import { resolveRecipients, type SmsAudience } from "./audience";
import { computeScheduledAt, type SmsDelayUnit } from "./delay";
import { buildOrderVariables } from "./variables";
import { renderTemplate, extractVariables } from "./template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";

/** Коды ошибок отправки, которые считаем временными (повтор с backoff через outbox). */
const RETRYABLE_SEND_CODES = new Set(["quo_server", "quo_network", "quo_rate_limit"]);

function isP2002(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

// ─────────────────────────────  ЭТАП 1: TRIGGER → JOBS  ─────────────────────────────

export function buildSmsTriggerHandler(prisma: PrismaClient): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as SmsTriggerPayload;
    if (!p?.orderId || !p?.siteId || !p?.triggerType || !p?.occurrenceKey) return;

    const automations = await prisma.smsAutomation.findMany({
      where: { siteId: p.siteId, triggerType: p.triggerType, active: true, deletedAt: null },
    });
    if (automations.length === 0) return;

    const order = await prisma.order.findUnique({ where: { id: p.orderId }, include: SMS_ORDER_INCLUDE });
    if (!order) return; // заказ исчез — планировать нечего

    const now = new Date();

    for (const a of automations) {
      const cond = evaluateConditions(a.conditionsJson as SmsConditions | null, {
        orderStatus: order.orderStatus,
        paymentStatus: order.paymentStatus,
        deliveryDate: order.deliveryDate,
        apartment: order.apartment,
        timezone: order.site.timezone,
        now,
      });
      if (!cond.ok) continue; // условие не выполнено на момент триггера — job не создаём

      const { recipients, skipped } = resolveRecipients(a.audience as SmsAudience, {
        senderPhone: order.senderPhone,
        recipientPhone: order.recipientPhone,
      });
      const scheduledAt = computeScheduledAt(now, a.delayAmount, a.delayUnit as SmsDelayUnit);

      for (const r of recipients) {
        const idempotencyKey = `${a.id}:${p.orderId}:${r.recipientType}:${p.occurrenceKey}`;
        let jobId: string | null = null;
        try {
          const created = await prisma.smsAutomationJob.create({
            data: {
              automationId: a.id,
              orderId: p.orderId,
              recipientType: r.recipientType,
              phoneNormalized: r.phoneNormalized,
              scheduledAt,
              status: "SCHEDULED",
              idempotencyKey,
            },
            select: { id: true },
          });
          jobId = created.id;
        } catch (err) {
          if (isP2002(err)) {
            const existing = await prisma.smsAutomationJob.findUnique({ where: { idempotencyKey }, select: { id: true } });
            jobId = existing?.id ?? null;
          } else {
            throw err;
          }
        }
        // Публикуем отложенную отправку идемпотентно (даже если job уже был — outbox дедуплицирует).
        if (jobId) await publishSmsSend(repo, { jobId, orderId: p.orderId }, scheduledAt);
      }

      // Адресаты без валидного телефона — фиксируем SKIPPED-job для видимости в истории (идемпотентно).
      for (const sk of skipped) {
        const idempotencyKey = `${a.id}:${p.orderId}:${sk.recipientType}:${p.occurrenceKey}`;
        try {
          await prisma.smsAutomationJob.create({
            data: {
              automationId: a.id,
              orderId: p.orderId,
              recipientType: sk.recipientType,
              phoneNormalized: "",
              scheduledAt: now,
              status: "SKIPPED",
              skippedAt: now,
              lastErrorSafe: sk.reason,
              idempotencyKey,
            },
            select: { id: true },
          });
        } catch (err) {
          if (!isP2002(err)) throw err;
        }
      }
    }
  };
}

// ─────────────────────────────  ЭТАП 2: SEND JOB  ─────────────────────────────

export type SmsSendDeps = {
  /** Строит QUO-клиент (без авто-ретрая) или null, если QUO не настроен/выключен глобально. */
  getClient: () => QuoClient | null;
};

export function buildSmsSendHandler(prisma: PrismaClient, deps: SmsSendDeps): OutboxHandler {
  return async (record: OutboxRecord) => {
    const p = record.payload as SmsSendPayload;
    if (!p?.jobId) return;

    const job = await prisma.smsAutomationJob.findUnique({
      where: { id: p.jobId },
      include: { automation: true, order: { include: SMS_ORDER_INCLUDE } },
    });
    if (!job) return; // job исчез
    if (job.status !== "SCHEDULED") return; // уже отправлен/пропущен/отменён — идемпотентно выходим

    const automation = job.automation;
    const order = job.order;
    const site = order.site;

    const skip = async (reason: string) => {
      await prisma.smsAutomationJob.update({
        where: { id: job.id },
        data: { status: "SKIPPED", skippedAt: new Date(), lastErrorSafe: reason },
      });
    };

    // Повторные проверки на СВЕЖИХ данных.
    if (!automation.active) return skip("automation_disabled");
    if (automation.deletedAt) return skip("automation_deleted");

    const cond = evaluateConditions(automation.conditionsJson as SmsConditions | null, {
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      deliveryDate: order.deliveryDate,
      apartment: order.apartment,
      timezone: site.timezone,
    });
    if (!cond.ok) return skip(cond.skipReason);

    if (!site.quoEnabled) return skip("site_quo_disabled");
    if (!site.quoPhoneNumberId) return skip("site_no_quo_number"); // Site QUO number is not configured

    // Рендер по свежим данным.
    const vars = buildOrderVariables(orderToVariableSource(order));
    const trigger = getSmsTrigger(automation.triggerType);
    const referenced = new Set(extractVariables(automation.template));

    // Гейтинг обязательных переменных (иначе не отправляем): requiredVars триггера + review_url,
    // если он используется в шаблоне. Так TRACKING не уходит без реального трека, review — без ссылки.
    for (const key of trigger?.requiredVars ?? []) {
      if (!vars[key]) return skip(`missing_required_variable:${key}`);
    }
    if (referenced.has("review_url") && !vars["review_url"]) return skip("missing_required_variable:review_url");

    const render = renderTemplate(automation.template, vars);
    if (!render.text) return skip("empty_render");

    // Отправка через существующий QUO-путь. sendKey включает НОМЕР ПОПЫТКИ job'а (job.attempts):
    //  - в пределах одной попытки повтор события даёт тот же ключ → sendOrderSms не шлёт второй раз
    //    (и на краше «после отправки, до update» вернёт уже SENT-коммуникацию — без дубля QUO);
    //  - реальный retry после сбоя увеличивает job.attempts → новый ключ → действительная повторная
    //    отправка (иначе «сгоревший» sendKey навсегда возвращал бы прежний FAILED как успех).
    const client = deps.getClient();
    const res = await sendOrderSms(prisma, client, {
      orderId: order.id,
      target: job.recipientType as SendTarget,
      text: render.text,
      idempotencyKey: `${job.idempotencyKey}:a${job.attempts}`,
      sentByUserId: null,
    });

    if (res.ok) {
      let providerMessageId: string | null = null;
      if (res.communicationId) {
        const comm = await prisma.orderCommunication.findUnique({
          where: { id: res.communicationId },
          select: { providerResourceId: true },
        });
        providerMessageId = comm?.providerResourceId ?? null;
      }
      await prisma.smsAutomationJob.update({
        where: { id: job.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          communicationId: res.communicationId ?? null,
          providerMessageId,
          renderedTextSnapshot: render.text, // снимок в момент фактической отправки
          lastErrorSafe: null,
        },
      });
      return;
    }

    // Ошибка отправки: временную повторяем через outbox (job остаётся SCHEDULED), пока не исчерпаны
    // попытки события; иначе — терминальный FAILED (без бесконечного повтора).
    const retryable = RETRYABLE_SEND_CODES.has(res.code);
    const isLastAttempt = record.attempts >= record.maxAttempts;
    if (retryable && !isLastAttempt) {
      await prisma.smsAutomationJob.update({
        where: { id: job.id },
        data: { attempts: { increment: 1 }, lastErrorSafe: res.code },
      });
      throw new Error(`sms_send_transient:${res.code}`); // plain Error → outbox backoff/retry
    }
    await prisma.smsAutomationJob.update({
      where: { id: job.id },
      data: { status: "FAILED", failedAt: new Date(), attempts: { increment: 1 }, lastErrorSafe: res.code },
    });
  };
}
