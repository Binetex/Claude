import "server-only";
/**
 * Ответы владельца в Telegram: подтверждение кнопкой и свой текст реплаем.
 *
 * Правила разговора здесь ровно те, о которых просил владелец:
 *  - реагируем ТОЛЬКО на ответ реплаем на сообщение бота — иначе любая реплика в чате
 *    превратилась бы в SMS клиенту;
 *  - «+», «ок», «да» и подобное означают «отправляй как есть»;
 *  - любой другой текст считается его собственным ответом, переводится на английский и
 *    показывается на подтверждение кнопкой: клиенту уходит только то, что он увидел глазами.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { TelegramSender } from "@/integrations/telegram/sender";
import { resolveBotById } from "@/integrations/telegram/bots";
import { getDeepseekConfig } from "@/integrations/deepseek/config";
import { createDeepseekClient, type DeepseekClient } from "@/integrations/deepseek/client";
import { sendAssistantReply, discardAssistantReply, escapeHtml, SEND_ACTION_PREFIX, DISCARD_ACTION_PREFIX } from "./deliver";
import { looksEnglish } from "./prompt";
import { getSpeechConfig, createTranscriber, type Transcriber } from "@/integrations/speech/transcribe";

export const TELEGRAM_UPDATE_EVENT = "assistant.telegram.update";

export type TelegramUpdatePayload = { botId: string; update: Record<string, unknown> };

/** Слова, означающие «отправляй как есть». Всё остальное — собственный текст владельца. */
const CONFIRM_WORDS = new Set(["+", "++", "ок", "окей", "ok", "okay", "да", "yes", "y", "send", "отправь", "отправить", "шли", "go", "👍", "✅"]);
/** Слова, означающие «не отвечать». */
const DISCARD_WORDS = new Set(["-", "--", "нет", "no", "не надо", "не отвечать", "отмена", "cancel", "skip", "❌", "👎"]);

export function isConfirmation(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  return CONFIRM_WORDS.has(t);
}

export function isDiscard(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  return DISCARD_WORDS.has(t);
}

/** Голосовое длиннее этого не скачиваем: минутный ответ клиенту в SMS всё равно не влезет. */
export const MAX_VOICE_BYTES = 2 * 1024 * 1024;
const VOICE_FETCH_TIMEOUT_MS = 15_000;

/**
 * Перевод ответа владельца на английский. Клиенту уходит только английский — это правило жёстче
 * любой инструкции, поэтому текст, не похожий на английский после перевода, не отправляется вовсе.
 */
export async function translateForCustomer(client: DeepseekClient, text: string): Promise<string | null> {
  try {
    const res = await client.complete([
      {
        role: "system",
        content:
          'You translate a flower shop manager\'s reply into English for an SMS to a customer. Keep it short and natural, no greetings, no signature, no quotes. If the text is already English, return it unchanged. Answer with JSON only: {"text": "..."}',
      },
      { role: "user", content: text },
    ]);
    const parsed = JSON.parse(res.text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim()) as { text?: unknown };
    const out = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!out || !looksEnglish(out)) return null;
    return out;
  } catch {
    return null;
  }
}

type Deps = { client?: DeepseekClient | null; transcriber?: Transcriber | null; fetchImpl?: typeof fetch };

/**
 * Разбор одного обновления Telegram. Возвращает ничего: всё, что нужно сказать человеку,
 * говорится ему же в чат.
 */
