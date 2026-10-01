/**
 * Отправка SMS через веб-приложение Quo — дополнение к API, которое остаётся запасным путём
 * (владелец 01.10.2026: «отправку через браузер реализовать как дополнение к апи»).
 *
 * Зачем: Quo берёт $0.01 за часть SMS, отправленной через API, а набранное в самом приложении
 * входит в подписку. Робот делает то же, что человек: открывает ящик магазина, вписывает номер и
 * текст, нажимает «Отправить».
 *
 * Здесь только развилка, без Playwright: модуль читают и Next.js, и воркер. Браузер живёт ТОЛЬКО в
 * воркере (`robot.ts`, регистрируется при старте) — один на систему, сообщения по одному. Next.js
 * браузер не запускает: его отправки (карточка заказа, «Другие сообщения», отзывы) поручаются
 * воркеру и ждут результата несколько секунд (`send.ts::handOverToWorker`).
 */

export type BrowserSendInput = {
  /** Номер магазина в Quo (PN…) — тот же id, что у API: ящик открывается по нему. */
  fromPhoneNumberId: string;
  /** Получатель, E.164. */
  to: string;
  text: string;
  /** Зовётся прямо перед нажатием «Отправить»: дальше повтор через API уже опасен. */
  beforeSend?: () => Promise<void>;
};

/**
 * sent — сообщение видно в ленте разговора;
 * not_sent — до кнопки «Отправить» не дошли: можно смело отправить через API;
 * unknown — кнопку нажали, подтверждения нет: второй раз не шлём, клиент получил бы дважды.
 */
export type BrowserSendResult =
  | { outcome: "sent" }
  | { outcome: "not_sent"; reason: string }
  | { outcome: "unknown"; reason: string };

export type BrowserSender = (input: BrowserSendInput) => Promise<BrowserSendResult>;

export type SmsTransport = { via: "api" } | { via: "browser"; send: BrowserSender } | { via: "worker" };

/** Рубильник. Выключен — всё как раньше, через API. Читается каждый раз: меняется без пересборки. */
export function isBrowserSendingEnabled(): boolean {
  return process.env.QUO_BROWSER_ENABLED === "true";
}

let inWorker = false;
let sender: BrowserSender | null = null;

/** Воркер при старте: «здесь воркер», и вот его браузер (null — не поднялся: шлём через API). */
export function registerBrowserSender(s: BrowserSender | null): void {
  inWorker = true;
  sender = s;
}

/**
 * Как отправлять в ЭТОМ процессе: api — по-старому; browser — браузером здесь же (воркер);
 * worker — поручить воркеру (Next.js).
 */
export function smsTransport(): SmsTransport {
  if (!isBrowserSendingEnabled()) return { via: "api" };
  if (!inWorker) return { via: "worker" };
  return sender ? { via: "browser", send: sender } : { via: "api" };
}

/** Только для тестов. */
export function __resetBrowserTransport(): void {
  inWorker = false;
  sender = null;
}
