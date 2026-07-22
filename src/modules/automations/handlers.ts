import "server-only";
/**
 * Outbox-handler'ы Automation Engine. Два этапа, оба через существующий durable outbox:
 *
 *  1) sms.automation.trigger → для Site находим активные правила под triggerType, проверяем
 *     условия, разворачиваем аудиторию в адресатов, создаём AutomationJob (идемпотентно) и
 *     публикуем отложенный sms.automation.send (availableAt = scheduledAt).
 *
 *  2) sms.automation.send → берём due job, ПОВТОРНО проверяем на свежих данных (kill switch,
 *     правило/Site активны, заказ не отменён, обязательные переменные есть), рендерим по свежим
 *     данным и отправляем через ChannelSender выбранного канала (SMS — поверх sendOrderSms).
 *
 * Канал-агностично: движок знает про «кому/что», а «как отправить» — в ChannelSender. Реальная
 * отправка НЕ дублируется: sendOrderSms дедуплицирует по sendKey (движок формирует его per-attempt).
 * Журнал выполнения ведётся ТОЛЬКО для реально созданных Job.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { publishAutomationSend, type AutomationTriggerPayload, type AutomationSendPayload } from "./events";
import { getSmsTrigger } from "./triggers";
import { evaluateConditions, type SmsConditions } from "./conditions";
import { resolveRecipients, type SmsAudience } from "./audience";
import { computeScheduledAt, type SmsDelayUnit } from "./delay";
import { buildOrderVariables } from "./variables";
import { renderTemplate, extractVariables } from "./template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "./orderSource";
import { isAutomationsGloballyDisabled } from "./settings";
import { logExecution } from "./executionLog";
import type { ChannelSender } from "./channels/types";

function isP2002(err: unknown): boolean {
  return !!err && typeof err === "object" && "code" in err && (err as { code?: string }).code === "P2002";
}

// ─────────────────────────────  ЭТАП 1: TRIGGER → JOBS  ─────────────────────────────

export function buildAutomationTriggerHandler(prisma: PrismaClient): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as AutomationTriggerPayload;
    if (!p?.orderId || !p?.siteId || !p?.triggerType || !p?.occurrenceKey) return;

    // Global kill switch: новые job'ы не создаём вовсе.
    if (await isAutomationsGloballyDisabled(prisma)) return;

    const automations = await prisma.automation.findMany({
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
        let created = false;
        try {
          const job = await prisma.automationJob.create({
            data: { automationId: a.id, orderId: p.orderId, recipientType: r.recipientType, phoneNormalized: r.phoneNormalized, scheduledAt, status: "SCHEDULED", idempotencyKey },
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
        if (jobId) {
          if (created) await logExecution(prisma, { jobId, automationId: a.id, orderId: p.orderId, stage: "scheduled", detailSafe: `channel=${a.channel} recipient=${r.recipientType}` });
          // Публикуем отложенную отправку идемпотентно (даже если job уже был — outbox дедуплицирует).
          await publishAutomationSend(repo, { jobId, orderId: p.orderId }, scheduledAt);
        }
      }

      // Адресаты без валидного телефона — фиксируем SKIPPED-job для видимости (идемпотентно).
      for (const sk of skipped) {
        const idempotencyKey = `${a.id}:${p.orderId}:${sk.recipientType}:${p.occurrenceKey}`;
        try {
          const job = await prisma.automationJob.create({
            data: { automationId: a.id, orderId: p.orderId, recipientType: sk.recipientType, phoneNormalized: "", scheduledAt: now, status: "SKIPPED", skippedAt: now, lastErrorSafe: sk.reason, idempotencyKey },
            select: { id: true },
          });
          await logExecution(prisma, { jobId: job.id, automationId: a.id, orderId: p.orderId, stage: "skipped", detailSafe: sk.reason });
        } catch (err) {
          if (!isP2002(err)) throw err;
        }
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

    const cond = evaluateConditions(automation.conditionsJson as SmsConditions | null, {
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      deliveryDate: order.deliveryDate,
      apartment: order.apartment,
      timezone: site.timezone,
    });
    if (!cond.ok) return skip(cond.skipReason);

    // Канал: резолвим отправителя. Неизвестный/неподдержанный канал → SKIP.
    const sender = deps.channels[automation.channel];
    if (!sender) return skip(`unsupported_channel:${automation.channel}`);

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
    await logExecution(prisma, { jobId: job.id, automationId: automation.id, orderId: order.id, stage: "rendered" });

    // Отправка через канал. Идемпотентность send-ключа — per-attempt (job.attempts): в пределах
    // одной попытки повтор не шлёт второй раз; реальный retry после сбоя увеличивает attempts →
    // новый ключ → действительная повторная отправка.
    const result = await sender.send({
      prisma,
      orderId: order.id,
      siteId: site.id,
      recipientType: job.recipientType as "CUSTOMER" | "RECIPIENT",
      phoneNormalized: job.phoneNormalized,
      text: render.text,
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
          renderedTextSnapshot: render.text, // снимок в момент фактической отправки
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
  };
}
