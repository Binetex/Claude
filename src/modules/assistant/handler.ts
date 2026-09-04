import "server-only";
/**
 * Разбор одного входящего сообщения ассистентом.
 *
 * Порядок намеренно такой: сначала дешёвые проверки (правила, потолки, тишина), и только потом
 * обращение к модели — вопрос «а надо ли вообще отвечать» не стоит ни одного запроса. Что бы ни
 * случилось дальше, наружу ничего не уходит, пока владелец не включил режим и не снял сухой
 * прогон: молчание безопаснее лишнего сообщения живому человеку.
 *
 * Каждый разбор оставляет строку в `AiTurn` — включая отказ отвечать и его причину. Без этого
 * на вопрос «почему по заказу тишина» нечем ответить, кроме догадок.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { parseAttachments } from "@/integrations/quo/communicationsService";
import { getDeepseekConfig } from "@/integrations/deepseek/config";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { buildMessages, parseReply, type HistoryLine, type OrderSnapshot } from "./prompt";
import { matchIntent } from "./intents";
import { readTemplates, templateApplies, renderAssistantTemplate } from "./templates";
import { loadCatalog, looksLikeShopping } from "./catalog";
import { buildOrderVariables } from "@/modules/messaging/variables";
import { orderToVariableSource, SMS_ORDER_INCLUDE } from "@/modules/messaging/orderSource";
import { shouldConsider, decideDelivery, type AssistantMode } from "./policy";
import { scheduleAssistantNudge, type AssistantIncomingPayload } from "./events";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { sendAssistantReply, notifyDraft, notifyOwnerText } from "./deliver";
import { prependReadyTimeNote } from "./note";
import { findOrderByHint, linkConversation } from "./link";
import { bouquetPageUrl } from "@/lib/bouquetPage";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { todayStrInTz, zonedLocalTimeToUtc } from "@/lib/tz";

/**
 * Сколько последних сообщений переписки показываем модели. Двадцать — вся живая переписка по
 * заказу: клиент часто ссылается на сказанное раньше («как договаривались»), и без этого
 * ассистент отвечает в вакууме.
 */
const HISTORY_LIMIT = 20;

/** Сигнал «кончился баланс модели» владельцу — не чаще раза в сутки. */
const NO_BALANCE_ALERT_HOURS = 24;

export type AssistantDeps = {
  /** Инъекция клиента модели — в тестах реального обращения быть не должно. */
  client?: DeepseekClient | null;
  now?: () => Date;
};

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function loadOrder(prisma: PrismaClient, id: string) {
  return prisma.order.findUnique({ where: { id }, include: SMS_ORDER_INCLUDE });
}

