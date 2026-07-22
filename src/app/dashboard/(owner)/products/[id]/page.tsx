import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/button";
import { ZoomableImage } from "@/components/ImageLightbox";
import { formatMoney, toNumber } from "@/lib/money";
import { fmtDateTime } from "@/lib/format";
import type { ProductStatus } from "@/generated/prisma/enums";
import { ProductFloristPriceInput } from "../PriceInputs";
import { VariantEditDialog } from "../VariantEditDialog";

export const dynamic = "force-dynamic";

function statusBadge(status: ProductStatus, remoteDeleted: boolean) {
  if (remoteDeleted) return <Badge className="border-red-200 bg-red-50 text-red-700">Удалён из Shopify</Badge>;
  if (status === "DRAFT") return <Badge className="border-amber-200 bg-amber-50 text-amber-700">Черновик</Badge>;
  if (status === "ARCHIVED") return <Badge className="border-slate-200 bg-slate-100 text-slate-600">Архив</Badge>;
  return <Badge className="border-emerald-200 bg-emerald-50 text-emerald-700">Активен</Badge>;
}

function variantOptions(v: { option1: string | null; option2: string | null; option3: string | null; title: string }): string {
  const opts = [v.option1, v.option2, v.option3].filter((o): o is string => !!o && o !== "Default Title");
  return opts.length ? opts.join(" / ") : v.title;
}

function truncate(s: string, n = 60): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

export default async function ProductDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      site: { select: { name: true, shortName: true, colorTag: true, platform: true } },
      variants: { orderBy: [{ remoteDeleted: "asc" }, { position: "asc" }, { title: "asc" }] },
    },
  });
  if (!product) notFound();

  const priceMin = product.minPrice != null ? toNumber(product.minPrice) : null;
  const priceMax = product.maxPrice != null ? toNumber(product.maxPrice) : null;
  const priceLabel =
    priceMin == null
      ? "—"
      : priceMin === (priceMax ?? priceMin)
        ? formatMoney(priceMin)
        : `${formatMoney(priceMin)}–${formatMoney(priceMax)}`;

  return (
    <div className="space-y-4">
      <Link href="/dashboard/products" className="text-sm text-slate-500 hover:underline">← Товары</Link>

      {/* Сводка: фото + свойства */}
      <Card>
        <CardBody className="flex flex-col gap-5 sm:flex-row">
          {product.image ? (
            <ZoomableImage src={product.image} alt="" className="h-28 w-28 shrink-0 rounded-lg object-cover" />
          ) : (
            <div className="flex h-28 w-28 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-xs text-slate-300">
              нет фото
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-semibold text-slate-900">{product.name}</h1>
              {statusBadge(product.status, product.remoteDeleted)}
            </div>
            <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-3">
              <Field label="Магазин">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full" style={{ background: product.site.colorTag }} />
                  {product.site.name}
                </span>
              </Field>
              <Field label="Тип товара">{product.productType || "—"}</Field>
              <Field label="Цена сайта">{priceLabel}</Field>
              <Field label="Цена флориста (базовая)">
                <ProductFloristPriceInput
                  productId={product.id}
                  initial={product.floristPrice != null ? toNumber(product.floristPrice) : null}
                />
              </Field>
              <Field label="Синхронизация">{product.lastSyncedAt ? fmtDateTime(product.lastSyncedAt) : "—"}</Field>
            </div>
            {(() => {
              // У Woo adminUrl исторически хранит permalink витрины, отдельной админ-ссылки нет.
              // У Shopify adminUrl — админка, витрина живёт в onlineUrl (нужен handle товара).
              const isShopify = product.site.platform === "SHOPIFY";
              const online = product.onlineUrl ?? (isShopify ? null : product.adminUrl);
              const admin = isShopify ? product.adminUrl : null;
              if (!online && !admin) return null;
              return (
                <div className="mt-4 flex flex-wrap gap-2">
                  {online && (
                    <Button asChild variant="outline" size="sm">
                      <a href={online} target="_blank" rel="noopener noreferrer">Открыть на сайте ↗</a>
                    </Button>
                  )}
                  {admin && (
                    <Button asChild variant="outline" size="sm">
                      <a href={admin} target="_blank" rel="noopener noreferrer">Открыть в Shopify ↗</a>
                    </Button>
                  )}
                </div>
              );
            })()}
          </div>
        </CardBody>
      </Card>

      {/* Варианты */}
      <Card className="overflow-x-auto">
        <CardHeader><CardTitle>Варианты · {product.variants.length}</CardTitle></CardHeader>
        <CardBody className="p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                <th className="px-3 py-2 font-medium">Вариант / Опции</th>
                <th className="px-3 py-2 text-right font-medium">Цена сайта</th>
                <th className="px-3 py-2 text-right font-medium">Цена флориста</th>
                <th className="px-3 py-2 font-medium">Состав букета</th>
                <th className="px-3 py-2 font-medium">Статус</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {product.variants.map((v) => (
                <tr key={v.id} className="border-b border-slate-50 align-middle">
                  <td className="px-3 py-2 font-medium text-slate-800">{variantOptions(v)}</td>
                  <td className="px-3 py-2 text-right text-slate-700">{formatMoney(toNumber(v.listPrice))}</td>
                  <td className="px-3 py-2 text-right">
                    {v.floristPrice != null ? (
                      <span className="text-slate-700">{formatMoney(toNumber(v.floristPrice))}</span>
                    ) : (
                      <span className="text-slate-400">Full Price</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {v.floristComposition && v.floristComposition.trim() ? (
                      <span className="text-xs text-slate-600">{truncate(v.floristComposition.replace(/\n/g, "; "))}</span>
                    ) : (
                      <span className="text-xs text-slate-400">не заполнен</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {v.remoteDeleted ? (
                      <span className="text-red-600">удалён</span>
                    ) : v.available ? (
                      <span className="text-emerald-600">доступен</span>
                    ) : (
                      <span className="text-slate-400">нет в наличии</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <VariantEditDialog
                      variantId={v.id}
                      title={variantOptions(v)}
                      initialPrice={v.floristPrice != null ? toNumber(v.floristPrice) : null}
                      initialComposition={v.floristComposition}
                      adminUrl={product.site.platform === "SHOPIFY" ? v.adminUrl : null}
                      onlineUrl={product.onlineUrl ?? (product.site.platform === "SHOPIFY" ? null : product.adminUrl)}
                      siblings={product.variants
                        .filter((x) => x.id !== v.id)
                        .map((x) => ({ id: x.id, label: variantOptions(x), composition: x.floristComposition }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[11px] tracking-wide text-slate-400 uppercase">{label}</div>
      <div className="mt-0.5 text-slate-700">{children}</div>
    </div>
  );
}
