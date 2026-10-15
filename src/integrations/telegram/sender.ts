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

/**
 * Кнопка под сообщением: либо ссылка, либо действие внутри бота (`callbackData`).
 * Действие нужно там, где владелец подтверждает отправку одним нажатием, не печатая ответ.
 */
export type TelegramButton = { text: string; url: string } | { text: string; callbackData: string };

/**
 * `migratedTo` — группа стала супергруппой, и Telegram сообщил её новый Chat ID; отправка уже
 * повторена туда. Вызывающий обязан сохранить новый номер у бота, иначе каждая следующая отправка
 * начиналась бы с отказа (15.10.2026: так молча пропали карточки Арины).
 */
export type SendResult =
  | { ok: true; messageId: string; migratedTo?: string }
  /** `reason` — текст отказа от самого Telegram («Bad Request: …»): без него «telegram_400» ничего не объясняет. */
  | { ok: false; retryable: boolean; code: string; reason?: string; migratedTo?: string };

export type EditResult =
  | { ok: true; migratedTo?: string }
  | { ok: false; needsResend: true; migratedTo?: string }
  | { ok: false; needsResend?: false; retryable: boolean; code: string; migratedTo?: string };

type ApiMessage = { message_id?: number | string };

type ApiResponse = {
  ok: boolean;
  // sendMediaGroup отвечает МАССИВОМ сообщений (по одному на фото), остальные методы — одним.
  result?: ApiMessage | ApiMessage[];
  error_code?: number;
  description?: string;
  /** migrate_to_chat_id — группа стала супергруппой; писать теперь сюда. */
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

/** Сколько фото Telegram принимает в одном альбоме. */
export const MEDIA_GROUP_LIMIT = 10;

const NOT_MODIFIED = "message is not modified";
const UNEDITABLE = [
  "message to edit not found",
  "message can't be edited",
  "message identifier is not specified",
  "MESSAGE_ID_INVALID",
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** id сообщения из ответа API; для альбома — id ПЕРВОГО сообщения группы. */
function firstMessageId(result: ApiResponse["result"]): string | null {
  const m = Array.isArray(result) ? result[0] : result;
  return m?.message_id != null ? String(m.message_id) : null;
}

/** Кнопки одним рядом. Пустой массив → без клавиатуры. */
function keyboard(buttons?: TelegramButton[]): Record<string, unknown> {
  if (!buttons || buttons.length === 0) return {};
  return {
    reply_markup: {
      inline_keyboard: [
        buttons.map((b) => ("url" in b ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.callbackData })),
      ],
    },
  };
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
    let last: (Awaited<ReturnType<TelegramSender["call"]>> & { migratedTo?: string }) | null = null;
    let migratedTo: string | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      last = { ...(await this.call(method, body)), migratedTo };
      const { res, status, networkError } = last;
      if (res?.ok) return last;
      // Группа стала супергруппой: старый Chat ID больше не принимает сообщения, новый — в ответе.
      // Один раз переходим туда сами; сохранить номер — дело вызывающего (`migratedTo`).
      const next = res?.parameters?.migrate_to_chat_id;
      if (next != null && !migratedTo && body.chat_id != null) {
        migratedTo = String(next);
        body = { ...body, chat_id: migratedTo };
        continue;
      }
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
    const id = firstMessageId(res?.result);
    const moved = r.migratedTo ? { migratedTo: r.migratedTo } : {};
    if (res?.ok && id != null) return { ok: true, messageId: id, ...moved };
    return {
      ok: false,
      retryable: !!networkError || status === 429 || status >= 500,
      code: safeCode(res, status, networkError),
      ...(res?.description ? { reason: res.description.slice(0, 200) } : {}),
      ...moved,
    };
  }

  private toEdit(r: Awaited<ReturnType<TelegramSender["callWithRetry"]>>): EditResult {
    const { res, status, networkError } = r;
    const moved = r.migratedTo ? { migratedTo: r.migratedTo } : {};
    if (res?.ok) return { ok: true, ...moved };
    const desc = (res?.description ?? "").toLowerCase();
    if (desc.includes(NOT_MODIFIED)) return { ok: true, ...moved };
    // Сообщение осталось в старой группе — править нечего, нужно новое уже в супергруппе.
    if (r.migratedTo || UNEDITABLE.some((m) => desc.includes(m.toLowerCase()))) return { ok: false, needsResend: true, ...moved };
    return { ok: false, retryable: !!networkError || status === 429 || status >= 500, code: safeCode(res, status, networkError), ...moved };
  }

  /**
   * Ответ на нажатие кнопки. Без него Telegram держит на кнопке «часики», и владелец не понимает,
   * сработало ли нажатие. Ошибку глотаем: это уведомление о приёме, а не само действие.
   */
  async answerCallback(callbackQueryId: string, text?: string): Promise<void> {
    await this.callWithRetry("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    }).catch(() => null);
  }

  /**
   * Прямая ссылка на файл из сообщения (голосовое владельца). Telegram отдаёт путь через getFile,
   * а сам файл лежит по отдельному адресу с токеном бота — наружу эту ссылку показывать нельзя.
   */
  async getFileUrl(fileId: string): Promise<string | null> {
    const { res } = await this.callWithRetry("getFile", { file_id: fileId });
    const filePath = (res?.result as { file_path?: string } | undefined)?.file_path;
    return res?.ok && filePath ? `${API}/file/bot${this.botToken}/${filePath}` : null;
  }

  async sendMessage(chatId: string, text: string, buttons?: TelegramButton[]): Promise<SendResult> {
    return this.toSend(await this.callWithRetry("sendMessage", {
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...keyboard(buttons),
    }));
  }

  /**
   * Запасной вариант: тот же текст без HTML-разметки и без кнопок. Telegram отказывает в карточке
   * целиком из-за одной детали (разметка, кнопка), и флорист оставался без заказа — простой текст
   * доходит почти всегда. Ссылки кнопок дописываются строками: Telegram сам сделает их кликабельными.
   */
  async sendPlain(chatId: string, html: string, buttons?: TelegramButton[]): Promise<SendResult> {
    const links = (buttons ?? []).flatMap((b) => ("url" in b ? [`${b.text}: ${b.url}`] : []));
    const text = [htmlToPlain(html), ...links].join("\n").slice(0, 4096);
    return this.toSend(await this.callWithRetry("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true }));
  }

  /** Фото по URL — Telegram сам скачивает картинку. `caption` ограничен CAPTION_LIMIT. */
  async sendPhoto(chatId: string, photoUrl: string, caption: string, buttons?: TelegramButton[]): Promise<SendResult> {
    return this.toSend(await this.callWithRetry("sendPhoto", {
      chat_id: chatId, photo: photoUrl, caption, parse_mode: "HTML", ...keyboard(buttons),
    }));
  }

  /**
   * Альбом из нескольких фото по URL (2..MEDIA_GROUP_LIMIT штук).
   *
   * ВАЖНО: Telegram НЕ разрешает inline-клавиатуру у media group — кнопки остаются на основном
   * сообщении, поэтому альбом отправляется отдельно и без них. Возвращает id ПЕРВОГО сообщения
   * группы: по нему альбом можно найти и удалить, отредактировать состав группы Telegram не даёт.
   */
  async sendMediaGroup(chatId: string, photoUrls: string[]): Promise<SendResult> {
    return this.toSend(await this.callWithRetry("sendMediaGroup", {
      chat_id: chatId,
      media: photoUrls.slice(0, MEDIA_GROUP_LIMIT).map((url) => ({ type: "photo", media: url })),
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

/** Разметка Telegram-HTML → простой текст: теги прочь, сущности обратно в символы. */
export function htmlToPlain(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}
