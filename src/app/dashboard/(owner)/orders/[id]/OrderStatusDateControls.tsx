"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { manualOrderStatuses, orderStatusMeta, IN_WORK_ORDER_STATUSES } from "@/lib/statuses";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
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
      <OrderStatusCard orderId={orderId} updatedAt={updatedAt} orderStatus={orderStatus} />
      <Card>
        <CardHeader><CardTitle>Дата и время доставки</CardTitle></CardHeader>
        <CardBody><DeliveryForm orderId={orderId} updatedAt={updatedAt} date={deliveryDate} window={deliveryWindow} /></CardBody>
      </Card>
    </div>
  );
}

/**
 * Только «Статус заказа». Отдельная карточка — потому что у флориста в правой колонке
 * стоит статус БЕЗ даты доставки (дата у него редактируется из шапки), а заводить ради
 * этого вторую копию формы значило бы чинить OCC потом в двух местах.
 */
export function OrderStatusCard({
  orderId,
  updatedAt,
  orderStatus,
}: {
  orderId: string;
  updatedAt: string;
  orderStatus: OrderStatus;
}) {
  return (
    <Card>
      <CardHeader className="flex items-center justify-between py-2.5">
        <CardTitle>Статус заказа</CardTitle>
        {/* Текущий статус подписан словом, а не только оттенком селекта. */}
        <OrderStatusBadge status={orderStatus} />
      </CardHeader>
      <CardBody className="py-3">
        <StatusForm orderId={orderId} updatedAt={updatedAt} current={orderStatus} />
      </CardBody>
    </Card>
  );
}

function StatusForm({ orderId, updatedAt, current }: { orderId: string; updatedAt: string; current: OrderStatus }) {
  // Текущий статус может отсутствовать в списке выбираемых вручную (AWAITING_PAYMENT ставит
  // оплата, ASSIGNED/FLORIST_ACCEPTED — назначение). Тогда select показал бы ПЕРВЫЙ пункт
  // вместо реального статуса, и «ОК» без выбора молча переписал бы заказ. Поэтому группу
  // «в работе» сводим к её выбираемому представителю, а нестандартный статус добавляем
  // отдельным нередактируемым пунктом.
  const selectable = IN_WORK_ORDER_STATUSES.includes(current) ? "IN_PROGRESS" : current;
  const isManual = manualOrderStatuses.includes(selectable);
  const [status, setStatus] = useState<OrderStatus>(selectable);
  const { pending, conflict, save, acceptCurrentVersion } = useBlockSave(orderId, "status", updatedAt);
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Select value={status} onChange={(e) => setStatus(e.target.value as OrderStatus)}>
          {!isManual && (
            <option value={selectable} disabled>{orderStatusMeta[current].label} (текущий)</option>
          )}
          {manualOrderStatuses.map((s) => (
            <option key={s} value={s}>{orderStatusMeta[s].label}</option>
          ))}
        </Select>
        {/* Подтверждение появляется ТОЛЬКО когда значение изменено, и занимает одну иконку.
            Сохранять по выбору в списке нельзя: на «Доставлен» висят включённые SMS-правила,
            и промах мышью отправил бы сообщения реальному клиенту. */}
        {status !== selectable && (
          <Tooltip content="Сохранить статус">
            <Button
              size="icon"
              aria-label="Сохранить статус"
              disabled={pending}
              onClick={() => save({ orderStatus: status }, { successMessage: "Статус обновлён" })}
            >
              <Check className="size-4" />
            </Button>
          </Tooltip>
        )}
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
