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

/**
 * Дата по умолчанию у формы новой ставки.
 *
 * Первая настройка должна действовать с даты запуска расчёта, иначе дни между запуском и
 * сегодня останутся без неё и заблокируют расчёт. Когда записи уже есть, речь идёт о
 * настоящей смене ставки — она начинается сегодня.
 */
function defaultFrom(hasRecords: boolean, shareStartDate: string | null): string {
  return hasRecords || !shareStartDate ? today() : shareStartDate;
}

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

/**
 * Выбор магазина.
 *
 * `allowGlobal` меняет не только список, но и подпись: у настройки с общим значением это
 * действительно «область действия», а у комиссии общего значения не бывает — там нужно
 * просто выбрать магазин, и называть это иначе значит путать.
 *
 * Когда общего значения нет, ничего не выбрано заранее: подставленный первым магазин
 * слишком легко сохранить не глядя и записать ставку не туда.
 */
function SiteSelect({ sites, allowGlobal }: { sites: { id: string; shortName: string }[]; allowGlobal: boolean }) {
  return (
    <Field label={allowGlobal ? "Область действия" : "Магазин"}>
      <select
        name="siteId"
        defaultValue=""
        required={!allowGlobal}
        className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-xs"
      >
        {allowGlobal ? (
          <option value="">Все магазины</option>
        ) : (
          <option value="" disabled>
            Выберите магазин…
          </option>
        )}
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.shortName}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ConsumablesForm({
  sites,
  hasRecords = false,
  shareStartDate = null,
}: {
  sites: { id: string; shortName: string }[];
  hasRecords?: boolean;
  shareStartDate?: string | null;
}) {
  return (
    <SettingDialog
      trigger={hasRecords ? "Новая ставка с даты" : "Задать ставку"}
      title="Ставка расходников"
      action={applyConsumablesRate}
    >
      <SiteSelect sites={sites} allowGlobal />
      <Field label="Сумма на заказ, $">
        <Input name="amount" inputMode="decimal" placeholder="5.00" required />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={defaultFrom(hasRecords, shareStartDate)} />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
    </SettingDialog>
  );
}

export function FeeModelForm({
  sites,
  configuredSiteIds = [],
  shareStartDate = null,
}: {
  sites: { id: string; shortName: string }[];
  /** У каких магазинов модель уже есть — чтобы видеть, что осталось завести. */
  configuredSiteIds?: string[];
  shareStartDate?: string | null;
}) {
  const missing = sites.filter((s) => !configuredSiteIds.includes(s.id));
  return (
    <SettingDialog
      trigger={configuredSiteIds.length > 0 ? "Новая модель с даты" : "Добавить модель"}
      title="Модель комиссии магазина"
      action={applyFeeModel}
    >
      <SiteSelect sites={sites} allowGlobal={false} />
      {missing.length > 0 && (
        <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
          Комиссия задаётся отдельно каждому магазину — общей ставки не бывает. Ещё без модели:{" "}
          {missing.map((s) => s.shortName).join(", ")}.
        </p>
      )}
      <Field label="Процент, %">
        <Input name="percent" inputMode="decimal" placeholder="2.90" required />
      </Field>
      <Field label="Фиксированная часть, $">
        <Input name="fixed" inputMode="decimal" placeholder="0.30" />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={defaultFrom(configuredSiteIds.length > 0, shareStartDate)} />
      </Field>
      <Field label="Комментарий">
        <Input name="comment" />
      </Field>
    </SettingDialog>
  );
}

export function TaxPolicyForm({
  sites,
  hasRecords = false,
  shareStartDate = null,
}: {
  sites: { id: string; shortName: string }[];
  hasRecords?: boolean;
  shareStartDate?: string | null;
}) {
  return (
    <SettingDialog
      trigger={hasRecords ? "Новая политика с даты" : "Задать политику"}
      title="Налоговая политика владельца"
      action={applyOwnerTaxPolicy}
    >
      <SiteSelect sites={sites} allowGlobal />
      <Field label="Реальный налоговый расход, % от собранного">
        <Input name="percent" inputMode="decimal" placeholder="20" required />
      </Field>
      <Field label="Действует с">
        <Input name="effectiveFrom" type="date" defaultValue={defaultFrom(hasRecords, shareStartDate)} />
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
