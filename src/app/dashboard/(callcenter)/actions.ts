"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import type { OrderStatus } from "@/generated/prisma/enums";

async function ccOnly() {
  await requireRole("CALL_CENTER");
}

// Колл-центр может менять ограниченный набор статусов (без «финансовых» действий).
const ccAllowedStatuses: OrderStatus[] = [
  "CONFIRMED",
  "IN_PROGRESS",
  "READY",
  "AWAITING_COURIER",
  "IN_TRANSIT",
  "DELIVERED",
  "PROBLEM",
  "CANCELLED",
];

export async function ccSetOrderStatus(orderId: string, status: OrderStatus) {
  await ccOnly();
  if (!ccAllowedStatuses.includes(status)) return;
  await prisma.order.update({ where: { id: orderId }, data: { orderStatus: status } });
  revalidatePath(`/dashboard/cc/${orderId}`);
  revalidatePath("/dashboard/cc");
}

export async function ccUpdateDelivery(orderId: string, data: { deliveryDate?: string; deliveryWindow?: string }) {
  await ccOnly();
  await prisma.order.update({
    where: { id: orderId },
    data: {
      ...(data.deliveryDate ? { deliveryDate: new Date(data.deliveryDate) } : {}),
      ...(data.deliveryWindow ? { deliveryWindow: data.deliveryWindow } : {}),
    },
  });
  revalidatePath(`/dashboard/cc/${orderId}`);
}

export async function ccUpdateContacts(
  orderId: string,
  data: {
    recipientName?: string;
    recipientPhone?: string;
    recipientEmail?: string;
    addressLine?: string;
    apartment?: string;
    city?: string;
    zip?: string;
  }
) {
  await ccOnly();
  await prisma.order.update({ where: { id: orderId }, data });
  revalidatePath(`/dashboard/cc/${orderId}`);
}

export async function ccUpdateCardAndNote(orderId: string, data: { cardMessage?: string; customerNote?: string }) {
  await ccOnly();
  await prisma.order.update({ where: { id: orderId }, data });
  revalidatePath(`/dashboard/cc/${orderId}`);
}
