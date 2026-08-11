/**
 * Свёртка ПОПЫТОК отправки в одно сообщение ленты общения.
 *
 * Движок автоматизаций формирует ключ отправки per-attempt (`<ключ job'а>:a<номер>`), а
 * `sendOrderSms` на каждый новый ключ создаёт свою строку `OrderCommunication`. Поэтому одна
 * неудачная попытка и последовавший удачный повтор — это ДВЕ строки в БД, и лента показывала их
 * как два сообщения клиенту с одинаковым текстом и временем (заказ THEFLOW-20416: четыре строки
 * вместо двух ушедших SMS).
 *
 * Строки объединяются только когда это заведомо одна и та же отправка: общий ключ job'а до
 * суффикса попытки. Ручная отправка из карточки ключа с суффиксом не имеет и не сворачивается
 * никогда, входящие — тем более.
 *
 * Показываем УСПЕХ, если он был хоть в одной попытке: провал промежуточной попытки — деталь
 * доставки, а не отдельное сообщение. Если успеха не было, остаётся последняя попытка со своим
 * статусом «ошибка» — потерять неудачу нельзя, сотрудник должен видеть, что сообщение не ушло.
 */

/** Позиция статуса в исходе отправки: чем больше, тем «успешнее». */
const OUTCOME_RANK: Record<string, number> = {
  FAILED: 0,
  PENDING: 1,
  SENT: 2,
  DELIVERED: 3,
};

type Attempt = { id: string; status: string; occurredAt: string; sendKey?: string | null };

/**
 * Ключ группировки: `<ключ job'а>` из `<ключ job'а>:a<номер попытки>`. Возвращает null, если
 * ключа нет или он не похож на попытку движка — такие строки не сворачиваются.
 */
export function attemptGroupKey(sendKey: string | null | undefined): string | null {
  if (!sendKey) return null;
  const m = /^(.+):a\d+$/.exec(sendKey);
  return m ? m[1] : null;
}

/**
 * Оставляет по одной строке на группу попыток, сохраняя исходный порядок списка. Строки без
 * ключа попытки проходят насквозь.
 */
export function collapseSendAttempts<T extends Attempt>(items: T[]): T[] {
  const winnerIdByGroup = new Map<string, string>();
  const byId = new Map<string, T>();

  for (const item of items) {
    byId.set(item.id, item);
    const group = attemptGroupKey(item.sendKey);
    if (!group) continue;

    const currentId = winnerIdByGroup.get(group);
    if (!currentId) {
      winnerIdByGroup.set(group, item.id);
      continue;
    }
    const current = byId.get(currentId)!;
    const rank = (s: string) => OUTCOME_RANK[s] ?? 0;
    // Успешнее — побеждает; при равном исходе побеждает более поздняя попытка.
    const better =
      rank(item.status) > rank(current.status) ||
      (rank(item.status) === rank(current.status) && item.occurredAt > current.occurredAt);
    if (better) winnerIdByGroup.set(group, item.id);
  }

  const winners = new Set(winnerIdByGroup.values());
  return items.filter((item) => {
    const group = attemptGroupKey(item.sendKey);
    return group === null || winners.has(item.id);
  });
}
