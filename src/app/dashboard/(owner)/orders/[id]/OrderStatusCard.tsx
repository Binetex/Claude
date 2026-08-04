"use client";
import { useState } from "react";
import { Check } from "lucide-react";
import { OrderStatusBadge } from "@/components/StatusBadge";
import { manualOrderStatuses, orderStatusMeta, ACCEPTED_ORDER_STATUSES } from "@/lib/statuses";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Select } from "@/components/ui/select";
import type { OrderStatus } from "@/generated/prisma/enums";
import { useBlockSave, ConflictNotice } from "./orderEditShared";

/**
 * «Статус заказа» — одна карточка на владельца, колл-центр и флориста, единый путь с OCC.
 *
 * Дата и интервал доставки СЮДА НЕ ВХОДЯТ: они уже показаны в шапке заказа, и правятся
 * оттуда же карандашом (DeliveryDateDialog). Прежняя связка «статус + дата» отдельной
 * карточкой в колонке управления повторяла те же два поля второй раз.
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
  const selectable = ACCEPTED_ORDER_STATUSES.includes(current) ? "FLORIST_ACCEPTED" : current;
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
