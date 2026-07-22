"use server";
import { redirect } from "next/navigation";
import { createSession, destroySession, verifyCredentials } from "@/lib/auth";
import { getCurrentUser } from "@/lib/auth";
import { homePathFor } from "@/lib/rbac";

export async function loginAction(_prev: unknown, formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  if (!email || !password) return { error: "Введите email и пароль." };

  const userId = await verifyCredentials(email, password);
  if (!userId) return { error: "Неверный email или пароль." };

  await createSession(userId);
  const user = await getCurrentUser();
  redirect(user ? homePathFor(user.role) : "/login");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