export function buildAssistantHandler(prisma: PrismaClient, deps: AssistantDeps = {}) {
  const now = deps.now ?? (() => new Date());

  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as AssistantIncomingPayload;
    if (!p?.communicationId) return;

    const incoming = await prisma.orderCommunication.findUnique({
      where: { id: p.communicationId },
      select: {
        id: true, orderId: true, direction: true, messageText: true, transcript: true, summary: true,
        type: true, partyRole: true, externalPhoneNormalized: true, storePhone: true, providerPhoneNumberId: true, occurredAt: true,
        attachmentsJson: true,
      },
    });
    if (!incoming || incoming.direction !== "INBOUND") return;
    const text = pickText(incoming);

    // Разбор уже был: одно входящее — один разбор, повтор обработчика ничего не создаёт.
    // Исключение — звонок: его запись создаётся до расшифровки, и первый разбор честно
    // пропустил пустой текст. Пришла расшифровка — тот разбор снимается, идёт настоящий.
    const existing = await prisma.aiTurn.findUnique({ where: { communicationId: incoming.id }, select: { id: true, status: true, skipReason: true } });
    if (existing) {
      if (!(existing.status === "SKIPPED" && existing.skipReason === "empty_text" && text)) return;
      await prisma.aiTurn.delete({ where: { id: existing.id } });
    }

    // Тот же срез заказа, что у автоматизаций: переменные шаблонов обязаны считаться одинаково,
    // иначе «во сколько привезут» в заготовке и в правиле разойдутся.
    const order = incoming.orderId ? await loadOrder(prisma, incoming.orderId) : null;

    // Магазин: у привязанного входящего — от заказа, у незнакомого номера — по номеру магазина,
    // на который написали: сначала по id номера в QUO (он стабилен), потом по самому номеру.
    // Не нашли магазин — разбирать нечего и негде.
    const site =
      order?.site
      ?? (incoming.providerPhoneNumberId ? await prisma.site.findFirst({ where: { quoPhoneNumberId: incoming.providerPhoneNumberId } }) : null)
      ?? (incoming.storePhone ? await prisma.site.findFirst({ where: { quoPhoneNumber: incoming.storePhone } }) : null);
    if (!site) return;

    const phone = incoming.externalPhoneNormalized;
    const gate = shouldConsider({
      mode: site.aiMode as AssistantMode,
      orderDisabled: !!order?.aiDisabled,
      orderClosed: order?.orderStatus === "CANCELLED",
      deliveredAt: deliveredMoment(order),
      text,
      lastAutomatedAt: order ? await lastAutomatedAt(prisma, order.id) : null,
      ...(await countReplies(prisma, site, order?.id ?? null, phone, now())),
      now: now(),
    });
    if (!gate.ok) {
      // Отказ тоже записываем: «почему по заказу тишина» — первый вопрос владельца.
      if (gate.reason !== "assistant_off") await logSkip(prisma, site.id, order?.id ?? null, incoming.id, gate.reason);
      return;
    }

    // Заготовка сильнее модели: на «где мой заказ» ответ один и тот же, и тратить на него запрос,
    // рискуя выдумкой, незачем. Только для заказов: у незнакомого номера подставлять нечего.
    if (order) {
      const intent = matchIntent(text);
      if (intent) {
        const setting = readTemplates(site.aiTemplatesJson)[intent.key];
        const vars = buildOrderVariables(orderToVariableSource(order));
        const state = {
          deliveryStatus: order.deliveryStatus,
          deliveryIsToday: !!order.deliveryDate && order.deliveryDate.toISOString().slice(0, 10) === todayStrInTz(site.timezone, now()),
        };
        if (templateApplies(intent, setting, vars, state)) {
          // Предложение с пустой переменной выпадает, остальное уходит. Не осталось ничего —
          // вопрос честнее отдать модели.
          const rendered = renderAssistantTemplate(setting.text, vars);
          if (rendered.text) {
            const action = decideDelivery({
              mode: site.aiMode as AssistantMode,
              dryRun: site.aiDryRun,
              hasReply: true,
              needsHuman: false,
              important: false,
            });
            const turn = await prisma.aiTurn.create({
              data: {
                siteId: site.id, orderId: order.id, communicationId: incoming.id,
                status: "DRAFT", source: "template", intent: intent.key,
                replyText: rendered.text,
                needsHuman: action === "draft",
              },
              select: { id: true },
            });
            await finishTurn(prisma, turn.id, action, site.aiDryRun);
            return;
          }
        }
      }
    }

    const cfg = getDeepseekConfig();
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "model_not_configured");
      return;
    }

    // Каталог нужен не всегда: на «во сколько привезут» он только раздувает запрос. Но у
    // незнакомого номера разговор почти всегда про покупку, поэтому там он идёт сразу.
    const wantsCatalog = !order || looksLikeShopping(text);
    const messages = buildMessages({
      knowledgeBase: order ? site.aiKnowledgeBase : site.aiUnknownKnowledgeBase,
      order: order ? snapshot(order, site.name, incoming.partyRole) : null,
      history: await loadHistory(prisma, order?.id ?? null, phone, incoming.storePhone, incoming.id),
      incomingText: text,
      catalog: wantsCatalog ? await loadCatalog(prisma, site.id).catch(() => []) : undefined,
    });

    let raw: string;
    let modelName: string;
    let latencyMs: number;
    try {
      const res = await client.complete(messages);
      raw = res.text;
      modelName = res.model;
      latencyMs = res.latencyMs;
    } catch (err) {
      // Модель недоступна — клиенту не уходит ничего (решение владельца). Строка в журнале
      // остаётся, чтобы молчание можно было объяснить.
      const code = err instanceof DeepseekError ? err.code : "unknown";
      await prisma.aiTurn.create({
        data: {
          siteId: site.id, orderId: order?.id ?? null, communicationId: incoming.id,
          status: "FAILED", source: "model", skipReason: `model_${code}`,
          promptText: renderPrompt(messages),
        },
      });
      // Кончились деньги — это единственный сбой, который владелец обязан узнать сразу: сам он
      // ничего не заметит, а ассистент будет молчать по всем заказам. Один сигнал в сутки.
      if (code === "no_balance") await alertNoBalance(prisma, now()).catch(() => null);
      return;
    }

    let parsed = parseReply(raw);

    // Незнакомый номер назвал заказ. Нашли ровно один — привязываем разговор и спрашиваем
    // модель ещё раз, уже с данными заказа: человек ждёт ответа про свой заказ сейчас, а не в
    // следующем сообщении. Один повтор, не рекурсия: второй подсказки в ответе с заказом не бывает.
    // В сухом прогоне не привязываем: он ничего не меняет в данных, только смотрит.
    let linkedOrder: LoadedOrder | null = order;
    if (!order && parsed.orderHint && !site.aiDryRun) {
      const foundId = await findOrderByHint(prisma, site.id, parsed.orderHint).catch(() => null);
      const found = foundId ? await loadOrder(prisma, foundId) : null;
      // По найденному заказу действуют те же правила, что и по любому другому: выключен,
      // отменён или давно доставлен — не привязываем и отвечаем как незнакомому.
      const foundGate = found
        ? shouldConsider({
            mode: site.aiMode as AssistantMode,
            orderDisabled: found.aiDisabled,
            orderClosed: found.orderStatus === "CANCELLED",
            deliveredAt: deliveredMoment(found),
            text,
            lastAutomatedAt: null,
            repliesToday: 0,
            repliesTotal: 0,
            now: now(),
          })
        : null;
      if (found && foundGate?.ok) {
        await linkConversation(prisma, found.id, phone, incoming.storePhone).catch(() => null);
        linkedOrder = found;
        const again = buildMessages({
          knowledgeBase: site.aiKnowledgeBase,
          order: snapshot(found, site.name, incoming.partyRole),
          history: await loadHistory(prisma, found.id, phone, incoming.storePhone, incoming.id),
          incomingText: text,
        });
        try {
          const res = await client.complete(again);
          raw = res.text;
          latencyMs += res.latencyMs;
          parsed = parseReply(raw);
          messages.splice(0, messages.length, ...again);
        } catch {
          // Не вышло переспросить — остаёмся с ответом «без заказа», он безопасен.
        }
      }
    }

    const action = decideDelivery({
      mode: site.aiMode as AssistantMode,
      dryRun: site.aiDryRun,
      hasReply: !!parsed.replyEn,
      needsHuman: parsed.needsHuman,
      important: parsed.important,
    });

    // Клиент назвал время — это данные заказа, а не только реплика: строка в заметку сверху и
    // уведомление владельцу и флористу. В сухом прогоне не пишем и не уведомляем: он пассивный.
    if (parsed.readyTime && linkedOrder && !site.aiDryRun) {
      const forNote = linkedOrder;
      await recordReadyTime(prisma, forNote, incoming.id, parsed.readyTime, text).catch((err) =>
        console.error(`[assistant] заметка о времени по заказу ${forNote.id} не записана:`, err instanceof Error ? err.message : String(err))
      );
    }

    const turn = await prisma.aiTurn.create({
      data: {
        siteId: site.id,
        orderId: linkedOrder?.id ?? null,
        communicationId: incoming.id,
        status: "DRAFT",
        source: "model",
        intent: parsed.intent,
        important: parsed.important,
        needsHuman: parsed.needsHuman || action === "draft",
        replyText: parsed.replyEn || null,
        promptText: renderPrompt(messages),
        responseText: raw,
        modelName,
        latencyMs,
      },
      select: { id: true },
    });
    await finishTurn(prisma, turn.id, action, site.aiDryRun);
  };
}

