"use client";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { ownerUpdateUser } from "@/app/dashboard/(owner)/actions";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import type { Role } from "@/generated/prisma/enums";

/**
 * Правка пользователя в компактном окне: имя, email, роль, статус и необязательный новый
 * пароль. Телефон и Telegram здесь не показываются — они не нужны для управления доступом.
 *
 * Права проверяет сервер (ownerUpdateUser → ownerOnly), окно лишь скрывает кнопку от чужих
 * глаз. Текущий пароль не запрашивается и не отображается: поле пустое = «не менять».
 */
export function EditUserDialog({
  user,
}: {
  user: { id: string; name: string; email: string; role: Role; active: boolean };
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Отправляем сами, а не через action формы: успех должен закрыть окно, а закрытие из
  // эффекта по состоянию давало бы каскадный рендер. Список обновляет revalidatePath.
  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    setError(null);
    startTransition(async () => {
      const res = await ownerUpdateUser(null, formData);
      if (res?.success) {
        toast.success("Пользователь обновлён");
        setOpen(false);
      } else {
        setError(res?.error ?? "Не удалось сохранить");
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`Редактировать ${user.name}`}
          title="Редактировать"
          className="rounded-md p-1.5 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
        >
          <Pencil className="size-4" />
        </button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Редактировать пользователя</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="space-y-3">
          <input type="hidden" name="userId" value={user.id} />

          <div className="space-y-1.5">
            <Label htmlFor={`eu-name-${user.id}`}>Имя</Label>
            <Input id={`eu-name-${user.id}`} name="name" defaultValue={user.name} required />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`eu-email-${user.id}`}>Email</Label>
            <Input id={`eu-email-${user.id}`} name="email" type="email" defaultValue={user.email} required />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor={`eu-role-${user.id}`}>Роль</Label>
              <Select id={`eu-role-${user.id}`} name="role" defaultValue={user.role}>
                <option value="OWNER">Владелец</option>
                <option value="FLORIST">Флорист</option>
                <option value="CALL_CENTER">Колл-центр</option>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={`eu-active-${user.id}`}>Статус</Label>
              <Select id={`eu-active-${user.id}`} name="active" defaultValue={String(user.active)}>
                <option value="true">Активен</option>
                <option value="false">Отключён</option>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor={`eu-pass-${user.id}`}>Новый пароль</Label>
            <Input
              id={`eu-pass-${user.id}`}
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={8}
              placeholder="Оставьте пустым, чтобы не менять"
            />
            <p className="text-[11px] text-slate-400">Минимум 8 символов. Текущий пароль не показывается.</p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>
          )}

          <div className="flex justify-end pt-1">
            <Button type="submit" disabled={pending}>
              {pending ? "Сохранение…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
