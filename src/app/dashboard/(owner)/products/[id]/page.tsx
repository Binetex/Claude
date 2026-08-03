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
import { ProductFinanceBlock } from "../ProductFinanceBlock";
import type { VariantFinanceVM } from "../VariantFinanceBlock";
import { resolveVariantFinance, type VaseCostRow, type LinkedVaseInfo } from "@/modules/catalog/finance/resolveVariantFinance";
import { listVaseOptions } from "@/modules/catalog/finance/vaseLink";
import { financialTypeLabel, DEFAULT_TYPE_LABEL } from "@/modules/catalog/finance/display";

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

/**
 * Ссылка возврата в каталог. `back` приносит запрос каталога (фильтры, сортировка, страница),
 * и его надо пересобрать через URLSearchParams, а не подставлять как есть: значение пришло из
 * URL, и так в ссылку попадут только нормальные пары key=value, а путь останется нашим.
 */
function backToCatalog(back: string | undefined): string {
  const qs = new URLSearchParams(back ?? "").toString();
  return qs ? `/dashboard/products?${qs}` : "/dashboard/products";
}

export default async function ProductDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const backParam = Array.isArray(sp.back) ? sp.back[0] : sp.back;
  const backHref = backToCatalog(backParam);

  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      site: { select: { name: true, shortName: true, colorTag: true, platform: true } },
      variants: { orderBy: [{ remoteDeleted: "asc" }, { position: "asc" }, { title: "asc" }] },
      vaseCosts: true,
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

  // ── Финансовая классификация: эффективные значения считает общий резолвер, а не страница ──

  const linkedVaseIds = [
    product.defaultIncludedVaseVariantId,
    ...product.variants.map((v) => v.includedVaseVariantId),
  ].filter((x): x is string => !!x);

  const [variantCosts, vaseOptions, linkedVases, usedInBouquets] = await Promise.all([
    prisma.vasePurchaseCost.findMany({
      where: { OR: [{ productVariantId: { in: product.variants.map((v) => v.id) } }, { productVariantId: { in: linkedVaseIds } }] },
    }),
    listVaseOptions(product.siteId),
    linkedVaseIds.length
      ? prisma.productVariant.findMany({
          where: { id: { in: linkedVaseIds } },
          select: {
            id: true,
            title: true,
            financialType: true,
            remoteDeleted: true,
            deletedAt: true,
            product: { select: { id: true, name: true, financialType: true, vaseCosts: true } },
          },
        })
      : Promise.resolve([]),
    // Сколько букетов ссылается на вазы этого товара — считаем ОБА вида ссылок:
    // собственную ссылку варианта и дефолт товара, иначе счётчик врёт.
    Promise.all([
      prisma.productVariant.count({ where: { includedVaseVariantId: { in: product.variants.map((v) => v.id) } } }),
      prisma.product.count({ where: { defaultIncludedVaseVariantId: { in: product.variants.map((v) => v.id) } } }),
    ]).then(([byVariant, byProduct]) => byVariant + byProduct),
  ]);

  const allCosts: VaseCostRow[] = [
    ...variantCosts,
    ...product.vaseCosts,
    ...linkedVases.flatMap((v) => v.product.vaseCosts),
  ].map((c) => ({
    id: c.id,
    productId: c.productId,
    productVariantId: c.productVariantId,
    costType: c.costType,
    purchaseCostCents: c.purchaseCostCents,
  }));

  const vases: Record<string, LinkedVaseInfo> = {};
  for (const v of linkedVases) {
    vases[v.id] = {
      id: v.id,
      productId: v.product.id,
      effectiveType: v.financialType ?? v.product.financialType ?? null,
      archived: v.remoteDeleted || v.deletedAt != null,
      label: `${v.product.name}${v.title !== "Default Title" ? ` / ${v.title}` : ""}`,
    };
  }

  const toRowVM = (c: (typeof allCosts)[number]) => ({
    id: c.id,
    purchaseCostCents: c.purchaseCostCents,
    level: (c.productVariantId ? "VARIANT" : "PRODUCT") as "VARIANT" | "PRODUCT",
    comment: null as string | null,
  });

  const productCostRows = product.vaseCosts.map(toRowVM);
  // Стоимость вазы почти всегда задана на её варианте, а не на товаре. Показываем это на
  // карточке, иначе блок товара говорит «не указана», хотя у варианта значение есть.
  const variantOwnCosts = product.variants
    .map((v) => {
      const active = allCosts.find((c) => c.productVariantId === v.id && c.costType === "STANDALONE_VASE");
      return active ? { title: v.title, cents: active.purchaseCostCents } : null;
    })
    .filter((x): x is { title: string; cents: number } => !!x);
  const productActiveCost = product.vaseCosts[0] ?? null;

  // Ваза по умолчанию у товара — то же состояние, что и у варианта, но без наследования.
  const productResolved = resolveVariantFinance({
    variant: { id: "__product__", financialType: product.financialType, includesVase: product.defaultIncludesVase, includedVaseVariantId: product.defaultIncludedVaseVariantId },
    product: { id: product.id, financialType: product.financialType, defaultIncludesVase: null, defaultIncludedVaseVariantId: null },
    costs: allCosts,
    vases,
  });
  const productVaseState = {
    ownIncludesVase: product.defaultIncludesVase,
    ownVaseVariantId: product.defaultIncludedVaseVariantId,
    effectiveVaseLabel: productResolved.vase?.label ?? null,
    effectiveVaseCostCents: productResolved.purchaseCostCents,
    effectiveVaseProductId: productResolved.vase?.productId ?? null,
    effectiveVaseArchived: productResolved.vase?.archived ?? false,
    effectiveSource: "VARIANT" as const,
  };
  const productVaseHint = productResolved.vase?.label ?? "без вазы";

  const financeByVariant = new Map<string, VariantFinanceVM>();
  for (const v of product.variants) {
    const resolved = resolveVariantFinance({
      variant: { id: v.id, financialType: v.financialType, includesVase: v.includesVase, includedVaseVariantId: v.includedVaseVariantId },
      product: {
        id: product.id,
        financialType: product.financialType,
        defaultIncludesVase: product.defaultIncludesVase,
        defaultIncludedVaseVariantId: product.defaultIncludedVaseVariantId,
      },
      costs: allCosts,
      vases,
    });
    const ownCost = allCosts.find((c) => c.productVariantId === v.id && c.costType === "STANDALONE_VASE");
    financeByVariant.set(v.id, {
      variantId: v.id,
      productId: product.id,
      ownType: v.financialType,
      effectiveType: resolved.financialType,
      typeSource: resolved.financialTypeSource,
      // Что будет, если у варианта ничего не выбирать: тип товара либо умолчание.
      inheritLabel: product.financialType ? `Как у товара — ${financialTypeLabel(product.financialType)}` : DEFAULT_TYPE_LABEL,
      vase: {
        ownIncludesVase: v.includesVase,
        ownVaseVariantId: v.includedVaseVariantId,
        effectiveVaseLabel: resolved.vase?.label ?? null,
        effectiveVaseCostCents: resolved.purchaseCostCents,
        effectiveVaseProductId: resolved.vase?.productId ?? null,
        effectiveVaseArchived: resolved.vase?.archived ?? false,
        effectiveSource: resolved.vaseSource,
        productHint: productVaseHint,
      },
      ownCostCents: ownCost?.purchaseCostCents ?? null,
      ownCostHistory: allCosts.filter((c) => c.productVariantId === v.id).map(toRowVM),
    });
  }

  return (
    <div className="space-y-4">
      <Link href={backHref} className="text-sm text-slate-500 hover:underline">← Товары</Link>

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

      {/* Финансовая классификация товара */}
      <Card>
        <CardHeader><CardTitle>Финансовая классификация</CardTitle></CardHeader>
        <CardBody>
          <ProductFinanceBlock
            productId={product.id}
            financialType={product.financialType}
            vase={productVaseState}
            vaseOptions={vaseOptions}
            costHistory={productCostRows}
            effectiveCostCents={productActiveCost?.purchaseCostCents ?? null}
            usedInBouquets={usedInBouquets}
            variantOwnCosts={variantOwnCosts}
          />
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
                      finance={financeByVariant.get(v.id)!}
                      vaseOptions={vaseOptions}
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
