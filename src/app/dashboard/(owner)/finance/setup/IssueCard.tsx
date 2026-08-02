"use client";
/**
 * Карточка проблемы. Одна форма на все семь сценариев: отличаются только поля быстрого
 * ввода и действие. Общее для всех — предпросмотр ДО записи и одна кнопка «Исправить
 * и пересчитать»; молча ничего не применяется.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatCents } from "@/lib/cents";
import { cn } from "@/lib/cn";
import {
  applyConsumablesRate,
  applyDailyFlowerExpense,
  applyDeliveryCost,
  applyFeeModel,
  applyOwnerTaxPolicy,
  applyVaseLink,
  applyVasePurchaseCost,
  dismissFinanceIssue,
  previewFix,
  type SetupResult,
} from "./setupActions";
import type { DayPreview } from "@/modules/finance/preview";
import type { FinanceIssueSeverity, FinanceIssueType } from "@/generated/prisma/enums";

export type IssueCardData = {
  id: string;
  type: FinanceIssueType;
  severity: FinanceIssueSeverity;
  scopeDate: string | null;
  siteId: string | null;
  siteShortName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  sourceEntityId: string;
  detail: Record<string, unknown> | null;
  suggested: Record<string, unknown> | null;
  estimatedImpactCents: number | null;
  /** Подсказка из внешних данных: стоимость Burq либо средняя закупка за неделю. */
  suggestion: { deliveryCents?: number; deliverySource?: string; dailyExpenseCents?: number } | null;
  /** Варианты ваз того же магазина — только предложение, выбор делает владелец. */
  vaseOptions: { id: string; label: string; costCents: number | null }[];
};

const severityMeta: Record<FinanceIssueSeverity, { label: string; className: string; dot: string }> = {
  BLOCKING: { label: "Блокирует", className: "border-red-200 bg-red-50 text-red-700", dot: "bg-red-500" },
  WARNING: { label: "Предупреждение", className: "border-amber-200 bg-amber-50 text-amber-800", dot: "bg-amber-500" },
  INFO: { label: "К сведению", className: "border-slate-200 bg-slate-50 text-slate-600", dot: "bg-slate-400" },
};

const titles: Record<FinanceIssueType, string> = {
  DELIVERY_ACTUAL_COST_MISSING: "Нет фактической доставки",
  ACQUIRING_FEE_MODEL_MISSING: "Нет модели комиссии магазина",
  DAILY_FLOWER_EXPENSE_MISSING: "Нет дневной закупки цветов",
  VASE_COST_MISSING: "Нет закупочной стоимости вазы",
  GIFT_COST_MISSING: "Нет закупочной стоимости подарка",
  VASE_LINK_MISSING: "Ваза не привязана к букету",
  CONSUMABLES_RATE_MISSING: "Не задана ставка расходников",
  OWNER_TAX_POLICY_MISSING: "Нет налоговой политики",
  FLOWER_REVENUE_UNDETERMINED: "Цветочную выручку дня определить нельзя",
};

const usd = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <div className="text-[11px] text-slate-400">{hint}</div>}
    </div>
  );
}

