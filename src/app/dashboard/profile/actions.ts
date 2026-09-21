"use server";
/**
 * Фото сотрудника. Меняет только САМ сотрудник и только себе: id берётся из сессии, а не из
 * аргумента, иначе любой вошедший мог бы подменить аватарку владельцу.
 */
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/rbac";
import { prisma } from "@/lib/db";
import { imageStorage } from "@/lib/storage";

export type AvatarResult = { ok?: true; url?: string | null; error?: string };

export async function saveAvatarAction(photoDataUrl: string): Promise<AvatarResult> {
  const user = await requireUser();
  if (!/^data:image\//.test(photoDataUrl)) return { error: "Это не изображение." };
  // Потолок на всякий случай: картинку жмёт браузер, но сюда может прийти и прямой вызов.
  if (photoDataUrl.length > 4_000_000) return { error: "Файл слишком большой — выберите фото поменьше." };

  let url: string;
  try {
    url = await imageStorage.saveImage(photoDataUrl);
  } catch {
    return { error: "Не удалось сохранить фото." };
  }
  await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: url } });
  // Аватарка стоит в шапке КАЖДОЙ страницы, поэтому обновляем весь кабинет, а не одну.
  revalidatePath("/dashboard", "layout");
  return { ok: true, url };
}

export async function removeAvatarAction(): Promise<AvatarResult> {
  const user = await requireUser();
  // Старый файл на диске остаётся: он лежит под случайным именем, на него никто не ссылается,
  // а удаление означало бы гонку с ещё не перерисованными вкладками.
  await prisma.user.update({ where: { id: user.id }, data: { avatarUrl: null } });
  revalidatePath("/dashboard", "layout");
  return { ok: true, url: null };
}
