"use client";
/**
 * Формы настроек расчёта. Пишут через те же server actions, что и ассистент, — второго
 * пути записи нет, поэтому аудит и пересборка снимков происходят одинаково независимо
 * от того, откуда владелец зашёл.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import {
  applyConsumablesRate,
  applyDailyFlowerExpense,
  applyFeeModel,
  applyOwnerTaxPolicy,
  type SetupResult,
} from "@/app/dashboard/(owner)/finance/setup/setupActions";

const today = () => new Date().toISOString().slice(0, 10);

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

function SettingDialog({
  trigger,
  title,
  action,
  children,
}: {
  trigger: string;
  title: string;
  action: (fd: FormData) => Promise<SetupResult>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          {trigger}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          action={(fd) =>
            start(async () => {
              const res = await action(fd);
              if (res.error) {
                toast.error(res.error);
                return;
              }
              toast.success(res.message ?? "Сохранено");
              setOpen(false);
            })
          }
          className="space-y-3"
        >
          {children}
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Сохраняю…" : "Сохранить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SiteSelect({ sites, allowGlobal }: { sites: { id: string; shortName: string }[]; allowGlobal: boolean }) {
  return (
    <Field label="Область действия">
      <select name="siteId" defaultValue="" className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-xs">
        {allowGlobal && <option value="">Все магазины</option>}
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.shortName}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ConsumablesForm({ sites }: { sites: { id: string; shortName: string }[] }) {
  return (
    <SettingDialog trigger="Задать ставку" title="Ставка расходников" action={applyConsumablesRate}>
      <SiteSelect sites={sites} allowGlobal />
      <Field label="Сумма на заказ, $">
        <Input name="amount" inputMode="decimal" placeholder="5.00" required />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={today()} />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
    </SettingDialog>
  );
}

export function FeeModelForm({ sites }: { sites: { id: string; shortName: string }[] }) {
  return (
    <SettingDialog trigger="Добавить модель" title="Модель комиссии магазина" action={applyFeeModel}>
      <SiteSelect sites={sites} allowGlobal={false} />
      <Field label="Процент, %">
        <Input name="percent" inputMode="decimal" placeholder="2.90" required />
      </Field>
      <Field label="Фиксированная часть, $">
        <Input name="fixed" inputMode="decimal" placeholder="0.30" />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={today()} />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
    </SettingDialog>
  );
}

export function TaxPolicyForm({ sites }: { sites: { id: string; shortName: string }[] }) {
  return (
    <SettingDialog trigger="Задать политику" title="Налоговая политика владельца" action={applyOwnerTaxPolicy}>
      <SiteSelect sites={sites} allowGlobal />
      <Field label="Реальный налоговый расход, % от собранного">
        <Input name="percent" inputMode="decimal" placeholder="20" required />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={today()} />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Флористам этот процент не показывается: в их базе налог вычитается на 100%.
      </p>
    </SettingDialog>
  );
}

export function FlowerExpenseForm() {
  return (
    <SettingDialog trigger="Внести закупку" title="Расходы на цветы за день" action={applyDailyFlowerExpense}>
      <Field label="День">
        <Input name="day" type="date" defaultValue={today()} required />
      </Field>
      <Field label="Сумма, $">
        <Input name="amount" inputMode="decimal" placeholder="180.00" required />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
      <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
        Распределяется только между заказами основного флориста этого дня, пропорционально цветочной части заказа.
      </p>
    </SettingDialog>
  );
}
