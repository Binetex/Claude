"use client";
import { useState } from "react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { sendOrderSmsAction } from "./commActions";
import { CommunicationTimeline, type TimelineItem } from "./CommunicationTimeline";

const SMS_MAX = 1600;
export type CommItem = TimelineItem;
const newKey = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);

/**
 * Минимальный блок общения (Phase 4): отправка SMS покупателю/получателю + локальная лента истории.
 * Полноценная хронология/индикаторы/нераспознанные — Phase 5. Отправка доступна любому сотруднику.
 *
 * Двойной клик защищён: pending-гард + disabled на кнопке; durable idempotency key стабилен в течение
 * составления сообщения и обновляется ТОЛЬКО после успешной отправки (setState — в обработчике, не в effect).
 */
export function OrderCommunications({
  orderId,
  customerPhone,
  recipientPhone,
  storeHasQuoNumber,
  communications,
  storeTimeZone,
}: {
  orderId: string;
  customerPhone: string;
  recipientPhone: string;
  storeHasQuoNumber: boolean;
  communications: CommItem[];
  storeTimeZone?: string;
}) {
  const [target, setTarget] = useState<"CUSTOMER" | "RECIPIENT">("CUSTOMER");
  const [text, setText] = useState("");
  const [idem, setIdem] = useState<string>(newKey);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ ok?: boolean; error?: string; status?: string } | null>(null);

  const currentPhone = target === "CUSTOMER" ? customerPhone : recipientPhone;
  const tooLong = text.length > SMS_MAX;
  const disabled = pending || !text.trim() || tooLong || !storeHasQuoNumber;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (disabled) return; // двойной клик заблокирован
    setPending(true);
    setResult(null);
    const fd = new FormData();
    fd.set("orderId", orderId);
    fd.set("target", target);
    fd.set("text", text);
    fd.set("idempotencyKey", idem); // durable ключ: стабилен для этого сообщения
    try {
      const res = await sendOrderSmsAction(null, fd);
      setResult(res);
      if (res?.ok) {
        setText("");
        setIdem(newKey()); // новый ключ для следующего сообщения
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
        {!storeHasQuoNumber && (
          <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">У магазина не настроен номер QUO — отправка SMS недоступна.</div>
        )}

        <form onSubmit={onSubmit} className="space-y-2">
          <div className="flex gap-2">
            {(["CUSTOMER", "RECIPIENT"] as const).map((t) => (
              <button key={t} type="button" onClick={() => setTarget(t)}
                className={"rounded-md px-3 py-1 text-xs font-medium " + (target === t ? "bg-sky-600 text-white" : "bg-slate-100 text-slate-700")}>
                {t === "CUSTOMER" ? "Покупатель" : "Получатель"}
              </button>
            ))}
          </div>
          <div className="text-xs text-slate-500">Номер: <span className="font-medium text-slate-700">{currentPhone || "—"}</span></div>
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

        {/* Полная хронология (SMS/звонки/voicemail/записи/транскрипты/summary) из локальной БД. */}
        <div className="border-t border-slate-100 pt-2">
          <CommunicationTimeline items={communications} storeTimeZone={storeTimeZone} />
        </div>
      </CardBody>
    </Card>
  );
}
