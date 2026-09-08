"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { createDefaultItems } from "./defaults";

type Result = { ok?: true; message?: string; error?: string };

const PATH = "/dashboard/consumables";

/** Стартовый набор колонок из таблицы владельца. Повторное нажатие ничего не дублирует. */
export async function ownerCreateDefaultConsumables(brandedSiteId: string): Promise<Result> {
  await requireRole("OWNER");
  const created = await createDefaultItems(prisma, brandedSiteId || null);
  revalidatePath(PATH);
  revalidatePath(`${PATH}/items`);
  return created ? { ok: true, message: `Создано позиций: ${created}` } : { error: "Справочник уже не пустой." };
}

/**
 * Ручное количество расходника на заказе. Пустая строка — вернуть расчёт по правилу
 * (строка удаляется). Ноль — значимое значение: «правило насчитало, а не положили».
 */
export async function ownerSetConsumableUsage(input: { orderId: string; itemId: string; quantity: number | null }): Promise<Result> {
  const user = await requireRole("OWNER");
  const { orderId, itemId, quantity } = input;
  if (!orderId || !itemId) return { error: "Не указан заказ или позиция." };

  if (quantity === null) {
    await prisma.consumableUsage.deleteMany({ where: { orderId, itemId } });
  } else {
    if (!Number.isInteger(quantity) || quantity < 0) return { error: "Количество должно быть целым и не меньше нуля." };
    await prisma.consumableUsage.upsert({
      where: { orderId_itemId: { orderId, itemId } },
      create: { orderId, itemId, quantity, updatedByUserId: user.id },
      update: { quantity, updatedByUserId: user.id },
    });
  }

  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { deliveryDate: true } });
  if (order) revalidatePath(`${PATH}/${order.deliveryDate.toISOString().slice(0, 10)}`);
  revalidatePath(PATH);
  return { ok: true };
}

export async function ownerSaveConsumableItem(input: {
  id?: string;
  name: string;
  siteId: string | null;
  autoRule: string | null;
  autoKey: string | null;
  imageUrl: string | null;
  sortOrder: number;
}): Promise<Result> {
  await requireRole("OWNER");
  const name = input.name.trim();
  if (!name) return { error: "Название обязательно." };

  const data = {
    name,
    siteId: input.siteId || null,
    autoRule: input.autoRule || null,
    autoKey: input.autoKey || null,
    imageUrl: input.imageUrl?.trim() || null,
    sortOrder: Number.isFinite(input.sortOrder) ? input.sortOrder : 100,
  };

  if (input.id) await prisma.consumableItem.update({ where: { id: input.id }, data });
  else await prisma.consumableItem.create({ data });

  revalidatePath(`${PATH}/items`);
  revalidatePath(PATH);
  return { ok: true };
}

/** Убрать из списка, не удаляя: у прошлых дней остались проставленные количества. */
export async function ownerArchiveConsumableItem(id: string, archived: boolean): Promise<Result> {
  await requireRole("OWNER");
  await prisma.consumableItem.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
  revalidatePath(`${PATH}/items`);
  revalidatePath(PATH);
  return { ok: true };
}

/** Приход на склад: купили N штук. Нужен, чтобы остаток не уходил в минус. */
export async function ownerAddConsumableReceipt(input: { itemId: string; day: string; quantity: number; note: string }): Promise<Result> {
  const user = await requireRole("OWNER");
  if (!input.itemId) return { error: "Выберите позицию." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: "Укажите дату." };
  if (!Number.isInteger(input.quantity) || input.quantity === 0) return { error: "Количество должно быть целым и не нулевым." };

  await prisma.consumableReceipt.create({
    data: {
      itemId: input.itemId,
      day: new Date(`${input.day}T00:00:00.000Z`),
      quantity: input.quantity,
      note: input.note.trim() || null,
      createdByUserId: user.id,
    },
  });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true, message: "Приход записан." };
}

/** Правка записи прихода: ошиблись в количестве или дате — не надо удалять и заводить заново. */
export async function ownerUpdateConsumableReceipt(input: {
  id: string;
  itemId: string;
  day: string;
  quantity: number;
  note: string;
}): Promise<Result> {
  await requireRole("OWNER");
  if (!input.id) return { error: "Не указана запись." };
  if (!input.itemId) return { error: "Выберите позицию." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.day)) return { error: "Укажите дату." };
  if (!Number.isInteger(input.quantity) || input.quantity === 0) return { error: "Количество должно быть целым и не нулевым." };

  await prisma.consumableReceipt.update({
    where: { id: input.id },
    data: {
      itemId: input.itemId,
      day: new Date(`${input.day}T00:00:00.000Z`),
      quantity: input.quantity,
      note: input.note.trim() || null,
    },
  });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true, message: "Изменено." };
}

export async function ownerDeleteConsumableReceipt(id: string): Promise<Result> {
  await requireRole("OWNER");
  await prisma.consumableReceipt.deleteMany({ where: { id } });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true };
}
