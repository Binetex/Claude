import "server-only";

/**
 * Тонкий слой над Telegram Bot API. Умеет ТОЛЬКО отправлять/редактировать/удалять сообщения
 * (текст и фото) — никакой бизнес-логики, никакого знания о заказах.
 *
 * Про фото: сообщение, отправленное как фото (sendPhoto), нельзя превратить в текстовое —
 * его подпись правится editMessageCaption, а НЕ editMessageText. Поэтому методы разделены,
 * а вызывающий сам помнит тип сообщения (TelegramMessage.isPhoto).
 *
 * Обработка ответов API:
 *  - 429 → уважаем retry_after, ограниченное число повторов;
 *  - 400 "message is not modified" → успех (нечего менять);
 *  - «сообщение не найдено/нельзя редактировать» → признак needsResend;
 *  - сеть/5xx → повтор с задержкой, затем осмысленная ошибка.
 */
const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;
/** Лимит подписи фото в Telegram (у текста — 4096). */
export const CAPTION_LIMIT = 1024;

export type TelegramButton = { text: string; url: string };

export type SendResult =
  | { ok: true; messageId: string }
  | { ok: false; retryable: boolean; code: string };

export type EditResult =
  | { ok: true }
  | { ok: false; needsResend: true }
  | { ok: false; needsResend?: false; retryable: boolean; code: string };

type ApiResponse = {
  ok: boolean;
  result?: { message_id?: number | string };
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

const NOT_MODIFIED = "message is not modified";
const UNEDITABLE = [
  "message to edit not found",
  "message can't be edited",
  "message identifier is not specified",
  "MESSAGE_ID_INVALID",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Кнопки одним рядом. Пустой массив → без клавиатуры. */
function keyboard(buttons?: TelegramButton[]): Record<string, unknown> {
  if (!buttons || buttons.length === 0) return {};
  return { reply_markup: { inline_keyboard: [buttons.map((b) => ({ text: b.text, url: b.url }))] } };
}

export class TelegramSender {
  constructor(private readonly botToken: string) {}

  private async call(method: string, body: Record<string, unknown>): Promise<{ res: ApiResponse | null; status: number; networkError?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/bot${this.botToken}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const json = (await r.json().catch(() => null)) as ApiResponse | null;
      return { res: json, status: r.status };
    } catch (err) {
      return { res: null, status: 0, networkError: err instanceof Error ? err.name : "network_error" };
    } finally {
      clearTimeout(timer);
    }
  }

  private async callWithRetry(method: string, body: Record<string, unknown>) {
    let last: Awaited<ReturnType<TelegramSender["call"]>> | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last = await this.call(method, body);
      const { res, status, networkError } = last;
      if (res?.ok) return last;
      if (status === 429) {
        const wait = Math.min(res?.parameters?.retry_after ?? 1, 30);
        if (attempt < MAX_ATTEMPTS) { await sleep(wait * 1000); continue; }
      }
      if ((networkError || status >= 500) && attempt < MAX_ATTEMPTS) { await sleep(attempt * 500); continue; }
      return last;
    }
    return last!;
  }

  private toSend(r: Awaited<ReturnType<TelegramSender["callWithRetry"]>>): SendResult {
    const { res, status, networkError } = r;
    const id = res?.result?.message_id;
    if (res?.ok && id != null) return { ok: true, messageId: String(id) };
    return { ok: false, retryable: !!networkError || status === 429 || status >= 500, code: safeCode(res, status, networkError) };
  }

  private toEdit(r: Awaited<ReturnType<TelegramSender["callWithRetry"]>>): EditResult {
    const { res, status, networkError } = r;
    if (res?.ok) return { ok: true };
    const desc = (res?.description ?? "").toLowerCase();
    if (desc.includes(NOT_MODIFIED)) return { ok: true };
    if (UNEDITABLE.some((m) => desc.includes(m.toLowerCase()))) return { ok: false, needsResend: true };
    return { ok: false, retryable: !!networkError || status === 429 || status >= 500, code: safeCode(res, status, networkError) };
  }

  async sendMessage(chatId: string, text: string, buttons?: TelegramButton[]): Promise<SendResult> {
    return this.toSend(await this.callWithRetry("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...keyboard(buttons),
    }));
  }

  /** Фото по URL — Telegram сам скачивает картинку. `caption` ограничен CAPTION_LIMIT. */
  async sendPhoto(chatId: string, photoUrl: string, caption: string, buttons?: TelegramButton[]): Promise<SendResult> {
    return this.toSend(await this.callWithRetry("sendPhoto", {
      chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML", ...keyboard(buttons),
    }));
  }

  async editMessage(chatId: string, messageId: string, text: string, buttons?: TelegramButton[]): Promise<EditResult> {
    return this.toEdit(await this.callWithRetry("editMessageText", {
      chat_id: chatId, message_id: Number(messageId), text, parse_mode: "HTML", disable_web_page_preview: true, ...keyboard(buttons),
    }));
  }

  /** Подпись фото-сообщения (текст под фото). Фото при этом остаётся прежним. */
  async editMessageCaption(chatId: string, messageId: string, caption: string, buttons?: TelegramButton[]): Promise<EditResult> {
    return this.toEdit(await this.callWithRetry("editMessageCaption", {
      chat_id: chatId, message_id: Number(messageId), caption, parse_mode: "HTML", ...keyboard(buttons),
    }));
  }

  async deleteMessage(chatId: string, messageId: string): Promise<{ ok: boolean }> {
    const { res } = await this.callWithRetry("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
    return { ok: !!res?.ok };
  }
}

function safeCode(res: ApiResponse | null, status: number, networkError?: string): string {
  if (networkError) return `network:${networkError}`;
  if (res?.error_code) return `telegram_${res.error_code}`;
  return `http_${status}`;
}
