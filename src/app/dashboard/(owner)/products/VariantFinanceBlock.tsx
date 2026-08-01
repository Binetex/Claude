"use client";
/**
 * Финансовая классификация ВАРИАНТА: эффективный тип с источником, признак вазы и закупочная
 * стоимость. Четыре состояния различаются явно: наследуется / переопределено true /
 * переопределено false / не настроено нигде.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { FinancialItemType } from "@/generated/prisma/enums";
import { FINANCIAL_TYPE_ORDER, FINANCIAL_TYPE_LABELS, financialTypeLabel, sourceLabel } from "@/modules/catalog/finance/display";
import { ownerSetVariantFinance } from "@/app/dashboard/(owner)/actions";
import { VaseCostEditor, type VaseCostRowVM } from "./VaseCostEditor";

export type VariantFinanceVM = {
  variantId: string;
  productId: string;
  ownType: FinancialItemType | null; // собственное значение варианта (null = наследует)
  ownIncludesVase: boolean | null;
  effectiveType: FinancialItemType | null;
  typeSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  effectiveIncludesVase: boolean | null;
  includesVaseSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  productTypeLabel: string; // что даёт товар — показываем в подписи «наследовать»
  productIncludesVaseLabel: string;
  effectiveCostCents: number | null;
  costSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  costHistory: VaseCostRowVM[];
};

const INHERIT = "__inherit__";

export function VariantFinanceBlock({ vm }: { vm: VariantFinanceVM }) {
  const [pending, start] = useTransition();

  const [type, setType] = useState<string>(vm.ownType ?? INHERIT);
  const [vase, setVase] = useState<string>(vm.ownIncludesVase == null ? INHERIT : String(vm.ownIncludesVase));

  // Эффективный тип для показа полей: пока не сохранено — по выбранному значению.
  const shownType: FinancialItemType | null = type === INHERIT ? (vm.typeSource === "PRODUCT" ? vm.effectiveType : null) : (type as FinancialItemType);
  const shownVase: boolean | null =
    vase === INHERIT ? (vm.includesVaseSource === "PRODUCT" ? vm.effectiveIncludesVase : null) : vase === "true";

  function save(patch: { financialType?: FinancialItemType | null; includesVase?: boolean | null }) {
    start(async () => {
      await ownerSetVariantFinance(vm.variantId, patch);
      toast.success("Классификация сохранена");
    });
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between">
        <Label>Финансовая классификация</Label>
        {(vm.ownType != null || vm.ownIncludesVase != null) && (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setType(INHERIT);
              setVase(INHERIT);
              save({ financialType: null, includesVase: null });
            }}
          >
            Вернуть наследование
          </Button>
        )}
      </div>

      <div>
        <span className="text-xs text-slate-500">Тип позиции</span>
        <Select
          value={type}
          disabled={pending}
          onChange={(e) => {
            setType(e.target.value);
            save({ financialType: e.target.value === INHERIT ? null : (e.target.value as FinancialItemType) });
          }}
          wrapperClassName="mt-1"
        >
          <option value={INHERIT}>Наследовать от товара — {vm.productTypeLabel}</option>
          {FINANCIAL_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {FINANCIAL_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
        <p className="mt-1 text-[11px] text-slate-400">
          Сейчас: {financialTypeLabel(vm.effectiveType)} · {sourceLabel(vm.typeSource)}
        </p>
      </div>

      {/* Для вазы признак «содержит вазу» бессмысленен — позиция и есть ваза. */}
      {shownType === "FLOWER_PRODUCT" && (
        <div>
          <span className="text-xs text-slate-500">Содержит вазу</span>
          <Select
            value={vase}
            disabled={pending}
            onChange={(e) => {
              setVase(e.target.value);
              save({ includesVase: e.target.value === INHERIT ? null : e.target.value === "true" });
            }}
            wrapperClassName="mt-1"
          >
            <option value={INHERIT}>Наследовать от товара — {vm.productIncludesVaseLabel}</option>
            <option value="true">Да, ваза входит в букет</option>
            <option value="false">Нет, без вазы</option>
          </Select>
          <p className="mt-1 text-[11px] text-slate-400">
            Сейчас:{" "}
            {vm.effectiveIncludesVase === true
              ? "содержит вазу"
              : vm.effectiveIncludesVase === false
                ? "без вазы (подтверждено)"
                : "не настроено"}{" "}
            · {sourceLabel(vm.includesVaseSource)}
          </p>
        </div>
      )}

      {shownType === "VASE" && (
        <VaseCostEditor
          target={{ productVariantId: vm.variantId }}
          costType="STANDALONE_VASE"
          title="Закупочная стоимость вазы"
          history={vm.costHistory.filter((h) => h.level === "VARIANT" || h.level === "PRODUCT")}
          effectiveCostCents={vm.effectiveCostCents}
          effectiveSource={vm.costSource}
        />
      )}

      {shownType === "FLOWER_PRODUCT" && shownVase === true && (
        <VaseCostEditor
          target={{ productVariantId: vm.variantId }}
          costType="INCLUDED_VASE"
          title="Закупочная стоимость включённой вазы"
          history={vm.costHistory}
          effectiveCostCents={vm.effectiveCostCents}
          effectiveSource={vm.costSource}
        />
      )}

      {shownType === "FLOWER_PRODUCT" && shownVase === null && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
          Не настроено: неизвестно, входит ли ваза. Это не то же самое, что «вазы нет» — пока признак не задан,
          заказ будет помечен как требующий проверки.
        </p>
      )}
    </div>
  );
}
