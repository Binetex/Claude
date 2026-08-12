"use client";
import { useState } from "react";
import { MessageSquare } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { sendOrderSmsAction } from "./commActions";
import { sendOrderEmailReplyAction } from "./emailActions";
import { CommunicationTimeline, type TimelineItem } from "./CommunicationTimeline";
import { buildCommTabs, commGroupOf, type CommTab } from "@/integrations/quo/communicationsView";

const SMS_MAX = 1600;
const EMAIL_MAX = 10_000;
export type CommItem = TimelineItem;

/** Письмо из переписки по заказу. Только plain text — HTML мы не храним и не показываем. */
export type EmailItem = {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  fromEmail: string;
  subject: string | null;
  text: string;
  occurredAt: string;
  errorSafe: string | null;
};
const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Блок «Общение»: вкладки по стороне заказа (Получатель / Заказчик, при одинаковом номере — одна
 * вкладка «Клиент») плюс отдельная вкладка «Email». Активная вкладка задаёт: номер отправки SMS,
 * ФИЛЬТР истории (только этот номер) и подпись автора входящих.
 *
 * Почему Email отдельной вкладкой, а не ещё одной «стороной»: у получателя букета адреса в заказе
 * нет вообще — он есть только у заказчика. Делить почту по сторонам было бы нечем, поэтому вкладка
 * одна и всегда про заказчика.
 *
 * В почтовой вкладке живёт ТОЛЬКО ручная переписка (Email Factory). Автоматические письма по
 * событиям заказа шлёт Brevo, и они сюда не попадают — иначе появился бы соблазн «ответить» на
 * письмо, у которого нет треда и живого адресата.
 */
