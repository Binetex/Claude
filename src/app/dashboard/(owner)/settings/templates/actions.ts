"use server";
/**
 * Заготовки ответов клиенту — правит только владелец, вставлять может любой, кто пишет клиенту.
 * Само по себе сохранение заготовки ничего никому не отправляет.
 */
import { revalidatePath } from "next/cache";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/db";

export type TemplateResult = { ok?: true; error?: string };
const PATH = "/dashboard/settings/templates";
const MAX_TEXT = 1600; // тот же потолок, что у одной SMS в quo/send

export async function saveTemplate(input: { id?: string; title: string; text: string }): Promise<TemplateResult> {
  const user = await requireRole("OWNER");
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title) return { error: "Нужна подпись на кнопке." };
  if (!text) return { error: "Нужен текст заготовки." };
  if (text.length > MAX_TEXT) return { error: `Текст длиннее ${MAX_TEXT} символов — столько в одну SMS не влезет.` };

  if (input.id) {
    const r = await prisma.messageTemplate.updateMany({ where: { id: input.id }, data: { title, text } });
    if (r.count !== 1) return { error: "Заготовка не найдена." };
  } else {
    // Новая уходит в конец списка: порядок задаёт владелец, а не случайность вставки.
    const last = await prisma.messageTemplate.findFirst({ orderBy: { position: "desc" }, select: { position: true } });
    await prisma.messageTemplate.create({
      data: { title, text, position: (last?.position ?? 0) + 1, createdBy: user.id },
    });
  }
  revalidatePath(PATH);
  return { ok: true };
}

export async function setTemplateActive(id: string, active: boolean): Promise<TemplateResult> {
  await requireRole("OWNER");
  const r = await prisma.messageTemplate.updateMany({ where: { id }, data: { active } });
  if (r.count !== 1) return { error: "Заготовка не найдена." };
  revalidatePath(PATH);
  return { ok: true };
}

/** Перестановка на одну позицию. Частое — выше: оператор ищет кнопку глазами, а не листает. */
export async function moveTemplate(id: string, direction: "up" | "down"): Promise<TemplateResult> {
  await requireRole("OWNER");
  const all = await prisma.messageTemplate.findMany({ orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: { id: true } });
  const i = all.findIndex((t) => t.id === id);
  if (i === -1) return { error: "Заготовка не найдена." };
  const j = direction === "up" ? i - 1 : i + 1;
  if (j < 0 || j >= all.length) return { ok: true }; // край списка — не ошибка
  [all[i], all[j]] = [all[j], all[i]];
  // Переписываем позиции ВСЕМ: у старых записей они могли совпадать, и обмен двух значений
  // оставил бы список в прежнем порядке.
  await prisma.$transaction(all.map((t, n) => prisma.messageTemplate.update({ where: { id: t.id }, data: { position: n } })));
  revalidatePath(PATH);
  return { ok: true };
}

export async function deleteTemplate(id: string): Promise<TemplateResult> {
  await requireRole("OWNER");
  await prisma.messageTemplate.deleteMany({ where: { id } });
  revalidatePath(PATH);
  return { ok: true };
}
