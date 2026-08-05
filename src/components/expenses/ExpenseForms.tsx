"use client";
/**
 * Формы расхода владельца: добавить, изменить, удалить.
 *
 * Срок расхода выбирается ЗДЕСЬ и больше нигде: владелец задаёт правило один раз, а
 * дальше повторяющийся расход сам появляется в каждом месяце.
 *
 * Поля срока показываются по выбранному виду, а не все сразу: у разового расхода конца
 * не бывает, у «с… по…» он обязателен. Форма из четырёх полей превращалась бы в семь,
 * если бы показывала всё разом.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export type ExpenseCategoryDto = {
  id: string;
  name: string;
  subcategories: { id: string; name: string }[];
};

export type ExpenseActions = {
  save: (fd: FormData) => Promise<{ error?: string; message?: string }>;
  remove: (fd: FormData) => Promise<{ error?: string; message?: string }>;
};

export type ExpenseEditValues = {
  id: string;
  categoryId: string;
  subcategoryId: string | null;
  title: string | null;
  amountCents: number;
  kind: string;
  startDay: string;
  endDay: string | null;
};

const KINDS = [
  { value: "ONE_OFF", label: "Разово в один день" },
  { value: "DAILY", label: "Каждый день" },
  { value: "MONTHLY", label: "Каждый месяц" },
  { value: "RANGE", label: "С даты по дату" },
];

const NEW_CATEGORY = "__new__";
const NEW_SUBCATEGORY = "__new_sub__";
const todayKey = () => new Date().toISOString().slice(0, 10);

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function ExpenseDialog({
  actions,
  categories,
  trigger,
  triggerLabel,
  day,
  edit,
  variant = "outline",
  size = "sm",
  className,
  open: openProp,
  onOpenChange,
}: {
  actions: ExpenseActions;
  categories: ExpenseCategoryDto[];
  /** Текст или иконка на кнопке. Пусто — диалогом управляют снаружи через `open`. */
  trigger?: React.ReactNode;
  /** Подпись для иконочной кнопки: без неё она безымянна для читалки и без подсказки. */
  triggerLabel?: string;
  /**
   * Внешнее управление. Нужно там, где диалог открывается из меню «…»: вложить триггер
   * диалога внутрь Popover нельзя — Popover закрывается и уносит диалог за собой.
   */
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
  /** День, предустановленный в форме. */
  day?: string;
  /** Заполнено — режим правки существующего расхода. */
  edit?: ExpenseEditValues;
  variant?: "outline" | "default" | "ghost";
  size?: "sm" | "default" | "iconSm";
  className?: string;
}) {
  const [openInner, setOpenInner] = useState(false);
  const controlled = openProp != null;
  const open = controlled ? openProp : openInner;
  const setOpen = (v: boolean) => (controlled ? onOpenChange?.(v) : setOpenInner(v));
  const [pending, start] = useTransition();
  const [kind, setKind] = useState(edit?.kind ?? "ONE_OFF");
  const [categoryId, setCategoryId] = useState(edit?.categoryId ?? categories[0]?.id ?? "");
  const [subcategoryId, setSubcategoryId] = useState(edit?.subcategoryId ?? "");

  // Подкатегории принадлежат категории: сменил категорию — прежний выбор больше не к месту.
  const subcategories = categories.find((c) => c.id === categoryId)?.subcategories ?? [];
  const changeCategory = (id: string) => {
    setCategoryId(id);
    setSubcategoryId("");
  };

  const submit = (fd: FormData) =>
    start(async () => {
      const res = await actions.save(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Сохранено");
      setOpen(false);
    });

  const startLabel = kind === "ONE_OFF" ? "Дата" : "Действует с";

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger != null && (
        <DialogTrigger asChild>
          <Button variant={variant} size={size} className={className} aria-label={triggerLabel} title={triggerLabel}>
            {trigger}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edit ? "Изменить расход" : "Добавить расход"}</DialogTitle>
        </DialogHeader>

        <form action={submit} className="space-y-3">
          {edit && <input type="hidden" name="id" value={edit.id} />}

          <Field label="Срок">
            <Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>{k.label}</option>
              ))}
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label={startLabel}>
              <Input type="date" name="startDay" defaultValue={edit?.startDay ?? day ?? todayKey()} required />
            </Field>
            {kind !== "ONE_OFF" && (
              <Field label="По" hint={kind === "RANGE" ? undefined : "Пусто — пока не отменю"}>
                <Input type="date" name="endDay" defaultValue={edit?.endDay ?? ""} required={kind === "RANGE"} />
              </Field>
            )}
          </div>

          <Field label="Категория">
            <Select name="categoryId" value={categoryId} onChange={(e) => changeCategory(e.target.value)}>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
              <option value={NEW_CATEGORY}>+ Новая категория…</option>
            </Select>
          </Field>

          {categoryId === NEW_CATEGORY && (
            <Field label="Название категории">
              <Input name="newCategoryName" placeholder="Например: Бухгалтерия" required autoFocus />
            </Field>
          )}

          {/* Подкатегория не показывается у новой категории: подкатегорий у неё ещё нет. */}
          {categoryId !== NEW_CATEGORY && (
            <Field label="Подкатегория" hint="Необязательно. В отличие от названия, переиспользуется и суммируется.">
              <Select name="subcategoryId" value={subcategoryId} onChange={(e) => setSubcategoryId(e.target.value)}>
                <option value="">— без подкатегории —</option>
                {subcategories.map((sc) => (
                  <option key={sc.id} value={sc.id}>{sc.name}</option>
                ))}
                <option value={NEW_SUBCATEGORY}>+ Новая подкатегория…</option>
              </Select>
            </Field>
          )}

          {subcategoryId === NEW_SUBCATEGORY && (
            <Field label="Название подкатегории">
              <Input name="newSubcategoryName" placeholder="Например: OpenAI" required autoFocus />
            </Field>
          )}

          <Field label="Название" hint="Необязательно. «Подписка OpenAI», «Домен floremart.com».">
            <Input name="title" defaultValue={edit?.title ?? ""} placeholder="—" />
          </Field>

          <Field
            label="Сумма, $"
            hint={
              kind === "MONTHLY"
                ? "Сумма за месяц — по дням разойдётся сама."
                : kind === "RANGE"
                  ? "Сумма за весь срок — по дням разойдётся сама."
                  : kind === "DAILY"
                    ? "Сумма за один день."
                    : undefined
            }
          >
            <Input
              name="amount"
              inputMode="decimal"
              placeholder="0.00"
              defaultValue={edit ? (edit.amountCents / 100).toFixed(2) : ""}
              required
              autoFocus={!edit}
            />
          </Field>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>{pending ? "Сохраняю…" : "Сохранить"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteExpenseDialog({
  actions,
  id,
  label,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  actions: ExpenseActions;
  id: string;
  label: string;
  /** Иконка вместо слова «Удалить». Пусто — диалогом управляют снаружи. */
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (v: boolean) => void;
}) {
  const [openInner, setOpenInner] = useState(false);
  const controlled = openProp != null;
  const open = controlled ? openProp : openInner;
  const setOpen = (v: boolean) => (controlled ? onOpenChange?.(v) : setOpenInner(v));
  const [pending, start] = useTransition();

  const submit = (fd: FormData) =>
    start(async () => {
      const res = await actions.remove(fd);
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(res.message ?? "Удалено");
      setOpen(false);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger !== undefined && (
        <DialogTrigger asChild>
          <Button
            variant="ghost"
            size="iconSm"
            className="text-slate-400 hover:bg-red-50 hover:text-red-600"
            aria-label="Удалить расход"
            title="Удалить"
          >
            {trigger}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить расход?</DialogTitle>
        </DialogHeader>
        <form action={submit} className="space-y-3">
          <input type="hidden" name="id" value={id} />
          <p className="text-sm text-slate-600">
            «{label}» исчезнет из всех дней, по которым был размазан. Отменить удаление нельзя.
          </p>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Отмена
            </Button>
            <Button type="submit" variant="destructive" disabled={pending}>
              {pending ? "Удаляю…" : "Удалить"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
