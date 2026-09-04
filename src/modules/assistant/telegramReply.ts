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
import { sendAssistantReply, SEND_ACTION_PREFIX } from "./deliver";
import { getSpeechConfig, createTranscriber, type Transcriber } from "@/integrations/speech/transcribe";

export const TELEGRAM_UPDATE_EVENT = "assistant.telegram.update";

export type TelegramUpdatePayload = { botId: string; update: Record<string, unknown> };

/** Слова, означающие «отправляй как есть». Всё остальное — собственный текст владельца. */
const CONFIRM_WORDS = new Set(["+", "++", "ок", "окей", "ok", "okay", "да", "yes", "y", "send", "отправь", "отправить", "шли", "go", "👍", "✅"]);

export function isConfirmation(raw: string): boolean {
  const t = raw.trim().toLowerCase().replace(/[.!]+$/, "");
  return CONFIRM_WORDS.has(t);
}

/**
 * Перевод ответа владельца на английский. Клиенту уходит только английский — это правило жёстче
 * любой инструкции, поэтому текст с кириллицей после перевода не отправляется вовсе.
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
    if (!out || /[Ѐ-ӿ]/.test(out)) return null;
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
        voice?: { file_id: string; mime_type?: string };
        chat?: { id?: number | string };
        reply_to_message?: { message_id?: number };
      };
    };

    // ── Нажатие кнопки «Отправить» ──
    const cb = update.callback_query;
    if (cb?.data?.startsWith(SEND_ACTION_PREFIX)) {
      const turnId = cb.data.slice(SEND_ACTION_PREFIX.length);
      const res = await sendAssistantReply(prisma, turnId);
      await sender.answerCallback(cb.id, res.ok ? "Отправлено" : `Не ушло: ${res.code}`);
      const chatId = cb.message?.chat?.id != null ? String(cb.message.chat.id) : lookup.bot.chatId;
      if (cb.message?.message_id != null) {
        // Кнопку убираем в любом случае: висящая «Отправить» после отправки — приглашение
        // нажать второй раз и гадать, ушло ли.
        await sender.editMessage(
          chatId,
          String(cb.message.message_id),
          res.ok ? "✅ Отправлено клиенту." : `⚠️ Не отправилось: ${res.code}`
        );
      }
      return;
    }

    // ── Ответ реплаем: текстом или голосом ──
    const msg = update.message;
    const replyToId = msg?.reply_to_message?.message_id;
    if (!replyToId) return; // сообщение мимо бота нас не касается
    const chatId = msg?.chat?.id != null ? String(msg.chat.id) : lookup.bot.chatId;

    const turn = await prisma.aiTurn.findFirst({
      where: { telegramMessageId: String(replyToId) },
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
      await sender.sendMessage(chatId, res.ok ? "✅ Отправлено клиенту." : `⚠️ Не отправилось: ${res.code}`);
      return;
    }

    // Свой текст: переводим и показываем на подтверждение. Отправлять сразу нельзя — владелец
    // должен увидеть, что именно уйдёт клиенту по-английски.
    const cfg = getDeepseekConfig();
    const client = deps.client ?? (cfg ? createDeepseekClient(cfg) : null);
    const english = client ? await translateForCustomer(client, text) : null;
    if (!english) {
      await sender.sendMessage(chatId, "Не смог перевести на английский. Напишите ответ по-английски — отправлю как есть.");
      return;
    }

    await prisma.aiTurn.update({ where: { id: turn.id }, data: { replyText: english, source: "human" } });
    const res = await sender.sendMessage(
      chatId,
      `Отправить клиенту такой текст?\n\n${english}`,
      [{ text: "Отправить", callbackData: `${SEND_ACTION_PREFIX}${turn.id}` }]
    );
    // Подтверждение — новое сообщение бота, и реплаить теперь надо на него.
    if (res.ok) await prisma.aiTurn.update({ where: { id: turn.id }, data: { telegramMessageId: res.messageId, telegramChatId: chatId } });
  };
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
  const res = await fetchImpl(url).catch(() => null);
  if (!res?.ok) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) return null;
  return transcriber({ bytes, filename: "voice.ogg", mime: voice.mime_type || "audio/ogg" });
}