function PreviewBlock({ preview }: { preview: DayPreview }) {
  const delta = preview.distributableAfterCents - preview.distributableBeforeCents;
  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/70 p-3 text-xs">
      <div className="mb-2 font-medium text-slate-700">Что изменится за {preview.day}</div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-3">
        <div>
          <div className="text-slate-400">Заказов в расчёте</div>
          <div className="tabular-nums text-slate-800">
            {preview.calculableBefore} → <span className="font-semibold">{preview.calculableAfter}</span> из {preview.ordersTotal}
          </div>
        </div>
        <div>
          <div className="text-slate-400">Закупка распределена</div>
          <div className="tabular-nums text-slate-800">
            {formatCents(preview.allocatedBeforeCents)} → <span className="font-semibold">{formatCents(preview.allocatedAfterCents)}</span>
          </div>
        </div>
        <div>
          <div className="text-slate-400">Осталось нераспределённым</div>
          <div className={cn("tabular-nums", preview.unallocatedAfterCents > 0 ? "text-amber-700" : "text-emerald-700")}>
            {formatCents(preview.unallocatedAfterCents)}
          </div>
        </div>
        <div className="col-span-2 sm:col-span-3 border-t border-slate-200 pt-1.5">
          <div className="text-slate-400">Распределяемая прибыль дня</div>
          <div className="tabular-nums text-slate-800">
            {formatCents(preview.distributableBeforeCents)} → <span className="font-semibold">{formatCents(preview.distributableAfterCents)}</span>
            {delta !== 0 && (
              <span className={cn("ml-2", delta > 0 ? "text-emerald-700" : "text-red-600")}>
                {delta > 0 ? "+" : "−"}
                {formatCents(Math.abs(delta))}
              </span>
            )}
          </div>
          {preview.shareAfterCents == null && (
            <div className="mt-1 text-[11px] text-slate-400">
              Доля основного флориста не рассчитывается на этом этапе — процент задаётся следующим.
            </div>
          )}
        </div>
      </div>

      {preview.lines.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-slate-500">Распределение по заказам</summary>
          <table className="mt-1.5 w-full">
            <tbody>
              {preview.lines.map((l) => (
                <tr key={l.orderId} className={cn(!l.calculableAfter && "text-slate-400")}>
                  <td className="py-0.5 pr-2">{l.orderNumber}</td>
                  <td className="py-0.5 pr-2 text-slate-400">{l.siteShortName}</td>
                  <td className="py-0.5 pr-2 text-right tabular-nums">цветы {formatCents(l.flowerRevenueCents)}</td>
                  <td className="py-0.5 text-right tabular-nums">→ {formatCents(l.allocatedAfterCents)}</td>
                  {!l.calculableAfter && <td className="py-0.5 pl-2 text-amber-700">не в расчёте</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  );
}

export function IssueCard({ issue }: { issue: IssueCardData }) {
  const [preview, setPreview] = useState<DayPreview | null>(null);
  const [previewing, startPreview] = useTransition();
  const [saving, startSave] = useTransition();
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(issue));

  const meta = severityMeta[issue.severity];
  const detail = issue.detail ?? {};
  const set = (k: string, v: string) => setValues((s) => ({ ...s, [k]: v }));

  function runPreview() {
    if (!issue.scopeDate) {
      toast.error("У этой проблемы нет дня — предпросмотр не применим.");
      return;
    }
    startPreview(async () => {
      const res = await previewFix({
        day: issue.scopeDate!,
        dailyExpenseUsd: issue.type === "DAILY_FLOWER_EXPENSE_MISSING" ? values.amount : undefined,
        orderId: issue.orderId ?? undefined,
        deliveryUsd: issue.type === "DELIVERY_ACTUAL_COST_MISSING" ? values.amount : undefined,
        siteId: issue.siteId ?? undefined,
        feePercent: issue.type === "ACQUIRING_FEE_MODEL_MISSING" ? values.percent : undefined,
        feeFixedUsd: issue.type === "ACQUIRING_FEE_MODEL_MISSING" ? values.fixed : undefined,
        consumablesUsd: issue.type === "CONSUMABLES_RATE_MISSING" ? values.amount : undefined,
        vaseGiftUsd: issue.type === "VASE_COST_MISSING" || issue.type === "GIFT_COST_MISSING" ? values.amount : undefined,
      });
      if ("error" in res) {
        toast.error(res.error);
        return;
      }
      setPreview(res.preview);
    });
  }

  function submit(action: (fd: FormData) => Promise<SetupResult>) {
    return (formData: FormData) =>
      startSave(async () => {
        const res = await action(formData);
        if (res.error) {
          toast.error(res.error);
          return;
        }
        toast.success(res.message ?? "Готово");
        setPreview(null);
      });
  }

  const { action, fields, why } = scenario(issue, values, set);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={cn("size-2 rounded-full", meta.dot)} />
          <span className="font-medium text-slate-800">{titles[issue.type]}</span>
          <Badge className={meta.className}>{meta.label}</Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          {issue.siteShortName && <span>{issue.siteShortName}</span>}
          {issue.scopeDate && <span className="tabular-nums">{issue.scopeDate}</span>}
          {issue.orderId && issue.orderNumber && (
            <Link href={`/dashboard/orders/${issue.orderId}`} className="text-blue-600 hover:underline">
              {issue.orderNumber}
            </Link>
          )}
        </div>
      </div>

      {why && <p className="mt-2 text-sm text-slate-600">{why}</p>}
      {typeof detail.reason === "string" && detail.reason !== why && (
        <p className="mt-1 text-xs text-slate-400">{detail.reason}</p>
      )}

      <form action={submit(action)} className="mt-3 space-y-3">
        <input type="hidden" name="issueId" value={issue.id} />
        {fields}

        <Field label="Комментарий (необязательно)">
          <Textarea name="comment" rows={1} className="text-sm" />
        </Field>

        {preview && <PreviewBlock preview={preview} />}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <DismissButton issueId={issue.id} />
          {issue.scopeDate && issue.type !== "VASE_LINK_MISSING" && issue.type !== "FLOWER_REVENUE_UNDETERMINED" && (
            <Button type="button" variant="outline" size="sm" onClick={runPreview} disabled={previewing}>
              {previewing ? "Считаю…" : "Посмотреть"}
            </Button>
          )}
          {issue.type !== "FLOWER_REVENUE_UNDETERMINED" && (
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? "Применяю…" : "Исправить и пересчитать"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function DismissButton({ issueId }: { issueId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  if (!open) {
    return (
      <Button type="button" variant="ghost" size="sm" className="text-slate-400" onClick={() => setOpen(true)}>
        Закрыть без исправления
      </Button>
    );
  }
  return (
    <span className="flex items-center gap-1.5">
      <Input name="dismissComment" id={`dismiss-${issueId}`} placeholder="Причина" className="h-8 w-48 text-xs" />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={pending}
        onClick={() => {
          const el = document.getElementById(`dismiss-${issueId}`) as HTMLInputElement | null;
          const fd = new FormData();
          fd.set("issueId", issueId);
          fd.set("comment", el?.value ?? "");
          start(async () => {
            const res = await dismissFinanceIssue(fd);
            if (res.error) toast.error(res.error);
            else {
              toast.success(res.message ?? "Закрыто");
              setOpen(false);
            }
          });
        }}
      >
        Подтвердить
      </Button>
    </span>
  );
}

function initialValues(issue: IssueCardData): Record<string, string> {
  const suggested = issue.suggested ?? {};
  switch (issue.type) {
    case "DELIVERY_ACTUAL_COST_MISSING":
      return { amount: usd(issue.suggestion?.deliveryCents) };
    case "DAILY_FLOWER_EXPENSE_MISSING":
      return { amount: usd(issue.suggestion?.dailyExpenseCents) };
    case "ACQUIRING_FEE_MODEL_MISSING":
      return {
        percent: typeof suggested.percentBp === "number" ? (suggested.percentBp / 100).toFixed(2) : "",
        fixed: typeof suggested.fixedCents === "number" ? usd(suggested.fixedCents) : "",
      };
    case "CONSUMABLES_RATE_MISSING":
      return { amount: typeof suggested.amountCents === "number" ? usd(suggested.amountCents) : "" };
    case "OWNER_TAX_POLICY_MISSING":
      return { percent: typeof suggested.actualShareBp === "number" ? (suggested.actualShareBp / 100).toFixed(2) : "" };
    default:
      return {};
  }
}

const today = () => new Date().toISOString().slice(0, 10);

/** Поля быстрого ввода и действие — то единственное, чем сценарии отличаются. */
function scenario(
  issue: IssueCardData,
  values: Record<string, string>,
  set: (k: string, v: string) => void
): { action: (fd: FormData) => Promise<SetupResult>; fields: React.ReactNode; why: string } {
  const detail = issue.detail ?? {};

  switch (issue.type) {
    case "DELIVERY_ACTUAL_COST_MISSING":
      return {
        action: applyDeliveryCost,
        why: "Без фактической доставки прибыль заказа завышена, поэтому заказ не участвует в расчёте.",
        fields: (
          <>
            <input type="hidden" name="orderId" value={issue.orderId ?? ""} />
            <Field
              label="Фактическая доставка, $"
              hint={
                issue.suggestion?.deliveryCents != null
                  ? `Предложено из ${issue.suggestion.deliverySource}: ${formatCents(issue.suggestion.deliveryCents)}. Ноль — валидное подтверждение (самовывоз).`
                  : "Данных курьера нет — введите сумму. Ноль тоже считается подтверждением."
              }
            >
              <Input name="amount" inputMode="decimal" value={values.amount ?? ""} onChange={(e) => set("amount", e.target.value)} required />
            </Field>
          </>
        ),
      };

    case "ACQUIRING_FEE_MODEL_MISSING":
      return {
        action: applyFeeModel,
        why: "У магазина нет ни фактической комиссии, ни модели расчёта. Комиссия по модели помечается как расчётная.",
        fields: (
          <>
            <input type="hidden" name="siteId" value={issue.siteId ?? ""} />
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Процент, %">
                <Input name="percent" inputMode="decimal" value={values.percent ?? ""} onChange={(e) => set("percent", e.target.value)} required />
              </Field>
              <Field label="Фиксированная часть, $">
                <Input name="fixed" inputMode="decimal" value={values.fixed ?? ""} onChange={(e) => set("fixed", e.target.value)} />
              </Field>
              <Field label="Действует с">
                <Input name="effectiveFrom" type="date" defaultValue={today()} />
              </Field>
            </div>
          </>
        ),
      };

    case "DAILY_FLOWER_EXPENSE_MISSING":
      return {
        action: applyDailyFlowerExpense,
        why: `Без закупки распределять нечего, поэтому не считается весь день${
          typeof detail.orderCount === "number" ? ` — ${detail.orderCount} заказ(ов)` : ""
        }${
          typeof detail.flowerRevenueCents === "number" ? `, цветочная выручка ${formatCents(detail.flowerRevenueCents)}` : ""
        }.`,
        fields: (
          <>
            <input type="hidden" name="day" value={issue.scopeDate ?? ""} />
            <Field
              label="Расходы на цветы за день, $"
              hint={
                issue.suggestion?.dailyExpenseCents != null
                  ? `Среднее за неделю: ${formatCents(issue.suggestion.dailyExpenseCents)}`
                  : undefined
              }
            >
              <Input name="amount" inputMode="decimal" value={values.amount ?? ""} onChange={(e) => set("amount", e.target.value)} required />
            </Field>
          </>
        ),
      };

    case "VASE_COST_MISSING":
    case "GIFT_COST_MISSING":
      return {
        action: applyVasePurchaseCost,
        why: `Закупочная стоимость позиции «${String(detail.itemName ?? "")}» неизвестна, поэтому заказ не участвует в расчёте.`,
        fields: (
          <>
            <input type="hidden" name="variantId" value={issue.sourceEntityId} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Закупочная стоимость, $">
                <Input name="amount" inputMode="decimal" value={values.amount ?? ""} onChange={(e) => set("amount", e.target.value)} required />
              </Field>
              <Field label="Действует с" hint="Стоимость применяется к заказам с этой даты.">
                <Input name="effectiveFrom" type="date" defaultValue={String(issue.scopeDate ?? today())} />
              </Field>
            </div>
          </>
        ),
      };

    case "VASE_LINK_MISSING":
      return {
        action: applyVaseLink,
        why: "Букет заявлен с вазой, но сама ваза не выбрана — её стоимость взять неоткуда.",
        fields: (
          <>
            <input type="hidden" name="variantId" value={issue.sourceEntityId} />
            <Field
              label="Ваза"
              hint="Список — предложение по магазину. Ничего не связывается автоматически: выбор за вами."
            >
              <select
                name="vaseVariantId"
                className="h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm shadow-xs"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Выберите вазу…
                </option>
                {issue.vaseOptions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                    {v.costCents != null ? ` — закупка ${formatCents(v.costCents)}` : " — стоимость не задана"}
                  </option>
                ))}
              </select>
            </Field>
          </>
        ),
      };

    case "CONSUMABLES_RATE_MISSING":
      return {
        action: applyConsumablesRate,
        why: "Ставка расходников не задана ни для магазина, ни глобально — расчёт не может её подставить сам.",
        fields: (
          <>
            <input type="hidden" name="siteId" value={issue.siteId ?? ""} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Ставка на заказ, $">
                <Input name="amount" inputMode="decimal" value={values.amount ?? ""} onChange={(e) => set("amount", e.target.value)} required />
              </Field>
              <Field label="Действует с">
                <Input name="effectiveFrom" type="date" defaultValue={today()} />
              </Field>
            </div>
          </>
        ),
      };

    case "OWNER_TAX_POLICY_MISSING":
      return {
        action: applyOwnerTaxPolicy,
        why: "Начисление флористу считается и без неё: в его базе налог вычитается на 100%. Политика влияет только на вашу картину прибыли.",
        fields: (
          <>
            <input type="hidden" name="siteId" value={issue.siteId ?? ""} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Field
                label="Реальный налоговый расход, %"
                hint={
                  typeof detail.collectedTaxCents === "number"
                    ? `Собрано налога: ${formatCents(detail.collectedTaxCents)}. Флорист видит 100% как расход в любом случае.`
                    : undefined
                }
              >
                <Input name="percent" inputMode="decimal" value={values.percent ?? ""} onChange={(e) => set("percent", e.target.value)} required />
              </Field>
              <Field label="Действует с">
                <Input name="effectiveFrom" type="date" defaultValue={today()} />
              </Field>
            </div>
          </>
        ),
      };

    case "FLOWER_REVENUE_UNDETERMINED":
      return {
        action: dismissFinanceIssue,
        why: "Быстрого исправления нет: позиции нужно разметить в каталоге, иначе знаменатель распределения дня недостоверен.",
        fields: (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
            {Array.isArray(detail.orders) && detail.orders.length > 0 ? (
              <>
                Заказы: {(detail.orders as string[]).join(", ")}.{" "}
                <Link href="/dashboard/products" className="text-blue-600 hover:underline">
                  Открыть каталог
                </Link>
              </>
            ) : (
              "Цветочная выручка дня равна нулю при заданной закупке — распределять не по чему."
            )}
          </div>
        ),
      };
  }
}
