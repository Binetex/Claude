"use client";
import { useState } from "react";
import { manualOrderStatuses, orderStatusMeta } from "@/lib/statuses";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { OrderStatus } from "@/generated/prisma/enums";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/**
 * Блоки «Статус заказа» + «Дата и время доставки» — редактируемы для owner/call-center/florist
 * через единый путь с OCC. Финансы/назначение флориста сюда НЕ входят (см. OwnerOrderControls).
 */
export function OrderStatusDateControls({
  orderId,
  updatedAt,
  orderStatus,
  deliveryDate,
  deliveryWindow,
}: {
  orderId: string;
  updatedAt: string;
  orderStatus: OrderStatus;
  deliveryDate: string;
  deliveryWindow: string;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle>Статус заказа</CardTitle></CardHeader>
        <CardBody><StatusForm orderId={orderId} updatedAt={updatedAt} current={orderStatus} /></CardBody>
      </Card>
      <Card>
        <CardHeader><CardTitle>Дата и время доставки</CardTitle></CardHeader>
        <CardBody><DeliveryForm orderId={orderId} updatedAt={updatedAt} date={deliveryDate} window={deliveryWindow} /></CardBody>
      </Card>
    </div>
  );
}

function StatusForm({ orderId, updatedAt, current }: { orderId: string; updatedAt: string; current: OrderStatus }) {
  const [status, setStatus] = useState<OrderStatus>(current);
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "status", updatedAt);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
          {manualOrderStatuses.map((s) => (
            <option key={s} value={s}>{orderStatusMeta[s].label}</option>
          ))}
        </Select>
        <Button
          disabled={pending}
          onClick={() => save({ orderStatus: status }, { successMessage: "Статус обновлён" })}
        >
          ОК
        </Button>
      </div>
      {conflict && (
        <ConflictNotice
          current={conflict.current}
          labels={[{ k: "orderStatus", label: "Статус" }]}
          onRefresh={() => acceptCurrentVersion((c) => { if (c.orderStatus) setStatus(c.orderStatus as OrderStatus); })}
        />
      )}
    </div>
  );
}

function DeliveryForm({ orderId, updatedAt, date, window }: { orderId: string; updatedAt: string; date: string; window: string }) {
  const [d, setD] = useState(date);
  const [w, setW] = useState(window);
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "delivery", updatedAt);
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
        onClick={() => save({ deliveryDate: d, deliveryWindow: w }, { successMessage: "Доставка обновлена" })}
      >
        Сохранить
      </Button>
      {conflict && (
        <ConflictNotice
          current={conflict.current}
          labels={[{ k: "deliveryDate", label: "Дата" }, { k: "deliveryWindow", label: "Интервал" }]}
          onRefresh={() => acceptCurrentVersion((c) => { if ("deliveryDate" in c) setD(c.deliveryDate); if ("deliveryWindow" in c) setW(c.deliveryWindow); })}
        />
      )}
    </div>
  );
}
