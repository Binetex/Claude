import "server-only";

/**
 * Тонкий слой над Telegram Bot API. Умеет ТОЛЬКО отправить, отредактировать и удалить
 * сообщение — никакой бизнес-логики, никакого знания о заказах. Весь остальной код ходит
 * в Telegram только через него.
 *
 * Обработка ответов API:
 *  - 429 → уважаем `retry_after` из ответа, ограниченное число повторов;
 *  - 400 "message is not modified" → считаем УСПЕХОМ (нечего менять — это не ошибка);
 *  - «сообщение не найдено/нельзя редактировать» → отдаём отдельный признак, чтобы
 *    вызывающий отправил новое вместо редактирования;
 *  - сетевые сбои/5xx → повтор с задержкой, затем осмысленная ошибка.
 */
const API = "https://api.telegram.org";
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

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

/** Текст, из-за которого редактирование бессмысленно — Telegram отвечает 400, но это не ошибка. */
const NOT_MODIFIED = "message is not modified";
/** Сообщение недоступно для редактирования → надо отправить новое. */
const UNEDITABLE = [
  "message to edit not found",
  "message can't be edited",
  "message identifier is not specified",
  "MESSAGE_ID_INVALID",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  /** Общий цикл повторов: 429 по retry_after, сеть/5xx — с нарастающей паузой. */
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

  async sendMessage(chatId: string, text: string, button?: TelegramButton): Promise<SendResult> {
    const { res, status, networkError } = await this.callWithRetry("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
    });
    const id = res?.result?.message_id;
    if (res?.ok && id != null) return { ok: true, messageId: String(id) };
    return { ok: false, retryable: !!networkError || status === 429 || status >= 500, code: safeCode(res, status, networkError) };
  }

  async editMessage(chatId: string, messageId: string, text: string, button?: TelegramButton): Promise<EditResult> {
    const { res, status, networkError } = await this.callWithRetry("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageId),
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(button ? { reply_markup: { inline_keyboard: [[{ text: button.text, url: button.url }]] } } : {}),
    });
    if (res?.ok) return { ok: true };
    const desc = (res?.description ?? "").toLowerCase();
    // Нечего менять — это успех, а не ошибка.
    if (desc.includes(NOT_MODIFIED)) return { ok: true };
    if (UNEDITABLE.some((m) => desc.includes(m.toLowerCase()))) return { ok: false, needsResend: true };
    return { ok: false, retryable: !!networkError || status === 429 || status >= 500, code: safeCode(res, status, networkError) };
  }

  async deleteMessage(chatId: string, messageId: string): Promise<{ ok: boolean }> {
    const { res } = await this.callWithRetry("deleteMessage", { chat_id: chatId, message_id: Number(messageId) });
    return { ok: !!res?.ok };
  }
}

/** Код без секретов и без полного описания от провайдера. */
function safeCode(res: ApiResponse | null, status: number, networkError?: string): string {
  if (networkError) return `network:${networkError}`;
  if (res?.error_code) return `telegram_${res.error_code}`;
  return `http_${status}`;
}
