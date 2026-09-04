/**
 * Цепочка «не ответили — следующее правило»: чистые правила без БД и без server-only.
 *
 * Механизм один на всё: у правила есть ссылка «если на это сообщение не ответят через N минут —
 * запустить вот это правило». Ждать молча, никого не запуская, смысла нет, поэтому отдельного
 * флага «ждём ответ» не существует: ожидание — это и есть ссылка.
 *
 * Модуль намеренно чистый: эти же значения нужны и серверу (обработчик ожидания, server action),
 * и форме владельца (границы полей ввода). Копия границ в форме обязательно разъехалась бы с
 * сервером — владелец вводил бы число, которое молча срезается.
 */

/**
 * Сколько сообщений ЦЕПОЧКИ максимум на один заказ (исходное сообщение не в счёт). Пять — с
 * запасом больше любой разумной лесенки (у владельца их две) и всё равно конечно: ошибка в
 * настройке не превращается в бесконечную переписку.
 */
export const MAX_CHAIN_MESSAGES = 5;

/** Префикс «случая» у сообщений, отправленных цепочкой. По нему же считается потолок на заказ. */
export const CHAIN_OCCURRENCE_PREFIX = "chain:";

/** Разумные границы паузы: минута тревожит зря, а сутки приходят уже после доставки. */
export const MIN_WAIT_MIN = 5;
export const MAX_WAIT_MIN = 12 * 60;

/**
 * Насколько проверка может опоздать и всё ещё что-то отправлять.
 *
 * Воркер может лежать (деплой, сбой, перезагрузка сервера), и накопленные проверки срабатывают
 * пачкой, когда он поднимется. Сообщение «вы не ответили», пришедшее на сутки позже вопроса, —
 * это уже не страховка, а недоумение у человека, поэтому опоздавшая проверка молча гаснет.
 */
export const LATE_TOLERANCE_MIN = 2 * 60;

/** Опоздала ли проверка настолько, что отправлять уже поздно. */
export function isTooLate(dueAt: Date, now: Date): boolean {
  return now.getTime() - dueAt.getTime() > LATE_TOLERANCE_MIN * 60_000;
}

/** Срезает срок ожидания к разумным границам. Зовётся и при сохранении, и при постановке. */
export function clampWait(value: number | null | undefined, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_WAIT_MIN, Math.max(MIN_WAIT_MIN, Math.round(value)));
}

/**
 * «Случай» для сообщения, которое уходит вместо ответа.
 *
 * Ключ строится по ПРАВИЛУ-ПОЛУЧАТЕЛЮ шага и случаю сообщения, на которое не ответили.
 * Именно по получателю, а не по отправителю: на одно событие правил бывает несколько (на проде
 * на «Заказ доставлен» их два — заказчику и получателю), и если оба указывают на одно следующее,
 * человек обязан получить его ОДИН раз. Заказ входит в ключ, потому что случай события у разных
 * заказов может совпасть.
 */
export function chainOccurrenceKey(args: { nextAutomationId: string; orderId: string; senderCase: string }): string {
  return `${CHAIN_OCCURRENCE_PREFIX}${args.nextAutomationId}:${args.orderId}:${args.senderCase}`;
}

/** Это сообщение само пришло по цепочке (а не по событию заказа)? */
export function isChainOccurrence(occurrenceKey: string | null | undefined): boolean {
  return !!occurrenceKey && occurrenceKey.startsWith(CHAIN_OCCURRENCE_PREFIX);
}

/**
 * Ждать ли ответа на ТОЛЬКО ЧТО отправленное сообщение.
 *
 * Отдельной функцией, потому что это и есть смысл всей правки: раньше решение принимал тип
 * события («Доставка сегодня») и роль адресата, теперь — ссылка на правиле. Условие в
 * обработчике отправки тестом не покрыть (нужны БД, канал и очередь), а выродиться оно может в
 * одну строку — поэтому граница живёт здесь и закреплена тестом.
 *
 * Только SMS: ответ мы узнаём по входящим сообщениям и звонкам с номера, входящей почты система
 * не принимает вовсе — на письме ожидание не разрешилось бы никогда.
 */
export function shouldWaitForReply(
  job: { channel: string; phoneNormalized: string | null },
  automation: { noReplyNextAutomationId: string | null }
): boolean {
  return job.channel === "SMS" && !!job.phoneNormalized && !!automation.noReplyNextAutomationId;
}

/**
 * Ищет кольцо, которое возникнет, если у правила `fromId` следующим станет `nextId`.
 * Возвращает список правил кольца (от `fromId` и обратно к нему) или null.
 *
 * `nextById` — карта «правило → его следующее» по остальным правилам. Проверка нужна на
 * сохранении: A→B→A молча превращает страховку в бесконечную рассылку, а потолок сообщений
 * на заказ — это последний рубеж, а не то, на что стоит полагаться в нормальной настройке.
 */
export function findChainCycle(
  nextById: ReadonlyMap<string, string | null>,
  fromId: string,
  nextId: string
): string[] | null {
  const path = [fromId];
  let cursor: string | null = nextId;
  const seen = new Set<string>([fromId]);

  while (cursor) {
    path.push(cursor);
    if (cursor === fromId) return path;
    if (seen.has(cursor)) return path; // кольцо дальше по цепочке — тоже кольцо
    seen.add(cursor);
    cursor = nextById.get(cursor) ?? null;
  }
  return null;
}
