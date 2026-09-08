"use client";
import { useActionState, useState } from "react";
import { toast } from "sonner";
import { ownerCreateUser } from "@/app/dashboard/(owner)/actions";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

export function CreateUserForm() {
  const [state, formAction, pending] = useActionState(ownerCreateUser, null);
  const [copied, setCopied] = useState(false);

  return (
    <div className="space-y-3">
      <form action={formAction} className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-1.5">
          <Label htmlFor="cu-name">Имя</Label>
          <Input id="cu-name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cu-email">Email</Label>
          <Input id="cu-email" name="email" type="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cu-phone">Телефон (необязательно)</Label>
          <Input id="cu-phone" name="phone" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cu-role">Роль</Label>
          <Select id="cu-role" name="roleChoice" required defaultValue="">
            <option value="" disabled>Выберите роль…</option>
            <option value="FLORIST_PRIMARY">Основной флорист (полная цена)</option>
            <option value="FLORIST_SECONDARY">Второстепенный флорист (ограниченная цена)</option>
            <option value="CALL_CENTER">Специалист колл-центра</option>
          </Select>
        </div>
        <div className="lg:col-span-4">
          <Button type="submit" disabled={pending}>
            {pending ? "Создаём…" : "Создать пользователя"}
          </Button>
        </div>
      </form>

      {state?.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}

      {state?.success && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
          <div className="font-semibold text-emerald-800">Пользователь создан: {state.email}</div>
          <div className="mt-1 text-emerald-700">
            Пароль (показан один раз, скопируйте сейчас):{" "}
            <code className="rounded bg-white px-2 py-0.5 font-mono text-emerald-900">{state.password}</code>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 border-emerald-300 text-emerald-700 hover:bg-emerald-100"
            onClick={async () => {
              await navigator.clipboard.writeText(state.password ?? "");
              setCopied(true);
              toast.success("Пароль скопирован");
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "Скопировано ✓" : "Копировать пароль"}
          </Button>
        </div>
      )}
    </div>
  );
}