export function buildTelegramUpdateHandler(prisma: PrismaClient, deps: Deps = {}) {
  return async (record: { payload: unknown }): Promise<void> => {
    const p = record.payload as TelegramUpdatePayload;
    if (!p?.botId || !p?.update) return;

    const lookup = await resolveBotById(prisma, p.botId);
    if (!("bot" in lookup)) return;
    const sender = new TelegramSender(lookup.bot.token);
    const update = p.update as {
      callback_query?: { id: string; data?: string; message?: { message_id?: number; chat?: { id?: number | string } } };
      message?: {
        text?: string;
        voice?: { file_id: string; mime_type?: string; file_size?: number };
        chat?: { id?: number | string };
        reply_to_message?: { message_id?: number };
      };
    };

    // Бот отвечает только в свой чат: сообщение из чужого чата (бота добавили в группу) —
    // не команда владельца, что бы в нём ни было написано.
    const fromChat = (c: { id?: number | string } | undefined) => (c?.id != null ? String(c.id) : null);

    // ── Нажатие кнопки ──
    const cb = update.callback_query;
    if (cb?.data) {
      const chatId = fromChat(cb.message?.chat);
      if (chatId !== lookup.bot.chatId) {
        await sender.answerCallback(cb.id, "Не тот чат.");
        return;
      }
      const isSend = cb.data.startsWith(SEND_ACTION_PREFIX);
      const isDiscardBtn = cb.data.startsWith(DISCARD_ACTION_PREFIX);
      if (!isSend && !isDiscardBtn) return;
      const turnId = cb.data.slice((isSend ? SEND_ACTION_PREFIX : DISCARD_ACTION_PREFIX).length);

      const res = isSend ? await sendAssistantReply(prisma, turnId) : await discardAssistantReply(prisma, turnId);
      // Второе нажатие по уже решённому черновику — не ошибка: человек просто нажал дважды.
      const already = !res.ok && res.code === "already_decided";
      const dry = !res.ok && res.code === "dry_run";
      const okText = isSend ? "✅ Отправлено клиенту." : "🚫 Не отвечаем.";
      const failText = already ? "Уже решено раньше." : dry ? "🧪 Сухой прогон: всё сработало, клиенту НЕ отправлено." : `⚠️ Не отправилось: ${res.ok ? "" : describe(res.code)}`;
      await sender.answerCallback(cb.id, res.ok ? okText : failText);
      if (cb.message?.message_id != null && !already) {
        // Кнопки убираем в любом случае: висящая «Отправить» после отправки — приглашение
        // нажать второй раз и гадать, ушло ли.
        await sender.editMessage(chatId, String(cb.message.message_id), res.ok ? okText : failText);
      }
      return;
    }

    // ── Ответ реплаем: текстом или голосом ──
    const msg = update.message;
    const replyToId = msg?.reply_to_message?.message_id;
    if (!replyToId) return; // сообщение мимо бота нас не касается
    const chatId = fromChat(msg?.chat);
    if (chatId !== lookup.bot.chatId) return;

    // Ищем по паре чат + сообщение: у каждого бота свой счётчик message_id, и один номер у
    // владельца и у флориста — разные черновики.
    const turn = await prisma.aiTurn.findFirst({
      where: { telegramChatId: chatId, telegramMessageId: String(replyToId) },
      select: { id: true, status: true, replyText: true },
      orderBy: { createdAt: "desc" },
    });
    if (!turn) return;

    let text = (msg?.text ?? "").trim();

    // Голосовое: скачиваем у Telegram, расшифровываем и дальше ведём как напечатанный текст.
    // Распознавание не подключено или не справилось — просим написать: молча проглотить
    // голосовое значит оставить владельца в уверенности, что ответ ушёл.
    if (!text && msg?.voice?.file_id) {
      const speechCfg = getSpeechConfig();
      const transcriber = deps.transcriber ?? (speechCfg ? createTranscriber(speechCfg) : null);
      if (!transcriber) {
        await sender.sendMessage(chatId, "Голосовые пока не подключены — напишите ответ текстом.");
        return;
      }
      if ((msg.voice.file_size ?? 0) > MAX_VOICE_BYTES) {
        await sender.sendMessage(chatId, "Слишком длинное голосовое. Скажите короче или напишите текстом.");
        return;
      }
      const spoken = await transcribeVoice(sender, msg.voice, transcriber, deps.fetchImpl ?? fetch);
      if (!spoken) {
        await sender.sendMessage(chatId, "Не разобрал голосовое. Напишите ответ текстом.");
        return;
      }
      text = spoken;
    }
    if (!text) return;
    if (turn.status !== "DRAFT") {
      await sender.sendMessage(chatId, "По этому сообщению уже принято решение.");
      return;
    }

    // «+» или «ок» — отправляем то, что владелец уже прочитал.
    if (isConfirmation(text)) {
      const res = await sendAssistantReply(prisma, turn.id);
      await sender.sendMessage(
        chatId,
        res.ok ? "✅ Отправлено клиенту." : res.code === "dry_run" ? "🧪 Сухой прогон: всё сработало, клиенту НЕ отправлено." : `⚠️ Не отправилось: ${describe(res.code)}`
      );
      return;
    }
    if (isDiscard(text)) {
      const res = await discardAssistantReply(prisma, turn.id);
      await sender.sendMessage(chatId, res.ok ? "🚫 Не отвечаем." : "Уже решено раньше.");
      return;
    }

    // Свой текст: переводим и показываем на подтверждение. Отправлять сразу нельзя — владелец
    // должен увидеть, что именно уйдёт клиенту по-английски.
    const cfg = getDeepseekConfig();
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    const english = client ? await translateForCustomer(client, text) : looksEnglish(text) ? text : null;
    if (!english) {
      await sender.sendMessage(chatId, "Не смог перевести на английский. Напишите ответ по-английски — покажу на подтверждение.");
      return;
    }

    await prisma.aiTurn.update({ where: { id: turn.id }, data: { replyText: english, source: "human" } });
    const res = await sender.sendMessage(chatId, `Отправить клиенту такой текст?\n\n${escapeHtml(english)}`, [
      { text: "Отправить", callbackData: `${SEND_ACTION_PREFIX}${turn.id}` },
      { text: "Не отвечать", callbackData: `${DISCARD_ACTION_PREFIX}${turn.id}` },
    ]);
    // Подтверждение — новое сообщение бота, и реплаить теперь надо на него.
    if (res.ok) await prisma.aiTurn.update({ where: { id: turn.id }, data: { telegramMessageId: res.messageId, telegramChatId: chatId } });
  };
}

/** Коды отказа — человеку в чат, а не в лог: он должен понять, что делать дальше. */
function describe(code: string): string {
  switch (code) {
    case "dry_run": return "у магазина включён сухой прогон";
    case "assistant_off": return "ассистент выключен";
    case "order_disabled": return "ассистент выключен на этом заказе";
    case "no_text": return "нет текста ответа";
    case "turn_not_found": return "черновик не найден";
    default: return code;
  }
}

/** Скачивает голосовое из Telegram и отдаёт расшифровку. Любой сбой — null. */
async function transcribeVoice(
  sender: TelegramSender,
  voice: { file_id: string; mime_type?: string },
  transcriber: Transcriber,
  fetchImpl: typeof fetch
): Promise<string | null> {
  const url = await sender.getFileUrl(voice.file_id);
  if (!url) return null;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(VOICE_FETCH_TIMEOUT_MS) }).catch(() => null);
  if (!res?.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0 || bytes.length > MAX_VOICE_BYTES) return null;
  return transcriber({ bytes, filename: "voice.ogg", mime: voice.mime_type || "audio/ogg" });
}
