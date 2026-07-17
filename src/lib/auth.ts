import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify } from "jose";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import type { Role } from "@/generated/prisma/enums";

const COOKIE_NAME = "fd_session";

function loadSecret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET не задан — обязателен в production (генерация сессий заблокирована).");
    }
    return new TextEncoder().encode("dev-insecure-secret-change-me");
  }
  return new TextEncoder().encode(value);
}

const secret = loadSecret();

export type SessionPayload = { userId: string };

export type CurrentUser = {
  id: string;
  name: string;
  email: string;
  role: Role;
  active: boolean;
  floristId: string | null;
};

/** Создаёт JWT-сессию в httpOnly-cookie. */
export async function createSession(userId: string) {
  const token = await new SignJWT({ userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);

  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}

export async function destroySession() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

async function readSession(): Promise<SessionPayload | null> {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret);
    return { userId: payload.userId as string };
  } catch {
    return null;
  }
}

/** Возвращает текущего пользователя или null. Финансовые/чужие данные НЕ включаются. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const session = await readSession();
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    include: { florist: { select: { id: true } } },
  });
  if (!user || !user.active) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    active: user.active,
    floristId: user.florist?.id ?? null,
  };
}

/** Проверяет email+пароль, возвращает userId при успехе. */
export async function verifyCredentials(
  email: string,
  password: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
  });
  if (!user || !user.active) return null;
  const ok = await bcrypt.compare(password, user.passwordHash);
  return ok ? user.id : null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}
