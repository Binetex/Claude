"use server";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { linkCommunicationToOrder, ignoreCommunication } from "@/integrations/quo/communicationsService";

type FormState = { ok?: boolean; error?: string } | null;

/**
 * Ручная привязка нераспознанной коммуникации к заказу. Доступно ЛЮБОМУ аутентифицированному
 * сотруднику (requireUser, НЕ OWNER-only). Привязать можно по orderId (из подсказок) либо по
 * введённому номеру заказа (точное единственное совпадение).
 */
export async function linkCommunicationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const communicationId = String(formData.get("communicationId") ?? "");
  let orderId = String(formData.get("orderId") ?? "");
  const orderNumberQuery = String(formData.get("orderNumber") ?? "").trim();
  if (!communicationId) return { error: "Не указана коммуникация." };

  if (!orderId && orderNumberQuery) {
    const cleaned = orderNumberQuery.replace(/[^0-9A-Za-z-]/g, "");
    const matches = await prisma.order.findMany({ where: { orderNumber: { contains: cleaned, mode: "insensitive" } }, select: { id: true }, take: 2 });
    if (matches.length === 0) return { error: "Заказ с таким номером не найден." };
    if (matches.length > 1) return { error: "Найдено несколько заказов — уточните номер." };
    orderId = matches[0].id;
  }
  if (!orderId) return { error: "Выберите заказ или введите номер." };

  const res = await linkCommunicationToOrder(prisma, communicationId, orderId);
  revalidatePath("/dashboard/communications");
  revalidatePath(`/dashboard/orders/${orderId}`);
  if (!res.ok) return { error: res.reason === "order_not_found" ? "Заказ не найден." : "Коммуникация не найдена." };
  return { ok: true };
}

/** «Игнорировать» нераспознанную коммуникацию — исчезает из активного списка. Любой сотрудник. */
export async function ignoreCommunicationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  await requireUser();
  const communicationId = String(formData.get("communicationId") ?? "");
  if (!communicationId) return { error: "Не указана коммуникация." };
  const res = await ignoreCommunication(prisma, communicationId);
  revalidatePath("/dashboard/communications");
  if (!res.ok) return { error: "Коммуникация не найдена." };
  return { ok: true };
}
