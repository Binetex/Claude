"use client";
import { useState, useTransition } from "react";
import {
  ccSetOrderStatus,
  ccUpdateDelivery,
  ccUpdateContacts,
  ccUpdateCardAndNote,
} from "@/app/dashboard/(callcenter)/actions";
import { orderStatusMeta } from "@/lib/statuses";
import type { OrderStatus } from "@/generated/prisma/enums";

const box = "rounded-lg border border-slate-200 bg-white p-4 space-y-3";
const label = "block text-xs font-medium text-slate-500 mb-1";
const input = "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm";
const btn = "rounded-lg bg-slate-800 px-3 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60";

const ccStatuses: OrderStatus[] = [
  "CONFIRMED",
  "IN_PROGRESS",
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED",
];

export function CallCenterControls({
  orderId,
  order,
}: {
  orderId: string;
  order: {
    orderStatus: OrderStatus;
    deliveryDate: string;
    deliveryWindow: string;
    recipientName: string;
    recipientPhone: string;
    recipientEmail: string | null;
    addressLine: string;
    apartment: string | null;
    city: string;
    zip: string;
    cardMessage: string;
    customerNote: string;
  };
}) {
  const [pending, start] = useTransition();
  const [status, setStatus] = useState(order.orderStatus);
  const [d, setD] = useState(order.deliveryDate);
  const [w, setW] = useState(order.deliveryWindow);
  const [c, setC] = useState({
    recipientName: order.recipientName,
    recipientPhone: order.recipientPhone,
    recipientEmail: order.recipientEmail ?? "",
    addressLine: order.addressLine,
    apartment: order.apartment ?? "",
    city: order.city,
    zip: order.zip,
  });
  const [card, setCard] = useState(order.cardMessage);
  const [note, setNote] = useState(order.customerNote);
  const upd = (k: keyof typeof c) => (e: React.ChangeEvent<HTMLInputElement>) => setC({ ...c, [k]: e.target.value });

  return (
    <div className="space-y-4">
      <div className={box}>
        <div className="text-sm font-semibold text-slate-700">Статус заказа</div>
        <div className="flex gap-2">
          <select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)} className={input}>
            {ccStatuses.map((s) => <option key={s} value={s}>{orderStatusMeta[s].label}</option>)}
          </select>
          <button className={btn} disabled={pending} onClick={() => start(() => ccSetOrderStatus(orderId, status))}>Сохранить</button>
        </div>
      </div>

      <div className={box}>
        <div className="text-sm font-semibold text-slate-700">Дата и время доставки</div>
        <div><label className={label}>Дата</label><input type="date" value={d} onChange={(e) => setD(e.target.value)} className={input} /></div>
        <div><label className={label}>Интервал</label><input value={w} onChange={(e) => setW(e.target.value)} className={input} /></div>
        <button className={btn} disabled={pending} onClick={() => start(() => ccUpdateDelivery(orderId, { deliveryDate: d, deliveryWindow: w }))}>Сохранить</button>
      </div>

      <div className={box}>
        <div className="text-sm font-semibold text-slate-700">Контакты и адрес</div>
        <div className="grid grid-cols-2 gap-2">
          <F l="Имя" v={c.recipientName} on={upd("recipientName")} />
          <F l="Телефон" v={c.recipientPhone} on={upd("recipientPhone")} />
          <F l="Email" v={c.recipientEmail} on={upd("recipientEmail")} />
          <F l="Апартаменты" v={c.apartment} on={upd("apartment")} />
          <div className="col-span-2"><F l="Адрес" v={c.addressLine} on={upd("addressLine")} /></div>
          <F l="Город" v={c.city} on={upd("city")} />
          <F l="ZIP" v={c.zip} on={upd("zip")} />
        </div>
        <button className={btn} disabled={pending} onClick={() => start(() => ccUpdateContacts(orderId, c))}>Сохранить контакты</button>
      </div>

      <div className={box}>
        <div className="text-sm font-semibold text-slate-700">Открытка и заметка</div>
        <p className="text-xs text-slate-400">Меняются только вручную.</p>
        <div><label className={label}>Текст открытки</label><textarea value={card} onChange={(e) => setCard(e.target.value)} rows={3} className={input} /></div>
        <div><label className={label}>Customer note</label><textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={input} /></div>
        <button className={btn} disabled={pending} onClick={() => start(() => ccUpdateCardAndNote(orderId, { cardMessage: card, customerNote: note }))}>Сохранить тексты</button>
      </div>
    </div>
  );
}

function F({ l, v, on }: { l: string; v: string; on: (e: React.ChangeEvent<HTMLInputElement>) => void }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-slate-500">{l}</label>
      <input value={v} onChange={on} className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm" />
    </div>
  );
}
