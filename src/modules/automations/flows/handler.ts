import "server-only";
/**
 * Outbox-handler цепочек: выполняет ОДИН шаг run'а и продвигает цепочку дальше.
 * Регистрируется в существующем worker'е (scripts/outbox-worker.ts) рядом с обработчиками
 * одиночных правил — отдельного процесса и отдельной очереди нет.
 *
 * Отправка идёт через тот же реестр ChannelSender, что и у одиночных правил: движок решает
 * «кому и что», канал — «как отправить». Ни QUO, ни Brevo здесь не переписываются.
 *
 * Идемпотентность. Повторная доставка того же события (retry outbox, восстановление зависшего
 * lease) не отправляет второй раз: шаг выходит из состояния SCHEDULED только вместе с записью
 * результата, а любой не-SCHEDULED шаг обработчик молча пропускает. Внутри одной попытки
 * дополнительный барьер — ключ идемпотентности отправки `flow:{runStepId}:a{attempts}`: он
 * per-attempt, потому что sendOrderSms «сжигает» стабильный ключ при неудаче (см. одиночные
 * правила), и без инкремента настоящий retry не прошёл бы.
 *
 * Ошибки. Временную ошибку канала повторяем через outbox (шаг остаётся SCHEDULED, attempts++).
 * Исчерпав попытки, шаг получает FAILED с безопасным текстом ошибки — и цепочка ПРОДОЛЖАЕТСЯ
 * со следующего шага: одна неудачная отправка не должна обрывать всю цепочку.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import type { OutboxHandler } from "@/outbox/worker";
import type { OutboxRecord } from "@/outbox/types";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { resolveRecipients } from "../audience";
import { resolveCustomerEmail } from "../emailAudience";
import { buildOrderVariables } from "../variables";
import { renderTemplate, extractVariables } from "../template";
import { SMS_ORDER_INCLUDE, orderToVariableSource } from "../orderSource";
import { isAutomationsGloballyDisabled } from "../settings";
import type { ChannelSender } from "../channels/types";
import type { FlowStepPayload } from "./events";
import { advanceRun, type FlowStepRow } from "./engine";

/** Триггеры, которые ПО СМЫСЛУ работают с отменённым/возвращённым заказом. */
const ALLOW_CANCELLED_REFUNDED = new Set(["ORDER_REFUNDED", "PAYMENT_FAILED", "ORDER_CANCELLED"]);
const CANCELLED_REFUNDED = new Set(["CANCELLED", "REFUNDED", "PARTIALLY_REFUNDED"]);

export type FlowStepDeps = {
  /** Реестр каналов: "SMS" | "EMAIL" → ChannelSender. Тот же, что у одиночных правил. */
  channels: Record<string, ChannelSender>;
};

