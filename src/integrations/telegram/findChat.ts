import "server-only";
/**
 * Chat ID без ручного поиска (владелец 10.10.2026: «заебался узнавать в Telegram, какой у меня ID
 * чата — пусть система сама узнаёт»). Человек пишет боту любое сообщение (/start), а мы спрашиваем у
 * Telegram, кто боту писал (`getUpdates`), — тот чат и подключаем.
 *
 * `getUpdates` вызывается без `offset`, поэтому обновления не подтверждаются и не пропадают. Telegram
 * держит их сутки. Пока у бота включён приём ответов (вебхук), Telegram отдаёт обновления только
 * туда и на `getUpdates` отвечает 409 — об этом говорим словами.
 */
import { chatsFromUpdates, type FoundChat, type TelegramUpdate } from "./findChatParse";

export type FindChatsResult = { ok: true; botUsername: string | null; chats: FoundChat[] } | { ok: false; error: string };

const API = "https://api.telegram.org";

export async function findBotChats(token: string): Promise<FindChatsResult> {
  try {
    const me = await fetch(`${API}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const meJson = (await me.json().catch(() => null)) as { ok?: boolean; result?: { username?: string } } | null;
    if (!meJson?.ok) return { ok: false, error: me.status === 401 ? "Токен недействителен — проверьте, что скопировали его целиком." : `Telegram отклонил токен (${me.status}).` };
    const botUsername = meJson.result?.username ?? null;

    const r = await fetch(`${API}/bot${token}/getUpdates?limit=100`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 409) {
      return { ok: false, error: "У бота включён приём ответов — Telegram не отдаёт сообщения напрямую. Выключите приём, нажмите ещё раз, потом включите обратно." };
    }
    const json = (await r.json().catch(() => null)) as { ok?: boolean; result?: TelegramUpdate[] } | null;
    if (!json?.ok) return { ok: false, error: `Telegram не отдал сообщения бота (${r.status}).` };
    return { ok: true, botUsername, chats: chatsFromUpdates(json.result ?? []) };
  } catch {
    return { ok: false, error: "Не удалось связаться с Telegram (таймаут или сеть)." };
  }
}