export function OrderCommunications({
  orderId,
  customerPhone,
  recipientPhone,
  storeHasQuoNumber,
  communications,
  emails,
  storeTimeZone,
  unread,
}: {
  orderId: string;
  customerPhone: string;
  recipientPhone: string;
  storeHasQuoNumber: boolean;
  communications: CommItem[];
  emails: EmailItem[];
  storeTimeZone?: string;
  unread?: { customer: number; recipient: number };
}) {
  const tabs = buildCommTabs(customerPhone, recipientPhone);
  const [activeKey, setActiveKey] = useState<CommTab["key"] | "EMAIL">(tabs[0].key);
  const [text, setText] = useState("");
  const [idem, setIdem] = useState<string>(newKey);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; status?: string } | null>(null);

  const isEmail = activeKey === "EMAIL";
  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0];
  // Отвечать можно только в тред, который завёл клиент своим письмом. Сервер это проверяет ещё
  // раз, но и кнопку держать активной незачем — иначе она обещает то, чего не будет.
  const canReply = emails.some((e) => e.direction === "INBOUND");
  const inboundCount = emails.filter((e) => e.direction === "INBOUND").length;
  // Разбор по ФАКТИЧЕСКОМУ номеру сообщения, а не по сохранённой роли: роль ставится один раз
  // при приёме и устаревает, когда телефон заказа исправляют (см. commGroupOf).
  const groupOf = (c: CommItem) => commGroupOf(c, customerPhone, recipientPhone);
  const items = communications.filter((c) => groupOf(c) === active.key);
  // Счётчик приходит с сервера, разобранный ПО ТЕМ ЖЕ группам, что и вкладки
  // (countUnreadBySide вызывает тот же commGroupOf). Иначе значок висел бы на пустой вкладке.
  const unreadFor = (t: CommTab): number =>
    t.key === "CUSTOMER" ? unread?.customer ?? 0
    : t.key === "RECIPIENT" ? unread?.recipient ?? 0
    : (unread?.customer ?? 0) + (unread?.recipient ?? 0);

  const limit = isEmail ? EMAIL_MAX : SMS_MAX;
  const tooLong = text.length > limit;
  const disabled = pending || !text.trim() || tooLong || (isEmail ? !canReply : !storeHasQuoNumber);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return; // двойной клик заблокирован
    setPending(true);
    setResult(null);
    const fd = new FormData();
    fd.set("orderId", orderId);
    fd.set("target", active.target); // сервер резолвит номер из того же поля заказа
    fd.set("text", text);
    fd.set("idempotencyKey", idem);
    try {
      // Адресат письма из браузера НЕ передаётся: сервер берёт его из последнего входящего
      // письма заказа, иначе подменой поля можно было бы написать в чужую переписку.
      const res = isEmail ? await sendOrderEmailReplyAction(null, fd) : await sendOrderSmsAction(null, fd);
      setResult(res);
      if (res?.ok) setText("");
      // Ключ одноразовый и меняется ТАКЖЕ после ошибки: сервер уже записал неудачную попытку под
      // этим ключом, и повтор с ним никогда не дошёл бы до QUO — кнопка «Отправить» молча перестала
      // бы работать до перезагрузки страницы. Двойной клик по-прежнему заблокирован `disabled`.
      setIdem(newKey());
    } catch {
      setResult({ error: "Не удалось отправить. Попробуйте ещё раз." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader className="py-2.5"><CardTitle icon={MessageSquare}>Общение</CardTitle></CardHeader>
      <CardBody className="space-y-3 text-sm">
        {/* Вкладки по стороне: Получатель слева (по умолчанию), Заказчик справа. */}
        <div className="flex gap-2">
          {tabs.map((t) => {
            // При активной почте ни одна телефонная вкладка не подсвечена: `active` откатывается
            // на первую из них как источник номера отправки, но выбран-то не он.
            const isActive = !isEmail && t.key === active.key;
            const u = unreadFor(t);
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setActiveKey(t.key)}
                className={"inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium " + (isActive ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-700")}
              >
                {t.label}
                {u > 0 && (
                  <span className={"inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold " + (isActive ? "bg-white text-sky-700" : "bg-red-500 text-white")}>
                    {u}
                  </span>
                )}
              </button>
            );
          })}
          {/* Почта — отдельная вкладка, а не сторона заказа: адрес есть только у заказчика.
              Цифра — сколько писем пришло от клиента по этому заказу. */}
          <button
            type="button"
            onClick={() => setActiveKey("EMAIL")}
            className={"inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium " + (isEmail ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-700")}
          >
            Email
            {inboundCount > 0 && (
              <span className={"inline-flex min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold " + (isEmail ? "bg-white text-sky-700" : "bg-red-500 text-white")}>
                {inboundCount}
              </span>
            )}
          </button>
        </div>

        {!isEmail && !storeHasQuoNumber && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">У магазина не настроен номер QUO — отправка SMS недоступна.</div>
        )}

        {isEmail && !canReply && (
          <div className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600">
            Клиент ещё не писал по этому заказу. Переписку начинает он — отвечать пока не на что.
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-2">
          {/* Подпись говорит, КУДА уйдёт сообщение, а не «номер этой переписки»: рядом форма
              отправки, и путать эти две вещи опасно. */}
          <div className="text-xs text-slate-500">
            Отправить на:{" "}
            <span className="font-medium tabular-nums text-slate-700">
              {isEmail ? emails.find((e) => e.direction === "INBOUND")?.fromEmail || "—" : active.phone || "—"}
            </span>
          </div>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder={isEmail ? "Текст письма…" : "Текст сообщения…"} disabled={pending}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <div className="flex items-center justify-between">
            <span className={"text-[11px] " + (tooLong ? "text-red-600" : "text-slate-400")}>{text.length}/{limit}</span>
            <Button type="submit" size="sm" disabled={disabled}>{pending ? "Отправка…" : isEmail ? "Ответить письмом" : "Отправить SMS"}</Button>
          </div>
          {result?.error && <p className="text-xs text-red-600">{result.error}</p>}
          {result?.ok && (
            <p className="text-xs text-emerald-700">
              {isEmail ? "Письмо отправлено." : `Сообщение ${result.status === "SENT" ? "отправлено" : "поставлено в отправку"}.`}
            </p>
          )}
        </form>

        {/* История ТОЛЬКО выбранной стороны (не смешиваем номера). Пустая — своё состояние.
            Высота ограничена: длинная переписка иначе растягивает страницу на несколько
            экранов и уводит блок доставки далеко вниз. */}
        <div className="max-h-80 overflow-y-auto border-t border-slate-100 pt-2">
          {isEmail ? <EmailTimeline items={emails} /> : <CommunicationTimeline items={items} storeTimeZone={storeTimeZone} inboundLabel={active.label} />}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Лента писем. Намеренно проще телефонной: у письма нет ни статусов доставки, ни записи разговора,
 * ни вложений, которые мы бы показывали. Тема выводится только когда она есть и отличается от
 * предыдущей — в треде она повторяется в каждом письме и превращается в шум.
 *
 * Текст выводится как есть, в `whitespace-pre-wrap`: письмо клиента — это абзацы и переносы, и
 * схлопывать их в один абзац значит терять смысл. HTML-версии у нас нет by design.
 */
function EmailTimeline({ items }: { items: EmailItem[] }) {
  if (items.length === 0) {
    return <p className="py-3 text-center text-xs text-slate-400">Писем по этому заказу пока нет.</p>;
  }

  let prevSubject: string | null = null;
  return (
    <ul className="space-y-2">
      {items.map((m) => {
        const outbound = m.direction === "OUTBOUND";
        const showSubject = !!m.subject && m.subject !== prevSubject;
        prevSubject = m.subject ?? prevSubject;
        return (
          <li key={m.id} className={"rounded-md border p-2 " + (outbound ? "border-sky-100 bg-sky-50/60" : "border-slate-200 bg-white")}>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-xs font-medium text-slate-700">{outbound ? "🌸 Вы" : m.fromEmail}</span>
              <span className="text-[11px] text-slate-400">{new Date(m.occurredAt).toLocaleString("ru-RU")}</span>
            </div>
            {showSubject && <div className="mt-0.5 text-[11px] text-slate-500">{m.subject}</div>}
            {m.text.trim() ? (
              <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-800">{m.text}</p>
            ) : (
              // Письмо без текстовой части (только HTML или одни вложения). Показываем факт, а не
              // пустоту: иначе выглядит как потерянное сообщение.
              <p className="mt-1 text-sm italic text-slate-400">Письмо без текстовой части — откройте его в почте.</p>
            )}
            {m.status === "PENDING" && <p className="mt-1 text-[11px] text-slate-400">Отправляется…</p>}
            {m.status === "FAILED" && <p className="mt-1 text-[11px] text-red-600">Не отправлено{m.errorSafe ? `: ${m.errorSafe}` : ""}.</p>}
          </li>
        );
      })}
    </ul>
  );
}
