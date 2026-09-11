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
import { resolveDeepseekConfig } from "@/integrations/deepseek/settings";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { DeepseekError } from "@/integrations/deepseek/errors";
import { buildMessages, parseReply, describeDeliveryDay, type HistoryLine, type OrderSnapshot } from "./prompt";
import { matchIntent } from "./intents";
import { readTemplates, templateApplies, renderAssistantTemplate } from "./templates";
import { loadCatalog, looksLikeShopping } from "./catalog";
import { buildOrderVariables } from "@/modules/messaging/variables";
import { orderToVariableSource, SMS_ORDER_INCLUDE } from "@/modules/messaging/orderSource";
import { shouldConsider, decideDelivery, isCallRequest, isSmallTalk, type AssistantMode } from "./policy";
import { scheduleAssistantNudge, type AssistantIncomingPayload } from "./events";
import { PrismaOutboxRepository } from "@/outbox/prismaRepository";
import { sendAssistantReply, notifyDraft, notifyOwnerText, notifyBotText, escapeHtml } from "./deliver";
import { prependReadyTimeNote, hasReadyTime, mentionsTime } from "./note";
import { findOrderByHint, linkConversation } from "./link";
import { loadGlobalNote, activeGlobalNoteText } from "./globalNote";
import { bouquetPageUrl } from "@/lib/bouquetPage";
import { publishTelegramNotification } from "@/integrations/telegram/events";
import { todayStrInTz, zonedLocalTimeToUtc, localClock } from "@/lib/tz";

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
        type: true, partyRole: true, externalPhone: true, externalPhoneNormalized: true, storePhone: true, providerPhoneNumberId: true, occurredAt: true,
        attachmentsJson: true,
      },
    });
    if (!incoming || incoming.direction !== "INBOUND") return;
    const own = pickText(incoming);

    // Разбор уже был: одно входящее — один разбор, повтор обработчика ничего не создаёт.
    // Исключение — звонок: его запись создаётся до расшифровки, и первый разбор честно
    // пропустил пустой текст. Пришла расшифровка — тот разбор снимается, идёт настоящий.
    const existing = await prisma.aiTurn.findUnique({ where: { communicationId: incoming.id }, select: { id: true, status: true, skipReason: true } });
    if (existing) {
      if (!(existing.status === "SKIPPED" && existing.skipReason === "empty_text" && own.text)) return;
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

    // Человек написал очередью: «привезите к 11», через двадцать секунд «звоните в домофон».
    // Пока шла минутная пауза, те сообщения отложились в пользу этого — забираем их и отвечаем
    // на ВСЁ разом, одним ответом. Готовить по ответу на каждое предложение незачем: человек
    // писал одну мысль в три приёма.
    const deferred = await loadDeferred(prisma, incoming, order?.id ?? null, phone);
    const body = [...deferred.map((d) => d.body), own.body].filter((t) => t.trim()).join("\n");
    const text = [...deferred.map((d) => d.text), own.text].filter((t) => t.trim()).join("\n");
    const photoUrls = [...deferred.flatMap((d) => d.photoUrls), ...parseAttachments(incoming.attachmentsJson).map((a) => a.url)];
    const photos = photoUrls.length;
    const answeredIds = [...deferred.map((d) => d.id), incoming.id];
    // Человек в Telegram подтверждает ответ, поэтому видеть он обязан ВСЮ очередь, а не одну
    // последнюю реплику: иначе ответ про «11 утра» стоял бы под словами «just buzz the door».
    const burst = deferred.length ? { text: body, photoUrls } : null;

    // Просьба позвонить распознаётся и без модели: сигнал людям не должен зависеть от её сбоя.
    const callRequested = isCallRequest(body);

    // Просьба позвонить уходит людям ПЕРВЫМ делом — до потолков, тишины после автоматики и
    // прочих правил молчания. Эти правила про «не писать клиенту лишнего», а тут мы никому не
    // пишем: мы говорим своим, что человек ждёт звонка. Выключенный ассистент и галочка «без ИИ»
    // на заказе всё же уважаются: это прямой запрет владельца на всю работу по этому заказу.
    if (callRequested && site.aiMode !== "OFF" && !order?.aiDisabled) {
      await notifyCallRequest(prisma, order, site, incoming, body, now()).catch(logCallRequestError);
    }

    // Фото ассистент не комментирует ВООБЩЕ (решение владельца 07.09.2026). Картинку модель не
    // видит, и «спасибо, сейчас посмотрю» — это обещание за человека по содержимому, которого
    // никто не читал. Само фото никуда не делось: оно видно во вкладке общения в карточке заказа,
    // а в журнале остаётся строка с причиной. Просьбу позвонить мы к этому моменту уже передали.
    if (photos) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "photo");
      return;
    }

    const gate = shouldConsider({
      mode: site.aiMode as AssistantMode,
      orderDisabled: !!order?.aiDisabled,
      orderClosed: order?.orderStatus === "CANCELLED",
      deliveredAt: deliveredMoment(order),
      text,
      lastAutomatedAt: order ? await lastAutomatedAfter(prisma, order.id, incoming.occurredAt) : null,
      liveTalkAfterIncoming: await liveTalkAfter(prisma, phone, incoming.storePhone, incoming.occurredAt),
      ...(await countReplies(prisma, site, order?.id ?? null, phone, now())),
      now: now(),
    });
    if (!gate.ok) {
      // Отказ тоже записываем: «почему по заказу тишина» — первый вопрос владельца.
      if (gate.reason !== "assistant_off") await logSkip(prisma, site.id, order?.id ?? null, incoming.id, gate.reason);
      return;
    }

    // Человек дописал следующее сообщение, пока шла минутная пауза (`ASSISTANT_DELAY_SEC`):
    // это сообщение откладывается, а разбирать очередь будет ПОСЛЕДНЕЕ — оно заберёт отложенные
    // и ответит на всё разом (см. loadDeferred). Иначе три реплики подряд давали клиенту три SMS,
    // а людям три черновика.
    if (await hasNewerIncoming(prisma, incoming, order?.id ?? null, phone)) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "superseded");
      return;
    }

    // Общее правило владельца на все магазины: «сегодня выходной», «заказы со вторника». Пока
    // оно действует, заготовки на частые вопросы молчат — «привезём сегодня в 11» прямо спорило
    // бы с «сегодня не работаем», а правило свежее любого заготовленного текста.
    // Правило объявлено сильнее всего остального, поэтому его недоступность — это неизвестность,
    // а не «правила нет»: молча пообещать доставку в выходной хуже, чем промолчать и повторить.
    const globalNote = activeGlobalNoteText(await loadGlobalNote(prisma), now(), site.timezone);

    // Заготовка сильнее модели: на «где мой заказ» ответ один и тот же, и тратить на него запрос,
    // рискуя выдумкой, незачем. Только для заказов: у незнакомого номера подставлять нечего.
    // Сопоставляем СЛОВА клиента, а не служебную пометку о фото: «клиент прислал фото» — это не
    // просьба прислать фото. Пришло фото — заготовки вообще мимо, там решает человек.
    if (order && !photos && !globalNote) {
      const intent = matchIntent(body);
      if (intent) {
        const setting = readTemplates(site.aiTemplatesJson)[intent.key];
        const vars = buildOrderVariables(orderToVariableSource(order));
        const state = {
          // «Доставлен» — это статус ЗАКАЗА: поле Order.deliveryStatus никто не пишет, оно всегда PENDING.
          deliveryStatus: order.orderStatus === "DELIVERED" ? "DELIVERED" : order.deliveryStatus,
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
            await finishTurn(prisma, turn.id, action, site.aiDryRun, burst);
            return;
          }
        }
      }
    }

    const cfg = await resolveDeepseekConfig(prisma);
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    if (!client) {
      await logSkip(prisma, site.id, order?.id ?? null, incoming.id, "model_not_configured");
      return;
    }

    // Каталог нужен не всегда: на «во сколько привезут» он только раздувает запрос. Но у
    // незнакомого номера разговор почти всегда про покупку, поэтому там он идёт сразу.
    const wantsCatalog = !order || looksLikeShopping(text);
    const clock = localClock(site.timezone, now());
    const messages = buildMessages({
      knowledgeBase: order ? site.aiKnowledgeBase : site.aiUnknownKnowledgeBase,
      order: order ? snapshot(order, site.name, incoming.partyRole, clock.dateStr) : null,
      history: await loadHistory(prisma, order?.id ?? null, phone, incoming.storePhone, incoming, site.timezone, answeredIds),
      now: clock,
      globalNote,
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
            // Живой разговор проверен выше, до обращения к модели: сюда мы доходим только
            // когда его не было.
            liveTalkAfterIncoming: null,
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
          order: snapshot(found, site.name, incoming.partyRole, clock.dateStr),
          history: await loadHistory(prisma, found.id, phone, incoming.storePhone, incoming, site.timezone, answeredIds),
          now: clock,
          globalNote,
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

    // Спам и реклама: молчим и никого не будим. Строка в журнале остаётся, чтобы было видно, что
    // сообщение разобрано и отброшено осознанно, а не потеряно. Но «важное» спамом не бывает:
    // одна ошибка классификации не должна проглотить отмену заказа или жалобу — такое идёт
    // человеку обычным путём.
    if (parsed.intent === "spam" && !parsed.important) {
      await prisma.aiTurn.create({
        data: {
          siteId: site.id, orderId: linkedOrder?.id ?? null, communicationId: incoming.id,
          status: "SKIPPED", source: "model", intent: "spam", skipReason: "spam",
          promptText: renderPrompt(messages), responseText: raw, modelName, latencyMs,
        },
      });
      return;
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
    // Время берётся только когда оно есть в САМОМ сообщении: модель тянет его из истории, и на
    // «Just buzz the door» второй раз уходило «around 11am» — в заметку, владельцу и флористу.
    if (parsed.readyTime && !mentionsTime(body)) parsed = { ...parsed, readyTime: null };
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
    // Модель разглядела просьбу позвонить там, где слова её не выдали («I would rather hear a
    // voice»). Своими словами распознанное уже ушло выше; здесь — только добавка модели.
    if (!callRequested && parsed.intent === "call_request") {
      await notifyCallRequest(prisma, linkedOrder, site, incoming, body, now()).catch(logCallRequestError);
    }
    await finishTurn(prisma, turn.id, action, site.aiDryRun, burst);
  };
}

function logCallRequestError(err: unknown) {
  console.error("[assistant] сигнал «клиент просит позвонить» не ушёл:", err instanceof Error ? err.message : String(err));
}

/**
 * Клиент просит позвонить — владельцу и оператору колл-центра сразу, ещё до того, как решится
 * судьба ответа: живой звонок важнее любого текста. По заказу — через общий реестр событий
 * Telegram (durable, с карточкой заказа); незнакомому номеру карточки нет, поэтому прямой
 * текст в те же два бота. В сухом прогоне оператора не трогаем: проверяет владелец.
 */
async function notifyCallRequest(
  prisma: PrismaClient,
  order: { id: string } | null,
  site: { name: string; aiDryRun: boolean },
  incoming: { id: string; externalPhone: string; externalPhoneNormalized: string },
  quote: string,
  now: Date = new Date()
): Promise<void> {
  const note = site.aiDryRun ? "🧪 Сухой прогон" : null;
  if (order) {
    // Случай — разговор плюс двухчасовое окно: очередь сама не пропустит второй такой же ключ,
    // и людям уходит один сигнал, даже если клиент попросил позвонить трижды подряд.
    const occurrence = `${order.id}:${incoming.externalPhoneNormalized}:${callRequestBucket(now)}`;
    const context = { quote: quote.slice(0, 200), phone: incoming.externalPhone, occurrence, note };
    await publishTelegramNotification(prisma, { type: "customer.call_request", orderId: order.id, occurrenceKey: occurrence, context });
    if (!site.aiDryRun) {
      await publishTelegramNotification(prisma, { type: "customer.call_request_cc", orderId: order.id, occurrenceKey: occurrence, context });
    }
    return;
  }
  const text =
    `📞 <b>${note ? `${note} · ` : ""}Клиент просит позвонить</b> · незнакомый номер ${escapeHtml(incoming.externalPhone)} · ${escapeHtml(site.name)}\n\n` +
    `Сообщение: ${escapeHtml(quote.slice(0, 300))}\n\nПозвоните клиенту.`;
  await notifyBotText(prisma, "OWNER", text);
  if (!site.aiDryRun) await notifyBotText(prisma, "CUSTOMER_SERVICE", text);
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
async function finishTurn(
  prisma: PrismaClient,
  turnId: string,
  action: "send" | "draft",
  dryRun: boolean,
  /** Очередь сообщений, на которую отвечаем, — её показываем человеку вместо одной реплики. */
  burst: { text: string; photoUrls: string[] } | null = null
): Promise<void> {
  try {
    if (action === "send") {
      const res = await sendAssistantReply(prisma, turnId);
      if (res.ok) return;
      console.warn(`[assistant] автоответ ${turnId} не ушёл (${res.code}) — черновик человеку`);
    }
    const shown = await notifyDraft(prisma, turnId, new Date(), burst);
    // Напоминание ставим, только если черновик реально дошёл до человека: иначе «одну минуту»
    // уйдёт клиенту по разбору, которого никто не видел.
    if (shown && !dryRun) await scheduleAssistantNudge(new PrismaOutboxRepository(prisma), turnId, new Date());
  } catch (err) {
    console.error(`[assistant] показ черновика ${turnId} не удался:`, err instanceof Error ? err.message : String(err));
  }
}

/** Насколько назад собираем очередь сообщений: дальше это уже отдельный разговор. */
const BURST_WINDOW_MIN = 15;

/**
 * Сколько сообщений очереди забираем максимум. Что не влезло — не потеряно: модель всё равно
 * видит эти сообщения в истории переписки, просто отвечаем мы не на них.
 */
const BURST_MAX = 10;

/**
 * Очередь сообщений, отложенных В ПОЛЬЗУ разбираемого: идём от свежих к старым, пока сообщения
 * откладывались, и останавливаемся на первом УЖЕ РАЗОБРАННОМ. Ниже него очередь закрыта ответом,
 * и отвечать на те же слова второй раз нельзя: строка `superseded` остаётся в журнале навсегда,
 * поэтому «всё отложенное за 15 минут» через пять минут притащило бы разобранное заново.
 *
 * Вход — от свежих к старым, выход — в том порядке, в котором человек писал.
 */
export function takeDeferredQueue<T extends { status: string; skipReason: string | null }>(newestFirst: T[]): T[] {
  const queue: T[] = [];
  for (const r of newestFirst) {
    if (!(r.status === "SKIPPED" && r.skipReason === "superseded")) break;
    queue.push(r);
  }
  return queue.reverse();
}

/**
 * Сообщения, которые в этом разговоре отложились В ПОЛЬЗУ разбираемого: каждое из них честно
 * записало причину `superseded`, и отвечать на них по отдельности мы не собирались.
 *
 * Берём именно их, а не «всё, что пришло за N минут»: так граница очереди определяется решением,
 * которое уже принято и записано, а не догадкой про исходящие. Если ни одного нет — очередь из
 * одного сообщения, и всё работает как раньше.
 */
async function loadDeferred(
  prisma: PrismaClient,
  incoming: { id: string; occurredAt: Date; storePhone: string | null },
  orderId: string | null,
  phone: string
): Promise<{ id: string; body: string; text: string; photoUrls: string[] }[]> {
  const since = new Date(incoming.occurredAt.getTime() - BURST_WINDOW_MIN * 60_000);
  const rows = await prisma.aiTurn.findMany({
    where: {
      // Тот же разговор, что у истории и у проверки «есть ли новее»: заказ И номер, а у
      // незнакомого номера — его переписка с этим номером магазина. Иначе в очередь попало бы
      // сообщение того же человека по ДРУГОМУ заказу, и ответ ушёл бы не про тот букет.
      communication: {
        externalPhoneNormalized: phone,
        occurredAt: { gte: since, lt: incoming.occurredAt },
        ...(orderId ? { orderId } : { orderId: null, ...(incoming.storePhone ? { storePhone: incoming.storePhone } : {}) }),
      },
    },
    orderBy: { communication: { occurredAt: "desc" } },
    take: BURST_MAX,
    select: {
      status: true,
      skipReason: true,
      communication: {
        select: { id: true, messageText: true, transcript: true, summary: true, attachmentsJson: true },
      },
    },
  });
  return takeDeferredQueue(rows).map((r) => ({
    id: r.communication.id,
    ...pickText(r.communication),
    photoUrls: parseAttachments(r.communication.attachmentsJson).map((a) => a.url),
  }));
}

/**
 * Есть ли в этом разговоре сообщение клиента ПОЗЖЕ разбираемого, на которое стоит отвечать.
 * Пустые и вежливые точки не считаются: иначе «спасибо» после вопроса отменило бы ответ на сам
 * вопрос, и клиент не получил бы ничего.
 */
async function hasNewerIncoming(
  prisma: PrismaClient,
  incoming: { id: string; occurredAt: Date; storePhone: string | null },
  orderId: string | null,
  phone: string
): Promise<boolean> {
  const rows = await prisma.orderCommunication.findMany({
    where: {
      direction: "INBOUND",
      id: { not: incoming.id },
      occurredAt: { gt: incoming.occurredAt },
      externalPhoneNormalized: phone,
      ...(orderId ? { orderId } : { orderId: null, ...(incoming.storePhone ? { storePhone: incoming.storePhone } : {}) }),
    },
    select: { messageText: true, transcript: true, summary: true, attachmentsJson: true },
    // Ближайшие следующие сообщения, а не пять случайных: иначе «есть ли новое» отвечало наугад.
    orderBy: { occurredAt: "asc" },
    take: 5,
  });
  return rows.some((r) => {
    const { body, photos } = pickText(r);
    // На фото мы не отвечаем, поэтому «дальше пришло фото» не отменяет ответ на вопрос до него.
    // Смотрим на слова клиента, а не на служебную пометку о фото из pickText.
    return !photos && !!body.trim() && !isSmallTalk(body);
  });
}

/** Окно, в котором повторная просьба позвонить считается тем же разговором. */
const CALL_REQUEST_WINDOW_MIN = 120;

/**
 * Номер двухчасового окна. Ключ идемпотентности с ним гасит повтор В САМОЙ ОЧЕРЕДИ: «уже
 * публиковали» — это факт, а не догадка по журналу. Прошлая проверка искала строку разбора и
 * потому считала уведомлением даже отказ («superseded», «потолок»), после которого никому
 * ничего не ушло, — и настоящая просьба пропадала на два часа.
 */
function callRequestBucket(now: Date): string {
  return String(Math.floor(now.getTime() / (CALL_REQUEST_WINDOW_MIN * 60_000)));
}


/**
 * Текст входящего: у SMS — сам текст, у звонка — расшифровка или краткое содержание. Фото без
 * подписи — тоже сообщение: клиент прислал чек или букет и ждёт реакции, а не тишины. Модель
 * картинку не видит, поэтому ей говорится ровно это.
 */
function pickText(c: { messageText: string | null; transcript: string | null; summary: string | null; attachmentsJson?: Prisma.JsonValue | null }): { body: string; text: string; photos: number } {
  const body = (c.messageText || c.transcript || c.summary || "").trim();
  const photos = parseAttachments(c.attachmentsJson).length;
  if (!photos) return { body, text: body, photos };
  const note = `[The customer sent ${photos === 1 ? "a photo" : `${photos} photos`}${body ? " with this text" : " without text"}. You cannot see images.]`;
  return { body, text: body ? `${note}\n${body}` : note, photos };
}

/**
 * Момент доставки. Доставлен ли заказ, говорит `orderStatus` (Burq и магазин переводят в
 * DELIVERED именно его; `Order.deliveryStatus` никто не пишет). Своего поля-момента у заказа нет;
 * день доставки — ближайшая правда: «доставлен три дня назад» — это про календарь.
 */
function deliveredMoment(order: { orderStatus: string; deliveryDate: Date | null; updatedAt: Date } | null): Date | null {
  if (!order || order.orderStatus !== "DELIVERED") return null;
  return order.deliveryDate ?? order.updatedAt;
}

/**
 * Автоматическое сообщение, ушедшее ПОСЛЕ входящего: тогда ответ ассистента лёг бы вторым
 * подряд, и правило тишины его гасит. Автоматика ДО входящего не считается: клиент отвечает на
 * наш же вопрос («до какого времени будете дома?»), и молчать в ответ — ровно то, чего нельзя.
 */
async function lastAutomatedAfter(prisma: PrismaClient, orderId: string, since: Date): Promise<Date | null> {
  const row = await prisma.orderCommunication.findFirst({
    where: { orderId, direction: "OUTBOUND", occurredAt: { gt: since }, OR: [{ automationJobs: { some: {} } }, { flowRunSteps: { some: {} } }] },
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
/**
 * Состоявшийся разговор голосом с этим номером ПОСЛЕ разбираемого сообщения.
 *
 * Считаем только СОСТОЯВШИЕСЯ звонки и голосовые: пропущенный входящий — это не разговор, там
 * никто ничего не обсудил. Направление не важно: и «мы позвонили клиенту», и «клиент дозвонился
 * до нас» одинаково означают, что вопрос разобрал человек.
 */
async function liveTalkAfter(
  prisma: PrismaClient,
  phone: string,
  storePhone: string | null,
  after: Date
): Promise<{ at: Date; kind: "call" | "voicemail" } | null> {
  const row = await prisma.orderCommunication.findFirst({
    where: {
      externalPhoneNormalized: phone,
      ...(storePhone ? { storePhone } : {}),
      occurredAt: { gt: after },
      OR: [
        { type: "CALL", status: "COMPLETED" },
        { type: "VOICEMAIL" },
      ],
    },
    orderBy: { occurredAt: "desc" },
    select: { occurredAt: true, type: true },
  });
  if (!row) return null;
  return { at: row.occurredAt, kind: row.type === "VOICEMAIL" ? "voicemail" : "call" };
}

/**
 * Как звонок выглядит в истории, когда слушать нечего.
 *
 * Пишем по-английски и в скобках — вся история уходит модели на английском, и по скобкам она
 * отличает пометку системы от слов человека. Длительность важна: пятисекундный «звонок» — это
 * не разговор, а десятиминутный почти наверняка закрыл все вопросы.
 */
export function describeCall(r: { type: string; status: string; direction: string; durationSeconds: number | null }): string {
  if (r.type === "VOICEMAIL") return "(voicemail left by the customer — we cannot read it)";
  if (r.status === "MISSED") return r.direction === "INBOUND" ? "(missed call from the customer)" : "(no answer)";
  const who = r.direction === "INBOUND" ? "customer called the shop" : "the shop called the customer";
  const mins = r.durationSeconds != null ? Math.max(1, Math.round(r.durationSeconds / 60)) : null;
  return `(phone call — ${who}${mins ? `, about ${mins} min` : ""}; what was said is not available)`;
}

async function loadHistory(prisma: PrismaClient, orderId: string | null, phone: string, storePhone: string | null, incoming: { id: string; occurredAt: Date }, tz: string | null, exceptIds: string[] = []): Promise<HistoryLine[]> {
  const rows = await prisma.orderCommunication.findMany({
    where: {
      // ТОЛЬКО переписка с этим номером. У заказа две стороны — заказчик и получатель, и у
      // каждой свой разговор. Склеенные в одну ленту, они путают модель («мне сказали в 11» —
      // сказал другой человек) и показывают одному то, что другой писал лично. Так же устроены
      // и вкладки общения в карточке заказа: сторону определяет номер сообщения.
      externalPhoneNormalized: phone,
      ...(orderId ? { orderId } : { orderId: null, ...(storePhone ? { storePhone } : {}) }),
      // Сообщения, на которые отвечаем сейчас, в историю не идут: они и есть новое сообщение.
      id: { notIn: exceptIds.length ? exceptIds : [incoming.id] },
      // Только то, что было ДО разбираемого сообщения: при повторном разборе старого входящего
      // модель не должна отвечать на него, зная, чем разговор кончился.
      occurredAt: { lte: incoming.occurredAt },
      OR: [{ direction: "INBOUND" }, { direction: "OUTBOUND", status: { in: ["SENT", "DELIVERED"] } }],
      // Звонок — такая же часть разговора, как SMS, и попадает сюда ДАЖЕ БЕЗ текста.
      //
      // Раньше условие требовало текст, транскрипт, резюме или вложение — а на аккаунте QUO
      // транскриптов нет ни одного (1768 звонков за 90 дней, 0 транскриптов). Значит каждый
      // разговор голосом выпадал из истории целиком, и модель отвечала так, будто его не было:
      // владелец созванивался с клиентом, всё обсуждал, а следом уходил вопрос «когда вам удобно
      // принять доставку?». Прочитать разговор модель по-прежнему не может, но знать, что он
      // БЫЛ, обязана — иначе переспрашивает уже решённое.
      AND: [
        {
          OR: [
            { messageText: { not: null } },
            { transcript: { not: null } },
            { summary: { not: null } },
            { attachmentsJson: { not: Prisma.DbNull } },
            { type: { in: ["CALL", "VOICEMAIL"] } },
          ],
        },
      ],
    },
    orderBy: { occurredAt: "desc" },
    take: HISTORY_LIMIT,
    select: { direction: true, messageText: true, transcript: true, summary: true, type: true, status: true, durationSeconds: true, occurredAt: true, attachmentsJson: true },
  });
  return rows
    .reverse()
    .map((r) => {
      const body = r.messageText ?? r.transcript ?? r.summary ?? describeCall(r);
      const prefix = parseAttachments(r.attachmentsJson).length ? "(photo) " : r.messageText ? "" : "";
      const clock = localClock(tz, r.occurredAt);
      return {
        direction: r.direction === "INBOUND" ? ("in" as const) : ("out" as const),
        text: `${prefix}${body}`.slice(0, 400),
        // Время по часам магазина и с датой: «вчера в 18:40» и «сегодня в 09:10» модель обязана различать.
        at: `${clock.dateStr.slice(5)} ${clock.timeStr}`,
      };
    });
}

type OrderWithSite = { orderNumber: string; orderStatus: string; deliveryStatus: string | null; deliveryDate: Date | null; deliveryWindow: string | null; recipientName: string | null; deliveryAddress: string | null; trackingUrl: string | null; bouquetPhotoUrl: string | null; total: unknown };

function snapshot(order: Record<string, unknown>, storeName: string, partyRole: string, todayStr: string): OrderSnapshot {
  const o = order as unknown as OrderWithSite;
  const deliveryDate = o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : null;
  return {
    orderNumber: o.orderNumber,
    storeName,
    orderStatus: String(o.orderStatus).toLowerCase(),
    // Модели нельзя говорить «delivery pending» по доставленному заказу: правда о доставке — в
    // статусе заказа, а Order.deliveryStatus всегда PENDING (его никто не пишет).
    deliveryStatus: o.orderStatus === "DELIVERED" ? "delivered" : o.orderStatus === "CANCELLED" ? null : o.deliveryStatus ? String(o.deliveryStatus).toLowerCase() : null,
    deliveryDate,
    deliveryDayLabel: describeDeliveryDay(deliveryDate, todayStr),
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
  // То же время уже записано — второй раз не пишем и никого не дёргаем.
  if (hasReadyTime(fresh?.customerNote ?? "", readyTime)) return;
  await prisma.order.update({
    where: { id: order.id },
    data: { customerNote: prependReadyTimeNote(fresh?.customerNote ?? "", readyTime, new Date(), order.site.timezone) },
  });
  const context = { readyTime, quote: quote.slice(0, 200), occurrence: communicationId };
  await publishTelegramNotification(prisma, { type: "customer.ready_time", orderId: order.id, occurrenceKey: communicationId, context });
  if (order.currentFloristId) {
    await publishTelegramNotification(prisma, {
      type: "customer.ready_time_florist", orderId: order.id, floristId: order.currentFloristId, occurrenceKey: communicationId, context,
    });
  }
}
