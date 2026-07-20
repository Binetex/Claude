"use client";
import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { linkCommunicationAction, ignoreCommunicationAction } from "./actions";

export type Suggestion = { orderId: string; orderNumber: string; role: "CUSTOMER" | "RECIPIENT" };
export type UnrecognizedItemData = {
  id: string;
  type: "SMS" | "CALL" | "VOICEMAIL";
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  externalPhone: string;
  messageText: string | null;
  durationSeconds: number | null;
  occurredAt: string;
  suggestions: Suggestion[];
};

const TYPE_RU: Record<string, string> = { SMS: "SMS", CALL: "Звонок", VOICEMAIL: "Voicemail" };
const fmtNum = (n: string) => (n.startsWith("#") ? n : `#${n.includes("-") ? n.slice(n.lastIndexOf("-") + 1) : n}`);

function UnrecognizedItem({ item }: { item: UnrecognizedItemData }) {
  const [linkState, linkAction, linkPending] = useActionState(linkCommunicationAction, null);
  const [ignoreState, ignoreAction, ignorePending] = useActionState(ignoreCommunicationAction, null);
  const [manual, setManual] = useState("");

  if (linkState?.ok || ignoreState?.ok) return null; // после действия исчезает из активного списка

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="font-medium text-slate-700">
          {item.direction === "OUTBOUND" ? "→" : "←"} {TYPE_RU[item.type]} <span className="break-all text-slate-500">· {item.externalPhone}</span>
        </span>
        <span className="text-[11px] text-slate-400">{new Date(item.occurredAt).toLocaleString()}</span>
      </div>
      {item.messageText && <div className="mt-1 whitespace-pre-wrap break-words text-slate-700">{item.messageText}</div>}
      {item.type !== "SMS" && <div className="mt-1 text-xs text-slate-500">{item.status === "MISSED" ? "Пропущенный" : "Звонок"}{item.durationSeconds != null ? ` · ${item.durationSeconds} сек` : ""}</div>}

      {/* Подсказки: подходящие заказы */}
      {item.suggestions.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] text-slate-400">Подходящие заказы:</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {item.suggestions.map((s) => (
              <form key={s.orderId} action={linkAction}>
                <input type="hidden" name="communicationId" value={item.id} />
                <input type="hidden" name="orderId" value={s.orderId} />
                <Button type="submit" size="sm" variant="outline" disabled={linkPending}>
                  {fmtNum(s.orderNumber)} · {s.role === "CUSTOMER" ? "покупатель" : "получатель"}
                </Button>
              </form>
            ))}
          </div>
        </div>
      )}

      {/* Ручная привязка по номеру + игнор */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <form action={linkAction} className="flex items-center gap-1.5">
          <input type="hidden" name="communicationId" value={item.id} />
          <input name="orderNumber" value={manual} onChange={(e) => setManual(e.target.value)} placeholder="№ заказа" className="w-24 rounded border border-slate-300 px-2 py-1 text-xs" />
          <Button type="submit" size="sm" disabled={linkPending || !manual.trim()}>Привязать</Button>
        </form>
        <form action={ignoreAction}>
          <input type="hidden" name="communicationId" value={item.id} />
          <Button type="submit" size="sm" variant="ghost" disabled={ignorePending}>Игнорировать</Button>
        </form>
      </div>
      {linkState?.error && <p className="mt-1 text-xs text-red-600">{linkState.error}</p>}
      {ignoreState?.error && <p className="mt-1 text-xs text-red-600">{ignoreState.error}</p>}
    </li>
  );
}

export function UnrecognizedList({ items }: { items: UnrecognizedItemData[] }) {
  if (items.length === 0) return <div className="text-sm text-slate-400">Нераспознанных коммуникаций нет.</div>;
  return (
    <ul className="space-y-2">
      {items.map((i) => <UnrecognizedItem key={i.id} item={i} />)}
    </ul>
  );
}