/**
 * Что делать с готовым разбором: отправить самому или показать человеку.
 *
 * В сухом прогоне `decideDelivery` всегда возвращает черновик, и черновик приходит в Telegram с
 * пометкой «сухой прогон»: владелец проверяет кнопки и реплаи по-настоящему, а SMS клиенту на
 * последнем шаге не уходит (`sendAssistantReply` отвечает `dry_run`). Напоминание «one moment»
 * в сухом прогоне не ставится — оно единственное шло бы клиенту мимо кнопки.
 *
 * Не смогли отправить сами (номер не в заказе, QUO отказал) — черновик идёт человеку: молча
 * оставить его в карточке значит, что клиент не получит ответа вовсе.
 * Сбой показа не должен ронять разбор: черновик уже записан и виден в карточке заказа.
 */
async function finishTurn(prisma: PrismaClient, turnId: string, action: "send" | "draft", dryRun: boolean): Promise<void> {
  try {
    if (action === "send") {
      const res = await sendAssistantReply(prisma, turnId);
      if (res.ok) return;
      console.warn(`[assistant] автоответ ${turnId} не ушёл (${res.code}) — черновик человеку`);
    }
    const shown = await notifyDraft(prisma, turnId);
    // Напоминание ставим, только если черновик реально дошёл до человека: иначе «одну минуту»
    // уйдёт клиенту по разбору, которого никто не видел.
    if (shown && !dryRun) await scheduleAssistantNudge(new PrismaOutboxRepository(prisma), turnId, new Date());
  } catch (err) {
    console.error(`[assistant] показ черновика ${turnId} не удался:`, err instanceof Error ? err.message : String(err));
  }
}

