import { Badge } from "@/components/ui/Badge";
import {
  resolveOrderStatusMeta,
  paymentStatusMeta,
  deliveryStatusMeta,
} from "@/lib/statuses";
import type {
  OrderStatus,
  PaymentStatus,
  DeliveryStatus,
} from "@/generated/prisma/enums";

export function OrderStatusBadge({ status, paymentFailed }: { status: OrderStatus; paymentFailed?: boolean }) {
  const m = resolveOrderStatusMeta(status, { paymentFailed });
  return <Badge className={m.className}>{m.label}</Badge>;
}

export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const m = paymentStatusMeta[status];
  return <Badge className={m.className}>{m.label}</Badge>;
}

export function DeliveryStatusBadge({ status }: { status: DeliveryStatus }) {
  const m = deliveryStatusMeta[status];
  return <Badge className={m.className}>{m.label}</Badge>;
}
