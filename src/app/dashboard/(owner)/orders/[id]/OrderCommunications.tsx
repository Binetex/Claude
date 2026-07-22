"use client";
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { sendOrderSmsAction } from "./commActions";
import { CommunicationTimeline, type TimelineItem } from "./CommunicationTimeline";
import { buildCommTabs, type CommTab } from "@/integrations/quo/communicationsView";

const SMS_MAX = 1600;
export type CommItem = TimelineItem;
const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Блок «Общение (SMS)»: вкладки по стороне заказа (Получатель / Заказчик, при одинаковом номере — одна
 * вкладка «Клиент»). Активная вкладка задаёт: номер отправки SMS, ФИЛЬТР истории (только этот номер) и
 * подпись автора входящих. Автор в ленте: «🌸 Вы» для исходящих, метка стороны — для входящих.
 * Логику получения/данные сообщений не меняем — только визуал и фильтрация.
 */
export function OrderCommunications({
  orderId,
  customerPhone,
  recipientPhone,
  storeHasQuoNumber,
  communications,
  storeTimeZone,
  unread,
}: {
  orderId: string;
  customerPhone: string;
  recipientPhone: string;
  storeHasQuoNumber: boolean;
  communications: CommItem[];
  storeTimeZone?: string;
  unread?: { customer: number; recipient: number };
}) {
  const tabs = buildCommTabs(customerPhone, recipientPhone);
  const [activeKey, setActiveKey] = useState<CommTab["key"]>(tabs[0].key);
  const [text, setText] = useState("");
  const [idem, setIdem] = useState<string>(newKey);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; status?: string } | null>(null);

  const active = tabs.find((t) => t.key === activeKey) ?? tabs[0];
  const items = active.role === null ? communications : communications.filter((c) => c.partyRole === active.role);
  const unreadFor = (t: CommTab): number =>
    t.key === "CUSTOMER" ? unread?.customer ?? 0 : t.key === "RECIPIENT" ? unread?.recipient ?? 0 : (unread?.customer ?? 0) + (unread?.recipient ?? 0);

  const tooLong = text.length > SMS_MAX;
  const disabled = pending || !text.trim() || tooLong || !storeHasQuoNumber;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return; // двойной клик заблокирован
    setPending(true);
    setResult(null);
    const fd = new FormData();
    fd.set("orderId", orderId);
    fd.set("target", active.target);
    fd.set("text", text);
    fd.set("idempotencyKey", idem);
    try {
      const res = await sendOrderSmsAction(null, fd);
      setResult(res);
      if (res?.ok) {
        setText("");
        setIdem(newKey());
      }
    } catch {
      setResult({ error: "Не удалось отправить. Попробуйте ещё раз." });
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>Общение (SMS)</CardTitle></CardHeader>
      <CardBody className="space-y-3 text-sm">
        {/* Вкладки по стороне: Получатель слева (по умолчанию), Заказчик справа. */}
        <div className="flex gap-2">
          {tabs.map((t) => {
            const isActive = t.key === active.key;
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
        </div>

        {!storeHasQuoNumber && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">У магазина не настроен номер QUO — отправка SMS недоступна.</div>
        )}

        <form onSubmit={onSubmit} className="space-y-2">
          <div className="text-xs text-slate-500">Номер: <span className="font-medium text-slate-700">{active.phone || "—"}</span></div>
          <textarea
            value={text} onChange={(e) => setText(e.target.value)} rows={3}
            placeholder="Текст сообщения…" disabled={pending}
            className="w-full rounded border border-slate-300 px-2 py-1 text-sm"
          />
          <div className="flex items-center justify-between">
            <span className={"text-[11px] " + (tooLong ? "text-red-600" : "text-slate-400")}>{text.length}/{SMS_MAX}</span>
            <Button type="submit" size="sm" disabled={disabled}>{pending ? "Отправка…" : "Отправить SMS"}</Button>
          </div>
          {result?.error && <p className="text-xs text-red-600">{result.error}</p>}
          {result?.ok && <p className="text-xs text-emerald-700">Сообщение {result.status === "SENT" ? "отправлено" : "поставлено в отправку"}.</p>}
        </form>

        {/* История ТОЛЬКО выбранной стороны (не смешиваем номера). Пустая — своё состояние. */}
        <div className="border-t border-slate-100 pt-2">
          <CommunicationTimeline items={items} storeTimeZone={storeTimeZone} inboundLabel={active.label} />
        </div>
      </CardBody>
    </Card>
  );
}
