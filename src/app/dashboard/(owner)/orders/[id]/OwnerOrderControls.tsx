"use client";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerSetManualPrice, ownerReassign } from "@/app/dashboard/(owner)/actions";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { OrderStatus } from "@/generated/prisma/enums";
import { OrderStatusDateControls } from "./OrderStatusDateControls";

export function OwnerOrderControls({
  orderId,
  updatedAt,
  order,
  florists,
}: {
  orderId: string;
  updatedAt: string;
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
      {/* Статус + дата/время — общий блок (owner/call-center/florist), редактирование через OCC. */}
      <OrderStatusDateControls
        orderId={orderId}
        updatedAt={updatedAt}
        orderStatus={order.orderStatus}
        deliveryDate={order.deliveryDate}
        deliveryWindow={order.deliveryWindow}
      />

      {/* Флорист и цена — ТОЛЬКО владелец. */}
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
