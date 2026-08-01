"use client";
/**
 * Финансовая классификация ВАРИАНТА: эффективный тип с источником, ваза и её закупочная
 * стоимость. Стоимость у букета не редактируется — только выбор вазы; редактор стоимости
 * остаётся в карточке самой вазы.
 */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { FinancialItemType } from "@/generated/prisma/enums";
import { FINANCIAL_TYPE_ORDER, FINANCIAL_TYPE_LABELS, financialTypeLabel, sourceLabel } from "@/modules/catalog/finance/display";
import { ownerSetVariantFinance, ownerSetVariantVase } from "@/app/dashboard/(owner)/actions";
import { VaseCostEditor, type VaseCostRowVM } from "./VaseCostEditor";
import { VaseSelect, type VaseOption, type VaseSelectState } from "./VaseSelect";

export type VariantFinanceVM = {
  variantId: string;
  productId: string;
  ownType: FinancialItemType | null;
  effectiveType: FinancialItemType | null;
  typeSource: "VARIANT" | "PRODUCT" | "UNKNOWN";
  productTypeLabel: string;
  /** Состояние вазы для селектора (собственное + эффективное). */
  vase: VaseSelectState;
  /** Своя стоимость — только когда сам вариант является вазой. */
  ownCostCents: number | null;
  ownCostHistory: VaseCostRowVM[];
};

const INHERIT = "__inherit__";

export function VariantFinanceBlock({ vm, vaseOptions }: { vm: VariantFinanceVM; vaseOptions: VaseOption[] }) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<string>(vm.ownType ?? INHERIT);

  const shownType: FinancialItemType | null =
    type === INHERIT ? (vm.typeSource === "PRODUCT" ? vm.effectiveType : null) : (type as FinancialItemType);

  function saveType(next: string) {
    setType(next);
    start(async () => {
      await ownerSetVariantFinance(vm.variantId, {
        financialType: next === INHERIT ? null : (next as FinancialItemType),
      });
      toast.success("Классификация сохранена");
    });
  }

  return (
    <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-3">
      <div className="flex items-center justify-between">
        <Label>Финансовая классификация</Label>
        {vm.ownType != null && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => saveType(INHERIT)}>
            Вернуть наследование типа
          </Button>
        )}
      </div>

      <div>
        <span className="text-xs text-slate-500">Тип позиции</span>
        <Select value={type} disabled={pending} onChange={(e) => saveType(e.target.value)} wrapperClassName="mt-1">
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

      {/* Букет: только выбор вазы. Стоимость правится у самой вазы. */}
      {shownType === "FLOWER_PRODUCT" && (
        <VaseSelect
          level="VARIANT"
          state={vm.vase}
          options={vaseOptions}
          onSave={(selection) => ownerSetVariantVase(vm.variantId, selection)}
        />
      )}

      {/* Сама ваза: единственное место, где задаётся закупочная стоимость. */}
      {shownType === "VASE" && (
        <VaseCostEditor
          target={{ productVariantId: vm.variantId }}
          costType="STANDALONE_VASE"
          title="Закупочная стоимость вазы"
          history={vm.ownCostHistory}
          effectiveCostCents={vm.ownCostCents}
          effectiveSource={vm.ownCostCents == null ? "UNKNOWN" : "VARIANT"}
        />
      )}
    </div>
  );
}
