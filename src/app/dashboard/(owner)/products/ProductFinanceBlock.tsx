"use client";
/** Финансовые значения по умолчанию на уровне ТОВАРА. Вариант может их переопределить. */
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import type { FinancialItemType } from "@/generated/prisma/enums";
import { FINANCIAL_TYPE_ORDER, FINANCIAL_TYPE_LABELS } from "@/modules/catalog/finance/display";
import { ownerSetProductFinance } from "@/app/dashboard/(owner)/actions";
import { VaseCostEditor, type VaseCostRowVM } from "./VaseCostEditor";

const NOT_SET = "__none__";

export function ProductFinanceBlock({
  productId,
  financialType,
  defaultIncludesVase,
  costHistory,
  effectiveCostCents,
}: {
  productId: string;
  financialType: FinancialItemType | null;
  defaultIncludesVase: boolean | null;
  costHistory: VaseCostRowVM[];
  effectiveCostCents: number | null;
}) {
  const [pending, start] = useTransition();
  const [type, setType] = useState<string>(financialType ?? NOT_SET);
  const [vase, setVase] = useState<string>(defaultIncludesVase == null ? NOT_SET : String(defaultIncludesVase));

  function save(patch: { financialType?: FinancialItemType | null; defaultIncludesVase?: boolean | null }) {
    start(async () => {
      await ownerSetProductFinance(productId, patch);
      toast.success("Сохранено");
    });
  }

  const shownType = type === NOT_SET ? null : (type as FinancialItemType);

  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Значения по умолчанию для всех вариантов товара. Любой вариант может переопределить их у себя.
      </p>

      <div>
        <Label>Тип позиции</Label>
        <Select
          value={type}
          disabled={pending}
          onChange={(e) => {
            setType(e.target.value);
            save({ financialType: e.target.value === NOT_SET ? null : (e.target.value as FinancialItemType) });
          }}
          wrapperClassName="mt-1"
        >
          <option value={NOT_SET}>Не задан</option>
          {FINANCIAL_TYPE_ORDER.map((t) => (
            <option key={t} value={t}>
              {FINANCIAL_TYPE_LABELS[t]}
            </option>
          ))}
        </Select>
      </div>

      {shownType === "FLOWER_PRODUCT" && (
        <div>
          <Label>Содержит вазу по умолчанию</Label>
          <Select
            value={vase}
            disabled={pending}
            onChange={(e) => {
              setVase(e.target.value);
              save({ defaultIncludesVase: e.target.value === NOT_SET ? null : e.target.value === "true" });
            }}
            wrapperClassName="mt-1"
          >
            <option value={NOT_SET}>Не задано</option>
            <option value="true">Да, ваза входит в букет</option>
            <option value="false">Нет, без вазы</option>
          </Select>
        </div>
      )}

      {shownType === "FLOWER_PRODUCT" && vase === "true" && (
        <VaseCostEditor
          target={{ productId }}
          costType="INCLUDED_VASE"
          title="Закупочная стоимость включённой вазы (по умолчанию)"
          history={costHistory}
          effectiveCostCents={effectiveCostCents}
          effectiveSource={effectiveCostCents == null ? "UNKNOWN" : "PRODUCT"}
        />
      )}

      {shownType === "VASE" && (
        <VaseCostEditor
          target={{ productId }}
          costType="STANDALONE_VASE"
          title="Закупочная стоимость вазы (по умолчанию)"
          history={costHistory}
          effectiveCostCents={effectiveCostCents}
          effectiveSource={effectiveCostCents == null ? "UNKNOWN" : "PRODUCT"}
        />
      )}
    </div>
  );
}