export function buildFlowStepHandler(prisma: PrismaClient, deps: FlowStepDeps): OutboxHandler {
  const repo = new PrismaOutboxRepository(prisma);

  return async (record: OutboxRecord) => {
    const p = record.payload as FlowStepPayload;
    if (!p?.runStepId) return;

    const runStep = await prisma.automationFlowRunStep.findUnique({
      where: { id: p.runStepId },
      include: {
        step: true,
        run: {
          include: {
            flow: { include: { steps: { orderBy: { position: "asc" } } } },
            order: { include: SMS_ORDER_INCLUDE },
          },
        },
      },
    });
    if (!runStep) return; // шаг исчез
    if (runStep.status !== "SCHEDULED") return; // уже выполнен/пропущен/отменён — выходим идемпотентно

    const run = runStep.run;
    const flow = run.flow;
    const order = run.order;
    const site = order.site;

    if (run.status !== "ACTIVE") return; // цепочку остановили, пока шаг ждал своего часа

    const steps: FlowStepRow[] = flow.steps.map((s) => ({
      id: s.id,
      position: s.position,
      type: s.type,
      waitAmount: s.waitAmount,
      waitUnit: s.waitUnit,
      deletedAt: s.deletedAt,
    }));

    /** Шаг не выполнен по «непреодолимой» причине — фиксируем и идём дальше. */
    const skipAndAdvance = async (reason: string) => {
      await prisma.automationFlowRunStep.update({
        where: { id: runStep.id },
        data: { status: "SKIPPED", skippedAt: new Date(), lastErrorSafe: reason },
      });
      await advanceRun(prisma, repo, { runId: run.id, orderId: order.id, steps, afterPosition: runStep.position });
    };

    /** Цепочка дальше не идёт: причина относится ко всему run'у, а не к одному шагу. */
    const cancelRun = async (reason: string) => {
      await prisma.automationFlowRunStep.update({
        where: { id: runStep.id },
        data: { status: "CANCELLED", lastErrorSafe: reason },
      });
      await prisma.automationFlowRun.update({
        where: { id: run.id },
        data: { status: "CANCELLED", cancelledReason: reason, nextRunAt: null, finishedAt: new Date() },
      });
    };

    // Глобальный рубильник: шаг пропускаем, но цепочку не рушим (её ещё можно будет включить).
    if (await isAutomationsGloballyDisabled(prisma)) return skipAndAdvance("global_kill_switch");

    // Повторные проверки на СВЕЖИХ данных — состояние могло измениться за время ожидания.
    if (flow.deletedAt) return cancelRun("flow_deleted");
    if (!flow.active) return cancelRun("flow_disabled");

    const stillLinked = await prisma.automationFlowSite.findUnique({
      where: { flowId_siteId: { flowId: flow.id, siteId: site.id } },
      select: { siteId: true },
    });
    if (!stillLinked) return cancelRun("site_unlinked");

    if (!ALLOW_CANCELLED_REFUNDED.has(flow.triggerType)) {
      if (CANCELLED_REFUNDED.has(order.orderStatus) || CANCELLED_REFUNDED.has(order.paymentStatus)) {
        return cancelRun("order_cancelled");
      }
    }

    // Владелец исключил заказ из маркетинга. Проверка живёт ЗДЕСЬ, а не на старте цепочки:
    // так пометка гасит и уже идущие цепочки, а в «Истории» остаётся видимый след, почему
    // письмо не ушло. Служебных правил это не касается — они про сам заказ, а не про маркетинг.
    // ASK_REVIEW цепочки НЕ трогает: это задача оператору, а не запрет на письма.
    if (order.marketingMark === "MUTED") return cancelRun("order_marketing_muted");

    // Шаг убрали из цепочки, пока он ждал: фиксируем пропуск и идём дальше.
    if (runStep.step.deletedAt) return skipAndAdvance("step_deleted");

    // ── WAIT: ожидание истекло, отмечаем выполненным и продвигаем цепочку ──
    if (runStep.type === "WAIT") {
      await prisma.automationFlowRunStep.update({
        where: { id: runStep.id },
        data: { status: "SENT", sentAt: new Date(), lastErrorSafe: null },
      });
      await advanceRun(prisma, repo, { runId: run.id, orderId: order.id, steps, afterPosition: runStep.position });
      return;
    }

    const sender = deps.channels[runStep.type];
    if (!sender) return skipAndAdvance(`unsupported_channel:${runStep.type}`);

    const vars = buildOrderVariables(orderToVariableSource(order));

    // ── Адресат и содержимое: резолвим в момент отправки, по свежим данным заказа ──
    let text = "";
    let phoneNormalized: string | null = null;
    let emailNormalized: string | null = null;

    if (runStep.type === "SMS") {
      if (!runStep.step.template?.trim()) return skipAndAdvance("empty_template");
      const referenced = new Set(extractVariables(runStep.step.template));
      if (referenced.has("review_url") && !vars["review_url"]) return skipAndAdvance("missing_required_variable:review_url");
      const render = renderTemplate(runStep.step.template, vars);
      if (!render.text) return skipAndAdvance("empty_render");
      text = render.text;

      // Цепочки адресуют ЗАКАЗЧИКА: это маркетинг/пост-продажная коммуникация с клиентом,
      // а не операционное уведомление получателю букета.
      const { recipients, skipped } = resolveRecipients("CUSTOMER", {
        senderPhone: order.senderPhone,
        recipientPhone: order.recipientPhone,
      });
      const target = recipients[0];
      if (!target) return skipAndAdvance(skipped[0]?.reason ?? "PHONE_MISSING");
      phoneNormalized = target.phoneNormalized;
    } else {
      if (runStep.step.brevoTemplateId == null) return skipAndAdvance("missing_template_id");
      const res = resolveCustomerEmail({ senderEmail: order.senderEmail });
      if (!res.ok) return skipAndAdvance(res.skipped.reason);
      emailNormalized = res.recipient.emailNormalized;
    }

    const result = await sender.send({
      prisma,
      orderId: order.id,
      siteId: site.id,
      recipientType: "CUSTOMER",
      phoneNormalized,
      emailNormalized,
      triggerType: flow.triggerType,
      emailTemplateIdOverride: runStep.step.brevoTemplateId,
      text,
      vars,
      idempotencyKey: `flow:${runStep.id}:a${runStep.attempts}`,
    });

    if (result.ok) {
      await prisma.automationFlowRunStep.update({
        where: { id: runStep.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          phoneNormalized,
          emailNormalized,
          communicationId: result.communicationId ?? null,
          providerMessageId: result.providerMessageId ?? null,
          renderedTextSnapshot: runStep.type === "SMS" ? text : null,
          lastErrorSafe: null,
        },
      });
      await advanceRun(prisma, repo, { runId: run.id, orderId: order.id, steps, afterPosition: runStep.position });
      return;
    }

    // Магазин ещё не настроен для этого канала (нет номера/шаблона/подтверждённого домена) —
    // это не сбой отправки, а невозможность отправить: шаг SKIPPED, цепочка идёт дальше.
    if (result.skip) return skipAndAdvance(result.code);

    const isLastAttempt = record.attempts >= record.maxAttempts;
    if (result.retryable && !isLastAttempt) {
      await prisma.automationFlowRunStep.update({
        where: { id: runStep.id },
        data: { attempts: { increment: 1 }, lastErrorSafe: result.code, phoneNormalized, emailNormalized },
      });
      throw new Error(`flow_step_transient:${result.code}`); // plain Error → backoff/повтор outbox
    }

    // Окончательная неудача шага. Цепочку НЕ обрываем — идём к следующему шагу.
    await prisma.automationFlowRunStep.update({
      where: { id: runStep.id },
      data: {
        status: "FAILED",
        failedAt: new Date(),
        attempts: { increment: 1 },
        lastErrorSafe: result.code,
        phoneNormalized,
        emailNormalized,
      },
    });
    await advanceRun(prisma, repo, { runId: run.id, orderId: order.id, steps, afterPosition: runStep.position });
  };
}