/**
 * Текст входящего: у SMS — сам текст, у звонка — расшифровка или краткое содержание. Фото без
 * подписи — тоже сообщение: клиент прислал чек или букет и ждёт реакции, а не тишины. Модель
 * картинку не видит, поэтому ей говорится ровно это.
 */
function pickText(c: { messageText: string | null; transcript: string | null; summary: string | null; attachmentsJson?: Prisma.JsonValue | null }): string {
  const body = (c.messageText || c.transcript || c.summary || "").trim();
  const photos = parseAttachments(c.attachmentsJson).length;
  if (!photos) return body;
  const note = `[The customer sent ${photos === 1 ? "a photo" : `${photos} photos`}${body ? " with this text" : " without text"}. You cannot see images.]`;
  return body ? `${note}\n${body}` : note;
}

/**
 * Момент доставки. Своего поля у заказа нет; день доставки — ближайшая правда: «доставлен три
 * дня назад» — это про календарь, а не про секунду, когда курьер нажал кнопку.
 */
function deliveredMoment(order: { deliveryStatus: string; deliveryDate: Date | null; updatedAt: Date } | null): Date | null {
  if (!order || order.deliveryStatus !== "DELIVERED") return null;
  return order.deliveryDate ?? order.updatedAt;
}

async function lastAutomatedAt(prisma: PrismaClient, orderId: string): Promise<Date | null> {
  const row = await prisma.orderCommunication.findFirst({
    where: { orderId, direction: "OUTBOUND", OR: [{ automationJobs: { some: {} } }, { flowRunSteps: { some: {} } }] },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true },
  });
  return row?.occurredAt ?? null;
}

/**
 * Потолки: по заказу — на заказ, по незнакомому номеру — на номер: иначе у него потолков нет
 * вовсе. Сутки — календарные сутки МАГАЗИНА, а не UTC: полночь UTC в LA это 17:00, и по UTC
 * потолок обнулялся бы посреди рабочего дня.
 */
async function countReplies(
  prisma: PrismaClient,
  site: { timezone: string | null },
  orderId: string | null,
  phone: string,
  now: Date
): Promise<{ repliesToday: number; repliesTotal: number }> {
  const dayStart = zonedLocalTimeToUtc(todayStrInTz(site.timezone, now), "00:00", site.timezone);
  const scope = orderId ? { orderId } : { communication: { externalPhoneNormalized: phone } };
  const [repliesToday, repliesTotal] = await Promise.all([
    prisma.aiTurn.count({ where: { ...scope, status: "SENT", createdAt: { gte: dayStart } } }),
    prisma.aiTurn.count({ where: { ...scope, status: "SENT" } }),
  ]);
  return { repliesToday, repliesTotal };
}

async function alertNoBalance(prisma: PrismaClient, now: Date): Promise<void> {
  const since = new Date(now.getTime() - NO_BALANCE_ALERT_HOURS * 3_600_000);
  const recent = await prisma.aiTurn.count({ where: { status: "FAILED", skipReason: "model_no_balance", createdAt: { gte: since } } });
  // Текущая строка уже записана — «1» значит, что это первый сбой за сутки.
  if (recent > 1) return;
  await notifyOwnerText(prisma, "⚠️ <b>Ассистент остановлен</b>: у DeepSeek закончился баланс. Клиентам не отвечаем, пока баланс не пополнен.");
}

async function logSkip(prisma: PrismaClient, siteId: string, orderId: string | null, communicationId: string, reason: string) {
  await prisma.aiTurn.create({
    data: { siteId, orderId, communicationId, status: "SKIPPED", source: "none", skipReason: reason },
  });
}

