/**
 * Разбор ответа `getUpdates`: какие чаты писали боту. Чистая функция — без сети.
 *
 * Чат берётся из сообщения, правки и из добавления бота в группу (`my_chat_member`): в группе
 * человек может ничего не писать, а бот уже там. Свежие — первыми, каждый чат один раз.
 */
export type TelegramChat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
export type TelegramUpdate = {
  update_id: number;
  message?: { chat: TelegramChat };
  edited_message?: { chat: TelegramChat };
  channel_post?: { chat: TelegramChat };
  my_chat_member?: { chat: TelegramChat };
};
export type FoundChat = { chatId: string; name: string; isGroup: boolean };

export function chatsFromUpdates(updates: TelegramUpdate[]): FoundChat[] {
  const seen = new Set<string>();
  const found: FoundChat[] = [];
  for (const u of [...updates].sort((a, b) => b.update_id - a.update_id)) {
    const chat = u.message?.chat ?? u.edited_message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!chat) continue;
    const chatId = String(chat.id);
    if (seen.has(chatId)) continue;
    seen.add(chatId);
    found.push({ chatId, name: chatName(chat), isGroup: chat.type !== "private" });
  }
  return found;
}

function chatName(chat: TelegramChat): string {
  if (chat.type !== "private") return chat.title?.trim() || "Группа без названия";
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ").trim();
  const handle = chat.username ? `@${chat.username}` : "";
  return [name, handle].filter(Boolean).join(" ") || "Без имени";
}
