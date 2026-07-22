import "server-only";
import { redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "@/lib/auth";
import type { Role } from "@/generated/prisma/enums";

/** Требует авторизованного пользователя; иначе — на /login. */
export async function requireUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/** Требует одну из ролей; иначе — на домашнюю страницу своей роли. */
export async function requireRole(...roles: Role[]): Promise<CurrentUser> {
  const user = await requireUser();
  if (!roles.includes(user.role)) redirect(homePathFor(user.role));
  return user;
}

/** Требует роль флориста и наличие профиля флориста. */
export async function requireFlorist(): Promise<CurrentUser & { floristId: string }> {
  const user = await requireRole("FLORIST");
  if (!user.floristId) redirect("/login");
  return user as CurrentUser & { floristId: string };
}

/**
 * Роли, которым разрешено РЕДАКТИРОВАТЬ данные заказа (нефинансовые блоки):
 * владелец, колл-центр и флорист. Финансовые действия и назначение флориста
 * остаются OWNER-only (см. (owner)/actions.ts) — этот guard их не покрывает.
 * Флорист дополнительно ограничен своими заказами — проверка владения делается
 * в самом действии (saveOrderBlock), т.к. rbac не знает orderId.
 */
export async function requireOrderEditor(): Promise<CurrentUser> {
  return requireRole("OWNER", "CALL_CENTER", "FLORIST");
}

export function homePathFor(role: Role): string {
  switch (role) {
    case "OWNER":
      return "/dashboard";
    case "FLORIST":
      return "/dashboard/f";
    case "CALL_CENTER":
      return "/dashboard/cc";
  }
}
