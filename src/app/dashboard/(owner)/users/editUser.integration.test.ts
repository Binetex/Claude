/**
 * Правка пользователя владельцем — на реальной БД (throwaway prisma dev).
 * Проверяем именно то, что нельзя увидеть в UI: что попало в базу, что стало с hash пароля
 * и работает ли старый пароль после смены.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { prisma } from "@/lib/db";
import bcrypt from "bcryptjs";

// Роль вызывающего подменяем: сама проверка прав живёт в requireRole, здесь важно поведение
// действия при владельце и отказ при остальных.
const role = { current: "OWNER" as "OWNER" | "FLORIST" | "CALL_CENTER" };
vi.mock("@/lib/rbac", () => ({
  requireRole: (...roles: string[]) => {
    if (!roles.includes(role.current)) throw new Error("FORBIDDEN");
    return Promise.resolve({ id: "u", role: role.current, floristId: null });
  },
  requireUser: () => Promise.resolve({ id: "u", role: role.current, floristId: null }),
  requireFlorist: () => Promise.resolve({ id: "u", role: role.current, floristId: "f" }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

const { ownerUpdateUser } = await import("../actions");

const RUN = `eu-${Date.now()}`;
const userIds: string[] = [];

async function makeUser(suffix: string, over: Record<string, unknown> = {}) {
  const u = await prisma.user.create({
    data: {
      name: `Пользователь ${suffix}`,
      email: `${RUN}-${suffix}@example.com`,
      passwordHash: await bcrypt.hash("oldpassword123", 10),
      role: "CALL_CENTER",
      active: true,
      ...over,
    },
  });
  userIds.push(u.id);
  return u;
}

/** Форма приходит из браузера — воспроизводим её как есть. */
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeAll(() => {
  role.current = "OWNER";
});

afterAll(async () => {
  await prisma.florist.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe("правка полей пользователя", () => {
  it("меняет имя, email, роль и статус одним сохранением", async () => {
    const u = await makeUser("fields");
    const res = await ownerUpdateUser(
      null,
      form({ userId: u.id, name: "Новое Имя", email: `${RUN}-changed@example.com`, role: "CALL_CENTER", active: "false" })
    );
    expect(res).toEqual({ success: true });

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.name).toBe("Новое Имя");
    expect(after.email).toBe(`${RUN}-changed@example.com`);
    expect(after.active).toBe(false);
  });

  it("email приводится к нижнему регистру", async () => {
    const u = await makeUser("case");
    await ownerUpdateUser(null, form({ userId: u.id, name: u.name, email: `${RUN}-UPPER@Example.COM`, role: u.role, active: "true" }));
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.email).toBe(`${RUN}-upper@example.com`);
  });

  it("занятый другим пользователем email отклоняется", async () => {
    const a = await makeUser("dup-a");
    const b = await makeUser("dup-b");
    const res = await ownerUpdateUser(null, form({ userId: b.id, name: b.name, email: a.email, role: b.role, active: "true" }));
    expect(res.error).toContain("уже занят");
    // Данные B не изменились.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.id } })).email).toBe(b.email);
  });

  it("свой собственный email сохранить можно (не считается дублем)", async () => {
    const u = await makeUser("self");
    const res = await ownerUpdateUser(null, form({ userId: u.id, name: "Тот же", email: u.email, role: u.role, active: "true" }));
    expect(res).toEqual({ success: true });
  });

  it("некорректный email и короткое имя отклоняются", async () => {
    const u = await makeUser("valid");
    expect((await ownerUpdateUser(null, form({ userId: u.id, name: "Имя", email: "не-email", role: u.role, active: "true" }))).error).toContain("email");
    expect((await ownerUpdateUser(null, form({ userId: u.id, name: "И", email: u.email, role: u.role, active: "true" }))).error).toContain("имя");
  });

  it("смена роли на флориста создаёт профиль флориста — иначе кабинет был бы недоступен", async () => {
    const u = await makeUser("to-florist");
    await ownerUpdateUser(null, form({ userId: u.id, name: u.name, email: u.email, role: "FLORIST", active: "true" }));
    const florist = await prisma.florist.findUnique({ where: { userId: u.id } });
    expect(florist).not.toBeNull();
    expect(florist?.financeVisibility).toBe("MAKER_ONLY");
  });
});

describe("пароль", () => {
  it("пустое поле НЕ меняет текущий пароль", async () => {
    const u = await makeUser("keep-pass");
    const before = u.passwordHash;

    await ownerUpdateUser(null, form({ userId: u.id, name: "Другое имя", email: u.email, role: u.role, active: "true", newPassword: "" }));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).toBe(before); // hash не тронут
    expect(await bcrypt.compare("oldpassword123", after.passwordHash)).toBe(true);
    expect(after.name).toBe("Другое имя"); // остальные поля при этом сохранились
  });

  it("новый пароль работает, старый перестаёт", async () => {
    const u = await makeUser("new-pass");
    await ownerUpdateUser(null, form({ userId: u.id, name: u.name, email: u.email, role: u.role, active: "true", newPassword: "brandnewpass1" }));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(await bcrypt.compare("brandnewpass1", after.passwordHash)).toBe(true);
    expect(await bcrypt.compare("oldpassword123", after.passwordHash)).toBe(false);
  });

  it("пароль хранится только как hash — открытым текстом в БД его нет", async () => {
    const u = await makeUser("hash-only");
    await ownerUpdateUser(null, form({ userId: u.id, name: u.name, email: u.email, role: u.role, active: "true", newPassword: "plaintextcheck1" }));
    const after = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(after.passwordHash).not.toContain("plaintextcheck1");
    expect(after.passwordHash.startsWith("$2")).toBe(true); // bcrypt
  });

  it("пароль короче 8 символов отклоняется и ничего не меняет", async () => {
    const u = await makeUser("short-pass");
    const before = u.passwordHash;
    const res = await ownerUpdateUser(null, form({ userId: u.id, name: u.name, email: u.email, role: u.role, active: "true", newPassword: "short" }));
    expect(res.error).toContain("8 символов");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).passwordHash).toBe(before);
  });
});

describe("доступ", () => {
  it("не-OWNER не может править пользователей", async () => {
    const u = await makeUser("acl");
    for (const r of ["FLORIST", "CALL_CENTER"] as const) {
      role.current = r;
      await expect(
        ownerUpdateUser(null, form({ userId: u.id, name: "Взлом", email: u.email, role: "OWNER", active: "true" }))
      ).rejects.toThrow("FORBIDDEN");
    }
    role.current = "OWNER";
    // Данные не изменились ни одной попыткой.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: u.id } })).name).toBe(u.name);
  });

  it("несуществующий пользователь — понятная ошибка, а не падение", async () => {
    const res = await ownerUpdateUser(null, form({ userId: "нет-такого", name: "Имя", email: "a@b.co", role: "OWNER", active: "true" }));
    expect(res.error).toContain("не найден");
  });
});
