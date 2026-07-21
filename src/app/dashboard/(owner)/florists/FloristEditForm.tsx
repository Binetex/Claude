"use client";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";
import { ownerUpdateFlorist, ownerSetFloristActive } from "./floristActions";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type FloristForEdit = { id: string; name: string; email: string; phone: string | null; active: boolean };

/** Редактирование флориста (без создания нового пользователя) + быстрый тумблер Active/Inactive. */
export function FloristEditForm({ florist }: { florist: FloristForEdit }) {
  const [state, formAction, pending] = useActionState(ownerUpdateFlorist, null);
  const [open, setOpen] = useState(false);
  const [toggling, startToggle] = useTransition();

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen((v) => !v)}>
          {open ? "Свернуть" : "Редактировать"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={toggling}
          onClick={() =>
            startToggle(async () => {
              const r = await ownerSetFloristActive(florist.id, !florist.active);
              if (r?.error) toast.error(r.error);
              else toast.success(florist.active ? "Флорист отключён" : "Флорист включён");
            })
          }
        >
          {florist.active ? "Отключить" : "Включить"}
        </Button>
      </div>

      {open && (
        <form action={formAction} className="mt-2 space-y-2">
          <input type="hidden" name="floristId" value={florist.id} />
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1"><Label htmlFor={`ef-name-${florist.id}`}>Name</Label><Input id={`ef-name-${florist.id}`} name="name" defaultValue={florist.name} required /></div>
            <div className="space-y-1"><Label htmlFor={`ef-email-${florist.id}`}>Email / Login</Label><Input id={`ef-email-${florist.id}`} name="email" type="email" defaultValue={florist.email} required /></div>
            <div className="space-y-1"><Label htmlFor={`ef-phone-${florist.id}`}>Phone</Label><Input id={`ef-phone-${florist.id}`} name="phone" defaultValue={florist.phone ?? ""} /></div>
            <div className="space-y-1"><Label htmlFor={`ef-pw-${florist.id}`}>New password (пусто = без изменений)</Label><Input id={`ef-pw-${florist.id}`} name="password" type="text" autoComplete="new-password" /></div>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" name="active" defaultChecked={florist.active} className="h-4 w-4" /> Active
          </label>
          <div className="flex items-center gap-2">
            <Button type="submit" size="sm" disabled={pending}>{pending ? "Сохраняем…" : "Сохранить"}</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Отмена</Button>
          </div>
          {state?.error && <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{state.error}</div>}
          {state?.success && <div className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">Сохранено.</div>}
        </form>
      )}
    </div>
  );
}