/**
 * Переписка, старые сверху: ассистент не должен отвечать в вакууме. По заказу — вся переписка
 * заказа; у незнакомого номера — его разговор с этим номером магазина. Неотправленные и
 * упавшие исходящие не показываем: клиент их не видел, и модель не должна считать их сказанными.
 */
async function loadHistory(prisma: PrismaClient, orderId: string | null, phone: string, storePhone: string | null, exceptId: string): Promise<HistoryLine[]> {
  const rows = await prisma.orderCommunication.findMany({
    where: {
      ...(orderId ? { orderId } : { orderId: null, externalPhoneNormalized: phone, ...(storePhone ? { storePhone } : {}) }),
      id: { not: exceptId },
      OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED"] } }],
      // Звонок — такая же часть разговора, как SMS: клиент часто ссылается на сказанное голосом.
      AND: [{ OR: [{ messageText: { not: null } }, { transcript: { not: null } }, { summary: { not: null } }, { attachmentsJson: { not: Prisma.DbNull } }] }],
    },
    orderBy: { occurredAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, messageText: true, transcript: true, summary: true, type: true, occurredAt: true, attachmentsJson: true },
  });
  return rows
    .reverse()
    .map((r) => {
      const body = r.messageText ?? r.transcript ?? r.summary ?? "";
      const prefix = parseAttachments(r.attachmentsJson).length ? "(photo) " : r.messageText ? "" : "(call) ";
      return {
        direction: r.direction === "INBOUND" ? ("in" as const) : ("out" as const),
        text: `${prefix}${body}`.slice(0, 400),
        at: r.occurredAt.toISOString().slice(11, 16),
      };
    });
}

type OrderWithSite = { orderNumber: string; orderStatus: string; deliveryStatus: string | null; deliveryDate: Date | null; deliveryWindow: string | null; recipientName: string | null; deliveryAddress: string | null; trackingUrl: string | null; bouquetPhotoUrl: string | null; total: unknown };

function snapshot(order: Record<string, unknown>, storeName: string, partyRole: string): OrderSnapshot {
  const o = order as unknown as OrderWithSite;
  return {
    orderNumber: o.orderNumber,
    storeName,
    orderStatus: String(o.orderStatus).toLowerCase(),
    deliveryStatus: o.deliveryStatus ? String(o.deliveryStatus).toLowerCase() : null,
    deliveryDate: o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : null,
    deliveryWindow: o.deliveryWindow ?? null,
    recipientName: o.recipientName ?? null,
    deliveryAddress: o.deliveryAddress ?? null,
    trackingUrl: o.trackingUrl ?? null,
    // Клиенту уходит страница с фото, а не сырой файл (картинку в SMS не вложить).
    photoUrl: bouquetPageUrl(o.bouquetPhotoUrl),
    totalFormatted: o.total != null ? `$${String(o.total)}` : null,
    party: partyRole === "CUSTOMER" ? "customer" : partyRole === "RECIPIENT" ? "recipient" : "unknown",
  };
}

/** Полный текст запроса для журнала: владелец должен видеть, что именно спрашивали. */
function renderPrompt(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `[${m.role}]\n${m.content}`).join("\n\n");
}

/**
 * Слова клиента о времени готовности — в заметку заказа и в Telegram тем, кто везёт и кто
 * отвечает. Заметка перечитывается перед записью: пока шёл запрос к модели, её могли поправить
 * руками, и затирать чужую правку старой копией нельзя.
 */
async function recordReadyTime(
  prisma: PrismaClient,
  order: { id: string; currentFloristId: string | null; site: { timezone: string | null } },
  communicationId: string,
  readyTime: string,
  quote: string
): Promise<void> {
  const fresh = await prisma.order.findUnique({ where: { id: order.id }, select: { customerNote: true } });
  await prisma.order.update({
    where: { id: order.id },
    data: { customerNote: prependReadyTimeNote(fresh?.customerNote ?? "", readyTime, new Date(), order.site.timezone) },
  });
  const context = { readyTime, quote: quote.slice(0, 200) };
  await publishTelegramNotification(prisma, { type: "customer.ready_time", orderId: order.id, occurrenceKey: communicationId, context });
  if (order.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "customer.ready_time_florist", orderId: order.id, floristId: order.currentFloristId, occurrenceKey: communicationId, context,
    });
  }
}
