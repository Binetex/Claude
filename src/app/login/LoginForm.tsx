"use client";
import { useActionState } from "react";
import { loginAction } from "@/app/actions/auth";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, null);

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="username" required placeholder="owner@demo.local" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Пароль</Label>
        <Input id="password" name="password" type="password" autoComplete="current-password" required placeholder="••••••••" />
      </div>
      {state?.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}
      <Button type="submit" disabled={pending} className="w-full">
        {pending ? "Вход…" : "Войти"}
      </Button>
    </form>
  );
}
