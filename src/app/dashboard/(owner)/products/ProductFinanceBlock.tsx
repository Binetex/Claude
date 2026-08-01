"use client";
/** Финансовые значения по умолчанию на уровне ТОВАРА. Вариант может их переопределить. */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { FinancialItemType } from "@/generated/prisma/enums";
import { CATALOG_TYPE_ORDER, FINANCIAL_TYPE_LABELS, DEFAULT_TYPE_LABEL, purchaseCostTitle } from "@/modules/catalog/finance/display";
import { ownerSetProductFinance, ownerSetProductDefaultVase } from "@/app/dashboard/(owner)/actions";
import { formatCents } from "@/lib/cents";
import { VaseCostEditor, type VaseCostRowVM } from "./VaseCostEditor";
import { VaseSelect, type VaseOption, type VaseSelectState } from "./VaseSelect";

const NOT_SET = "__none__";

export function ProductFinanceBlock({
  productId,
  financialType,
  vase,
  vaseOptions,
  costHistory,
  effectiveCostCents,
  usedInBouquets,
  variantOwnCosts,
}: {
  productId: string;
  financialType: FinancialItemType | null;
  vase: VaseSelectState;
  vaseOptions: VaseOption[];
  costHistory: VaseCostRowVM[];
  effectiveCostCents: number | null;
  /** Сколько букетов ссылается на эту вазу — показываем на карточке вазы. */
  usedInBouquets: number;
  /** Стоимости, заданные на вариантах этой вазы: они приоритетнее товарной. */
  variantOwnCosts: { title: string; cents: number }[];
}) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<string>(financialType ?? NOT_SET);

  function saveType(next: string) {
    setType(next);
    start(async () => {
      await ownerSetProductFinance(productId, { financialType: next === NOT_SET ? null : (next as FinancialItemType) });
      toast.success("Сохранено");
    });
  }

  // Не выбрано — значит обычный букет: пустого типа не существует.
  const shownType: FinancialItemType = type === NOT_SET ? "FLOWER_PRODUCT" : (type as FinancialItemType);
  const typeOptions =
    financialType && !CATALOG_TYPE_ORDER.includes(financialType)
      ? [...CATALOG_TYPE_ORDER, financialType]
      : CATALOG_TYPE_ORDER;

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Ничего настраивать не нужно: по умолчанию это обычный букет. Меняйте только исключения —
        вазы, подарки, открытки, сервисные позиции. Значения действуют на все варианты товара,
        любой вариант может переопределить их у себя.
      </p>

      <div>
        <Label>Тип позиции</Label>
        <Select value={type} disabled={pending} onChange={(e) => saveType(e.target.value)} wrapperClassName="mt-1">
          <option value={NOT_SET}>{DEFAULT_TYPE_LABEL}</option>
          {typeOptions.map((t) => (
            <option key={t} value={t}>
              {FINANCIAL_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>

      {shownType === "FLOWER_PRODUCT" && (
        <VaseSelect
          level="PRODUCT"
          state={vase}
          options={vaseOptions}
          onSave={(selection) => ownerSetProductDefaultVase(productId, selection)}
        />
      )}

      {shownType !== "FLOWER_PRODUCT" && (
        <>
          <VaseCostEditor
            target={{ productId }}
            costType="STANDALONE_VASE"
            title={purchaseCostTitle(shownType)}
            history={costHistory}
            effectiveCostCents={effectiveCostCents}
            effectiveSource={effectiveCostCents == null ? "UNKNOWN" : "PRODUCT"}
            productId={productId}
          />
          {variantOwnCosts.length > 0 && (
            <p className="text-[11px] text-slate-500">
              Задано на вариантах (приоритетнее товарной):{" "}
              {variantOwnCosts.map((v) => `${v.title} — ${formatCents(v.cents)}`).join(" · ")}
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            {shownType !== "VASE"
              ? "Закупочная себестоимость позиции: она вычитается из прибыли, когда позиция попадает в заказ."
              : usedInBouquets > 0
                ? `Используется в букетах: ${usedInBouquets}. Изменение закупочной стоимости повлияет на все будущие расчёты по ним.`
                : "Пока не привязана ни к одному букету."}
          </p>
        </>
      )}
    </div>
  );
}
