"use client";
import { useActionState, useState } from "react";
import { ownerCreateFlorist } from "./floristActions";
import { AvatarUpload } from "./AvatarUpload";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

/** «+ Add florist» — создание User(role=FLORIST)+Florist. Логин = email; пароль задаёт владелец. */
export function AddFloristForm() {
  const [state, formAction, pending] = useActionState(ownerCreateFlorist, null);
  const [open, setOpen] = useState(false);

  if (!open) {
    return <Button type="button" size="sm" onClick={() => setOpen(true)}>+ Add florist</Button>;
  }

  return (
    <div className="rounded-lg border border-slate-200 p-4">
      <form action={formAction} className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="af-name">Name</Label>
          <Input id="af-name" name="name" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-email">Email / Login</Label>
          <Input id="af-email" name="email" type="email" required />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-phone">Phone</Label>
          <Input id="af-phone" name="phone" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="af-password">Password</Label>
          <Input id="af-password" name="password" type="text" required minLength={8} autoComplete="new-password" />
        </div>
        <AvatarUpload name="avatarDataUrl" />
        <label className="flex items-center gap-2 self-end text-sm text-slate-700">
          <input type="checkbox" name="active" defaultChecked className="h-4 w-4" /> Active
        </label>
        <div className="flex items-end gap-2">
          <Button type="submit" disabled={pending}>{pending ? "Создаём…" : "Create florist"}</Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Отмена</Button>
        </div>
      </form>
      {state?.error && <div className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}
      {state?.success && <div className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Флорист создан. Логин — email, пароль вы задали.</div>}
    </div>
  );
}
