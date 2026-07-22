"use client";
import { useState } from "react";
import Link from "next/link";
import { ZoomableImage } from "@/components/ImageLightbox";
import { Badge } from "@/components/ui/Badge";
import { InlinePrice } from "./InlinePrice";
import { ownerSetProductFloristPrice, ownerSetVariantFloristPrice } from "@/app/dashboard/(owner)/actions";
import type { ProductStatus } from "@/generated/prisma/enums";

export type VariantVM = {
  id: string;
  options: string;
  sku: string | null;
  listPriceLabel: string;
  floristPrice: number | null;
  available: boolean;
  remoteDeleted: boolean;
  adminUrl: string | null;
};

export type ProductVM = {
  id: string;
  name: string;
  image: string | null;
  siteName: string;
  siteColor: string;
  status: ProductStatus;
  remoteDeleted: boolean;
  sitePriceLabel: string;
  floristPrice: number | null; // null = не задана → полная стоимость
  adminUrl: string | null;
  variantCount: number;
  showVariants: boolean; // прятать раскрытие для одиночного "Default Title"
  compFilled: number;
  compTotal: number;
  variants: VariantVM[];
};

function StatusBadge({ status, remoteDeleted }: { status: ProductStatus; remoteDeleted: boolean }) {
  if (remoteDeleted) return <Badge className="border-red-200 bg-red-50 text-red-700">Удалён</Badge>;
  if (status === "DRAFT") return <Badge className="border-amber-200 bg-amber-50 text-amber-700">Черновик</Badge>;
  if (status === "ARCHIVED") return <Badge className="border-slate-200 bg-slate-100 text-slate-600">Архив</Badge>;
  return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Активен</Badge>;
}

function CompositionIndicator({ filled, total }: { filled: number; total: number }) {
  if (total === 0) return <span className="text-xs text-slate-400">—</span>;
  if (filled === total) return <span className="text-xs font-medium text-emerald-700">Все варианты заполнены</span>;
  if (filled === 0) return <span className="text-xs text-slate-400">Не заполнено</span>;
  return <span className="text-xs font-medium text-amber-700">Заполнено {filled} из {total}</span>;
}

export function ProductRow({ p }: { p: ProductVM }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className="border-b border-slate-50 align-top">
        <td className="px-3 py-2">
          {p.image ? (
            <ZoomableImage src={p.image} alt="" className="h-12 w-12 rounded object-cover" />
          ) : (
            <div className="flex h-12 w-12 items-center justify-center rounded bg-slate-100 text-slate-300">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <circle cx="9" cy="9" r="1.5" />
                <path d="m21 15-5-5L5 21" />
              </svg>
            </div>
          )}
        </td>
        <td className="px-3 py-2">
          <Link href={`/dashboard/products/${p.id}`} className="font-medium text-slate-800 hover:text-slate-950 hover:underline">
            {p.name}
          </Link>
        </td>
        <td className="px-3 py-2">
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-slate-600">
            <span className="h-2 w-2 rounded-full" style={{ background: p.siteColor }} />
            {p.siteName}
          </span>
        </td>
        <td className="px-3 py-2 text-center">
          {p.showVariants ? (
            <button onClick={() => setOpen((v) => !v)} className="text-xs text-sky-600 hover:text-sky-800">
              {open ? "▾" : "▸"} {p.variantCount}
            </button>
          ) : (
            <span className="text-xs text-slate-400">{p.variantCount}</span>
          )}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap font-medium text-slate-700">{p.sitePriceLabel}</td>
        <td className="px-3 py-2">
          <InlinePrice
            initial={p.floristPrice}
            allowEmpty
            placeholder="Full Price"
            onSave={(a) => ownerSetProductFloristPrice(p.id, a)}
          />
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          <CompositionIndicator filled={p.compFilled} total={p.compTotal} />
        </td>
        <td className="px-3 py-2">
          <StatusBadge status={p.status} remoteDeleted={p.remoteDeleted} />
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-col items-start gap-1">
            <Link href={`/dashboard/products/${p.id}`} className="text-xs text-sky-600 hover:text-sky-800">
              Редактировать
            </Link>
            {p.adminUrl && (
              <a href={p.adminUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-slate-500 hover:text-slate-800">
                Открыть товар ↗
              </a>
            )}
          </div>
        </td>
      </tr>

      {p.showVariants && open && (
        <tr className="border-b border-slate-100 bg-slate-50/50">
          <td colSpan={9} className="px-3 py-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-slate-400">
                  <th className="px-2 py-1">Вариант / Опции</th>
                  <th className="px-2 py-1">SKU</th>
                  <th className="px-2 py-1 text-right">Цена сайта</th>
                  <th className="px-2 py-1 text-right">Цена флориста</th>
                  <th className="px-2 py-1">Статус</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {p.variants.map((v) => (
                  <tr key={v.id} className="border-t border-slate-100">
                    <td className="px-2 py-1 text-slate-700">{v.options}</td>
                    <td className="px-2 py-1 text-slate-500">{v.sku ?? "—"}</td>
                    <td className="px-2 py-1 text-right text-slate-700">{v.listPriceLabel}</td>
                    <td className="px-2 py-1">
                      <InlinePrice
                        initial={v.floristPrice}
                        allowEmpty
                        placeholder="по товару"
                        onSave={(a) => ownerSetVariantFloristPrice(v.id, a)}
                      />
                    </td>
                    <td className="px-2 py-1">
                      {v.remoteDeleted ? (
                        <span className="text-red-600">удалён</span>
                      ) : v.available ? (
                        <span className="text-emerald-600">доступен</span>
                      ) : (
                        <span className="text-slate-400">нет в наличии</span>
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {v.adminUrl && (
                        <a href={v.adminUrl} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-slate-800">
                          Shopify ↗
                        </a>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
