"use client";
/**
 * Выбор вазы для букета. Закупочную стоимость здесь НЕ правят — она живёт в карточке самой
 * вазы; тут показывается только текущее значение, для чтения, со ссылкой на вазу.
 *
 * Три состояния хранятся согласованно (сервис пишет их атомарно):
 *   наследовать · без вазы · конкретная ваза.
 */
import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { formatCents } from "@/lib/cents";

export type VaseOption = { id: string; label: string; productId: string; costCents: number | null };

export type VaseSelectState = {
  /** Собственное состояние сущности: null = наследовать (для товара — «не настроено»). */
  ownIncludesVase: boolean | null;
  ownVaseVariantId: string | null;
  /** Эффективные значения после наследования — для подписи «сейчас». */
  effectiveVaseLabel: string | null;
  effectiveVaseCostCents: number | null;
  effectiveVaseProductId: string | null;
  effectiveVaseArchived: boolean;
  effectiveSource: "VARIANT" | "PRODUCT" | "DEFAULT";
  /** Что даёт товар — показываем в пункте «Наследовать». Только для варианта. */
  productHint?: string;
};

const INHERIT = "__inherit__";
const NO_VASE = "__no_vase__";

export function VaseSelect({
  level,
  state,
  options,
  onSave,
  disabledReason,
}: {
  level: "VARIANT" | "PRODUCT";
  state: VaseSelectState;
  options: VaseOption[];
  /** Почему выбор недоступен. Блок при этом всё равно виден — иначе его невозможно найти. */
  disabledReason?: string;
  onSave: (selection: { mode: "INHERIT" } | { mode: "NO_VASE" } | { mode: "LINKED_VASE"; vaseVariantId: string }) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [pending, start] = useTransition();
  const current =
    state.ownVaseVariantId != null ? state.ownVaseVariantId : state.ownIncludesVase === false ? NO_VASE : INHERIT;
  const [value, setValue] = useState<string>(current);

  function apply(next: string) {
    setValue(next);
    const selection =
      next === INHERIT
        ? ({ mode: "INHERIT" } as const)
        : next === NO_VASE
          ? ({ mode: "NO_VASE" } as const)
          : ({ mode: "LINKED_VASE", vaseVariantId: next } as const);
    start(async () => {
      const res = await onSave(selection);
      if (!res.ok) {
        toast.error(res.error);
        setValue(current);
        return;
      }
      toast.success("Сохранено");
    });
  }

  const inheritLabel =
    level === "VARIANT" ? `Как у товара — ${state.productHint ?? "без вазы"}` : "Без вазы (по умолчанию)";

  return (
    <div>
      <Label>{level === "VARIANT" ? "Ваза в букете" : "Ваза по умолчанию"}</Label>
      <Select value={value} disabled={pending || !!disabledReason} onChange={(e) => apply(e.target.value)} wrapperClassName="mt-1">
        <option value={INHERIT}>{inheritLabel}</option>
        {/* У товара «не настроено» и «без вазы» дают одно и то же — второй пункт был бы
            дублем. У варианта разница есть: наследовать вазу товара либо снять её здесь. */}
        {level === "VARIANT" && <option value={NO_VASE}>Без вазы</option>}
        {/* Текущая ссылка может указывать на вазу, которой уже нет в списке доступных
            (архивирована). Её нужно показать в самом селекторе, иначе он врёт: выглядит как
            «наследовать», хотя у варианта своя ссылка. Выбрать её заново нельзя. */}
        {state.ownVaseVariantId && !options.some((o) => o.id === state.ownVaseVariantId) && (
          <option value={state.ownVaseVariantId} disabled>
            {state.effectiveVaseLabel ?? "Выбранная ваза"} — недоступна для выбора
          </option>
        )}
        {options.length > 0 && (
          <optgroup label="Вазы магазина">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
                {o.costCents != null ? ` — закуп ${formatCents(o.costCents)}` : " — закуп не указан"}
              </option>
            ))}
          </optgroup>
        )}
      </Select>

      {disabledReason && <p className="mt-1 text-[11px] text-slate-500">{disabledReason}</p>}

      {!disabledReason && options.length === 0 && (
        <p className="mt-1 text-[11px] text-amber-600">
          В этом магазине ещё нет позиций с типом «Ваза» — сначала пометьте вазу как вазу в её карточке.
        </p>
      )}

      {/* Что реально применится в расчёте, после наследования */}
      {disabledReason ? null : state.effectiveVaseLabel ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-500">
          <span>
            Сейчас: {state.effectiveVaseLabel} · закуп{" "}
            <span className="font-medium text-slate-700">{formatCents(state.effectiveVaseCostCents)}</span>
            {state.effectiveVaseCostCents == null && <span className="text-amber-600"> (не указан у вазы)</span>}
            {state.effectiveSource === "PRODUCT" && level === "VARIANT" && " · унаследована от товара"}
          </span>
          {state.effectiveVaseProductId && (
            <Link href={`/dashboard/products/${state.effectiveVaseProductId}`} className="text-sky-600 hover:underline">
              Открыть вазу ↗
            </Link>
          )}
          {state.effectiveVaseArchived && <span className="text-red-600">Ваза архивирована — выберите замену</span>}
        </p>
      ) : state.ownIncludesVase === true ? (
        <p className="mt-1 text-[11px] text-amber-600">Ваза заявлена, но не выбрана — заказ уйдёт в «требует проверки».</p>
      ) : (
        <p className="mt-1 text-[11px] text-slate-500">Сейчас: без вазы</p>
      )}
    </div>
  );
}
