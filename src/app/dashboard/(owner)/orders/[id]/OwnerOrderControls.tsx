"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import {
  ownerSetOrderStatus,
  ownerUpdateDelivery,
  ownerSetManualPrice,
  ownerReassign,
} from "@/app/dashboard/(owner)/actions";
import { manualOrderStatuses, orderStatusMeta } from "@/lib/statuses";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { OrderStatus } from "@/generated/prisma/enums";

export function OwnerOrderControls({
  orderId,
  order,
  florists,
}: {
  orderId: string;
  order: {
    orderStatus: OrderStatus;
    deliveryDate: string;
    deliveryWindow: string;
    priceMode: "AUTO" | "MANUAL";
    floristTotal: number;
    currentFloristId: string | null;
  };
  florists: { id: string; name: string }[];
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Статус заказа</CardTitle></CardHeader>
        <CardBody><StatusForm orderId={orderId} current={order.orderStatus} /></CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Дата и время доставки</CardTitle></CardHeader>
        <CardBody><DeliveryForm orderId={orderId} date={order.deliveryDate} window={order.deliveryWindow} /></CardBody>
      </Card>

      <Card>
        <CardHeader><CardTitle>Флорист и цена</CardTitle></CardHeader>
        <CardBody className="space-y-4">
          <ReassignForm orderId={orderId} florists={florists} currentFloristId={order.currentFloristId} priceMode={order.priceMode} />
          <PriceForm orderId={orderId} current={order.floristTotal} priceMode={order.priceMode} />
        </CardBody>
      </Card>
    </div>
  );
}

function StatusForm({ orderId, current }: { orderId: string; current: OrderStatus }) {
  const [status, setStatus] = useState<OrderStatus>(current);
  const [pending, start] = useTransition();
  return (
    <div className="flex gap-2">
      <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
        {manualOrderStatuses.map((s) => (
          <option key={s} value={s}>{orderStatusMeta[s].label}</option>
        ))}
      </Select>
      <Button
        disabled={pending || status === current}
        onClick={() => start(async () => { await ownerSetOrderStatus(orderId, status); toast.success("Статус обновлён"); })}
      >
        ОК
      </Button>
    </div>
  );
}

function DeliveryForm({ orderId, date, window }: { orderId: string; date: string; window: string }) {
  const [d, setD] = useState(date);
  const [w, setW] = useState(window);
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2.5">
      <div>
        <Label>Дата</Label>
        <Input type="date" value={d} onChange={(e) => setD(e.target.value)} className="mt-1" />
      </div>
      <div>
        <Label>Интервал</Label>
        <Input value={w} onChange={(e) => setW(e.target.value)} className="mt-1" placeholder="12:00 – 16:00" />
      </div>
      <Button
        className="w-full"
        disabled={pending}
        onClick={() => start(async () => { await ownerUpdateDelivery(orderId, { deliveryDate: d, deliveryWindow: w }); toast.success("Доставка обновлена"); })}
      >
        Сохранить
      </Button>
    </div>
  );
}

function ReassignForm({
  orderId,
  florists,
  currentFloristId,
  priceMode,
}: {
  orderId: string;
  florists: { id: string; name: string }[];
  currentFloristId: string | null;
  priceMode: "AUTO" | "MANUAL";
}) {
  const [target, setTarget] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [pending, start] = useTransition();

  function doReassign(keepManual: boolean) {
    if (!target) return;
    start(async () => {
      await ownerReassign(orderId, target, keepManual);
      toast.success("Флорист переназначен");
    });
    setConfirming(false);
    setTarget("");
  }

  return (
    <div className="space-y-2">
      <Label>Переназначить флориста</Label>
      <div className="flex gap-2">
        <Select value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Выберите флориста…</option>
          {florists.filter((f) => f.id !== currentFloristId).map((f) => (
            <option key={f.id} value={f.id}>{f.name}</option>
          ))}
        </Select>
        <Button
          variant="secondary"
          disabled={pending || !target}
          onClick={() => (priceMode === "MANUAL" ? setConfirming(true) : doReassign(false))}
        >
          ОК
        </Button>
      </div>
      {confirming && (
        <div className="space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm">
          <p className="text-amber-800">У заказа ручная цена. Что сделать с ценой?</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={pending} onClick={() => doReassign(true)}>Оставить ручную</Button>
            <Button size="sm" variant="outline" disabled={pending} onClick={() => doReassign(false)}>Авто-цена нового</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Отмена</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function PriceForm({ orderId, current, priceMode }: { orderId: string; current: number; priceMode: "AUTO" | "MANUAL" }) {
  const [amount, setAmount] = useState(String(current));
  const [pending, start] = useTransition();
  return (
    <div className="space-y-2 border-t border-slate-100 pt-3">
      <Label>Ручная цена флориста <span className="text-slate-400">({priceMode === "MANUAL" ? "сейчас: ручная" : "сейчас: авто"})</span></Label>
      <div className="flex gap-2">
        <Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => start(async () => { await ownerSetManualPrice(orderId, Number(amount)); toast.success("Цена задана"); })}
        >
          Задать
        </Button>
      </div>
    </div>
  );
}
