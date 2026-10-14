"use server";
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { randomUUID } from "node:crypto";
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

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

async function floristExists(floristId: string): Promise<boolean> {
  return !!(floristId && (await prisma.florist.findUnique({ where: { id: floristId }, select: { id: true } })));
}

/**
 * Приход: купили N штук — и у кого из флористов они лежат (владелец 14.10.2026: «коробки из Китая
 * сначала пришли Ольге»). Без флориста остаток не разложить, поэтому он обязателен.
 */
export async function ownerAddConsumableReceipt(input: { itemId: string; floristId: string; day: string; quantity: number; note: string }): Promise<Result> {
  const user = await requireRole("OWNER");
  if (!input.itemId) return { error: "Выберите позицию." };
  if (!(await floristExists(input.floristId))) return { error: "Выберите, кому пришло." };
  if (!DAY_RE.test(input.day)) return { error: "Укажите дату." };
  if (!Number.isInteger(input.quantity) || input.quantity === 0) return { error: "Количество должно быть целым и не нулевым." };

  await prisma.consumableReceipt.create({
    data: {
      itemId: input.itemId,
      floristId: input.floristId,
      day: new Date(`${input.day}T00:00:00.000Z`),
      quantity: input.quantity,
      note: input.note.trim() || null,
      createdByUserId: user.id,
    },
  });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true, message: "Приход записан." };
}

/**
 * Правка записи прихода: ошиблись в количестве, дате или флористе — не надо удалять и заводить
 * заново. Так же раскладываются по флористам записи, сделанные до разделения. Передачу правкой не
 * трогаем: у неё две строки, и правка одной сломала бы равенство — её удаляют и записывают заново.
 */
export async function ownerUpdateConsumableReceipt(input: {
  id: string;
  itemId: string;
  floristId: string;
  day: string;
  quantity: number;
  note: string;
}): Promise<Result> {
  await requireRole("OWNER");
  if (!input.id) return { error: "Не указана запись." };
  if (!input.itemId) return { error: "Выберите позицию." };
  if (!(await floristExists(input.floristId))) return { error: "Выберите, кому пришло." };
  if (!DAY_RE.test(input.day)) return { error: "Укажите дату." };
  if (!Number.isInteger(input.quantity) || input.quantity === 0) return { error: "Количество должно быть целым и не нулевым." };
  const row = await prisma.consumableReceipt.findUnique({ where: { id: input.id }, select: { transferId: true } });
  if (!row) return { error: "Запись не найдена." };
  if (row.transferId) return { error: "Передачу можно только удалить и записать заново." };

  await prisma.consumableReceipt.update({
    where: { id: input.id },
    data: {
      itemId: input.itemId,
      floristId: input.floristId,
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
  await prisma.consumableReceipt.deleteMany({ where: { id, transferId: null } });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true };
}

/**
 * Передача между флористами: «Ольга передала Насте 200 коробок». Две строки в одной транзакции —
 * минус у отдавшего, плюс у получившего, с общим `transferId`: в общем остатке они гасятся, а
 * остаток каждой меняется. Больше, чем числится у отдающего, передать можно: остаток бывает неточен
 * (приход записан не весь), а запрет мешал бы записать то, что уже случилось.
 */
export async function ownerAddConsumableTransfer(input: {
  itemId: string;
  fromFloristId: string;
  toFloristId: string;
  day: string;
  quantity: number;
  note: string;
}): Promise<Result> {
  const user = await requireRole("OWNER");
  if (!input.itemId) return { error: "Выберите позицию." };
  if (!(await floristExists(input.fromFloristId)) || !(await floristExists(input.toFloristId))) return { error: "Выберите, кто передал и кому." };
  if (input.fromFloristId === input.toFloristId) return { error: "Передать можно только другому флористу." };
  if (!DAY_RE.test(input.day)) return { error: "Укажите дату." };
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) return { error: "Количество — целое больше нуля." };

  const transferId = randomUUID();
  const base = {
    itemId: input.itemId,
    day: new Date(`${input.day}T00:00:00.000Z`),
    note: input.note.trim() || null,
    transferId,
    createdByUserId: user.id,
  };
  await prisma.consumableReceipt.createMany({
    data: [
      { ...base, floristId: input.fromFloristId, quantity: -input.quantity },
      { ...base, floristId: input.toFloristId, quantity: input.quantity },
    ],
  });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true, message: "Передача записана." };
}

/** Удалить передачу целиком — обе строки, иначе у одной из сторон остался бы лишний плюс или минус. */
export async function ownerDeleteConsumableTransfer(transferId: string): Promise<Result> {
  await requireRole("OWNER");
  if (!transferId) return { error: "Не указана передача." };
  await prisma.consumableReceipt.deleteMany({ where: { transferId } });
  revalidatePath(`${PATH}/receipts`);
  return { ok: true };
}
