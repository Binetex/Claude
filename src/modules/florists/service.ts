import "server-only";
/**
 * Создание/редактирование флориста (внутренняя админка). Расширяет существующий паттерн
 * User+Florist (см. ownerCreateUser). Логин = email (отдельного username в архитектуре нет).
 * НЕ трогает связи (pickup/priority/assignments/deliveries) — только скалярные поля User/Florist.
 */
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { hashPassword } from "@/lib/auth";
import { toE164 } from "@/lib/phone";

/** Ошибка валидации/уникальности — вызывающий (server action) показывает message пользователю. */
export class FloristValidationError extends Error {
  constructor(public readonly reason: string, message: string) {
    super(message);
    this.name = "FloristValidationError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 8;

function normName(name: string): string {
  const n = name.trim();
  if (n.length < 2) throw new FloristValidationError("name", "Укажите имя (минимум 2 символа).");
  return n;
}
function normEmail(email: string): string {
  const e = email.trim().toLowerCase();
  if (!EMAIL_RE.test(e)) throw new FloristValidationError("email", "Некорректный email (он же логин).");
  return e;
}
function checkPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) throw new FloristValidationError("password", `Пароль минимум ${PASSWORD_MIN} символов.`);
}
/** Нормализация телефона: E.164, если распознан; иначе — обрезанный ввод; пусто → null. */
function normPhone(phone: string | null | undefined): string | null {
  const raw = phone?.trim();
  if (!raw) return null;
  return toE164(raw) ?? raw;
}

/** Активные флористы (florist.active && user.active), кроме указанного — цели для передачи заказа. */
export async function listActiveHandoffTargets(prisma: PrismaClient, exceptFloristId: string): Promise<{ id: string; name: string }[]> {
  const rows = await prisma.florist.findMany({
    where: { active: true, user: { active: true }, id: { not: exceptFloristId } },
    select: { id: true, user: { select: { name: true } } },
    orderBy: { user: { name: "asc" } },
  });
  return rows.map((f) => ({ id: f.id, name: f.user.name }));
}

export type CreateFloristInput = { name: string; email: string; phone?: string | null; password: string; active?: boolean; avatarUrl?: string | null };
export type UpdateFloristInput = { name?: string; email?: string; phone?: string | null; password?: string | null; active?: boolean; avatarUrl?: string | null };

/** Создаёт User(role=FLORIST) + Florist в одной транзакции. financeVisibility по умолчанию MAKER_ONLY (меняется отдельным тумблером). */
export async function createFlorist(prisma: PrismaClient, input: CreateFloristInput): Promise<{ floristId: string; userId: string }> {
  const name = normName(input.name);
  const email = normEmail(input.email);
  checkPassword(input.password);
  const phone = normPhone(input.phone);
  const active = input.active ?? true;

  const dup = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (dup) throw new FloristValidationError("duplicate_email", `Пользователь с email/логином ${email} уже существует.`);

  const passwordHash = await hashPassword(input.password);
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({ data: { name, email, phone, role: "FLORIST", passwordHash, active } });
    const florist = await tx.florist.create({ data: { userId: user.id, active, financeVisibility: "MAKER_ONLY", avatarUrl: input.avatarUrl ?? null } });
    return { floristId: florist.id, userId: user.id };
  });
}

/**
 * Обновляет флориста БЕЗ создания нового пользователя: только заданные поля. Пароль пустой/undefined —
 * не меняется. Active синхронизируется на User и Florist (вход + auto-assignment). Связи не трогаются.
 */
export async function updateFlorist(prisma: PrismaClient, floristId: string, input: UpdateFloristInput): Promise<void> {
  const florist = await prisma.florist.findUnique({ where: { id: floristId }, select: { id: true, userId: true } });
  if (!florist) throw new FloristValidationError("not_found", "Флорист не найден.");

  const userData: Prisma.UserUpdateInput = {};
  if (input.name !== undefined) userData.name = normName(input.name);
  if (input.email !== undefined) {
    const email = normEmail(input.email);
    const dup = await prisma.user.findFirst({ where: { email, id: { not: florist.userId } }, select: { id: true } });
    if (dup) throw new FloristValidationError("duplicate_email", `Email/логин ${email} уже занят другим пользователем.`);
    userData.email = email;
  }
  if (input.phone !== undefined) userData.phone = normPhone(input.phone);
  if (input.password) { checkPassword(input.password); userData.passwordHash = await hashPassword(input.password); }
  if (input.active !== undefined) userData.active = input.active;

  const floristData: Prisma.FloristUpdateInput = {};
  if (input.active !== undefined) floristData.active = input.active;
  if (input.avatarUrl !== undefined) floristData.avatarUrl = input.avatarUrl;

  await prisma.$transaction(async (tx) => {
    if (Object.keys(userData).length > 0) await tx.user.update({ where: { id: florist.userId }, data: userData });
    if (Object.keys(floristData).length > 0) await tx.florist.update({ where: { id: floristId }, data: floristData });
  });
}
