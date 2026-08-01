import Link from "next/link";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { ProductStatus, FinancialItemType } from "@/generated/prisma/enums";
import { resolveVariantFinance } from "@/modules/catalog/finance/resolveVariantFinance";
import { FINANCIAL_TYPE_ORDER, FINANCIAL_TYPE_LABELS } from "@/modules/catalog/finance/display";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { formatMoney, toNumber } from "@/lib/money";
import { ProductRow, type ProductVM, type ProductFinanceVM, type VariantVM } from "./ProductRow";
import { SyncProductsBar } from "./SyncProductsBar";
import { ownerGetProductsSyncSummary } from "@/app/dashboard/(owner)/actions";
// Пейджер и разбор page/perPage переиспользуются из списка заказов — тот же вид и то же
// поведение, что владелец уже знает по «Заказам»; заводить второй свой не нужно.
import { OrdersPager } from "@/app/dashboard/(owner)/orders/OrdersPager";
import { OrdersNavProvider, OrdersPendingArea } from "@/app/dashboard/(owner)/orders/OrdersNav";
import { resolvePaging, outOfRangePageUrl } from "@/app/dashboard/(owner)/orders/paging";

export const dynamic = "force-dynamic";

const BASE_PATH = "/dashboard/products";

type SP = Record<string, string | string[] | undefined>;
const str = (v: string | string[] | undefined): string => (Array.isArray(v) ? v[0] : v ?? "");

function variantOptions(v: { option1: string | null; option2: string | null; option3: string | null; title: string }): string {
  const opts = [v.option1, v.option2, v.option3].filter((o): o is string => !!o && o !== "Default Title");
  return opts.length ? opts.join(" / ") : v.title;
}

function priceLabel(min: Prisma.Decimal | null, max: Prisma.Decimal | null): string {
  if (min == null) return "—";
  const lo = toNumber(min);
  const hi = max != null ? toNumber(max) : lo;
  return lo === hi ? formatMoney(lo) : `${formatMoney(lo)}–${formatMoney(hi)}`;
}

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  // Плоский вид запроса: хелперы пагинации и сборка ссылки «назад» работают со строками.
  const flat: Record<string, string | undefined> = Object.fromEntries(
    Object.entries(sp).map(([k, v]) => [k, str(v) || undefined])
  );
  const { page, perPage } = resolvePaging(flat);

  const q = str(sp.q).trim();
  const siteId = str(sp.site);
  const statusFilter = str(sp.status);
  const img = str(sp.img); // "" | "yes" | "no"
  const sort = str(sp.sort) || "name"; // name | price | synced
  const dir: "asc" | "desc" = str(sp.dir) === "desc" ? "desc" : "asc";
  const showInactive = str(sp.inactive) === "1";
  const comp = str(sp.comp); // "" | "full" | "partial" | "empty" — фильтр по составам
  // Финансовые фильтры. Считаются в памяти по эффективным значениям: наследование
  // Product → ProductVariant в SQL не выразить, а второй логики резолва быть не должно.
  const ftype = str(sp.ftype); // "" | FinancialItemType | "none"
  const fvase = str(sp.fvase); // "" | "yes" | "no" | "unknown"
  const fcost = str(sp.fcost) === "1"; // нет закупочной стоимости, хотя ваза нужна
  const foverride = str(sp.foverride) === "1"; // есть override у вариантов

  const where: Prisma.ProductWhereInput = {};
  if (!showInactive) {
    where.status = "ACTIVE";
    where.remoteDeleted = false;
  } else if (statusFilter) {
    where.status = statusFilter as ProductStatus;
  }
  if (siteId) where.siteId = siteId;
  if (img === "yes") where.image = { not: null };
  if (img === "no") where.image = null;
  if (q) {
    where.name = { contains: q, mode: "insensitive" };
  }

  const orderBy: Prisma.ProductOrderByWithRelationInput =
    sort === "price" ? { minPrice: dir } : sort === "synced" ? { lastSyncedAt: dir } : { name: dir };

  // Фильтр по составам считается в памяти (см. ниже) — под него страницу нарезать в БД нельзя,
  // иначе в выдаче окажется меньше строк, чем размер страницы, а счётчик страниц наврёт.
  // Поэтому при активном фильтре берём всё и режем после фильтрации, иначе — обычные skip/take.
  const financeFilterActive = !!ftype || !!fvase || fcost || foverride;
  const compFilterActive = comp === "full" || comp === "partial" || comp === "empty" || financeFilterActive;

  const include = {
    site: { select: { name: true, shortName: true, colorTag: true, platform: true } },
    variants: {
      where: { remoteDeleted: false },
      orderBy: [{ position: "asc" as const }, { title: "asc" as const }],
      include: { vaseCosts: true },
    },
    vaseCosts: true,
  };

  const [products, dbTotal, sites, summary] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      include,
      ...(compFilterActive ? {} : { skip: (page - 1) * perPage, take: perPage }),
    }),
    compFilterActive ? Promise.resolve(0) : prisma.product.count({ where }),
    prisma.site.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ownerGetProductsSyncSummary(),
  ]);

  // Резолв «на сейчас»: список — экран настройки каталога, а не расчёт заказа.
  const now = new Date();

  const rows: ProductVM[] = products.map((p) => {
    const variants: VariantVM[] = p.variants.map((v) => ({
      id: v.id,
      options: variantOptions(v),
      sku: v.sku,
      listPriceLabel: formatMoney(toNumber(v.listPrice)),
      floristPrice: v.floristPrice != null ? toNumber(v.floristPrice) : null,
      available: v.available,
      remoteDeleted: v.remoteDeleted,
      adminUrl: v.adminUrl,
    }));
    const showVariants = variants.length > 1 || (variants.length === 1 && p.variants[0].title !== "Default Title");

    // Финансовая сводка — через ОБЩИЙ резолвер, никакой отдельной логики наследования здесь.
    const allCosts = [
      ...p.vaseCosts,
      ...p.variants.flatMap((v) => v.vaseCosts),
    ].map((c) => ({
      id: c.id,
      productId: c.productId,
      productVariantId: c.productVariantId,
      costType: c.costType,
      purchaseCostCents: c.purchaseCostCents,
      effectiveFrom: c.effectiveFrom,
      effectiveTo: c.effectiveTo,
    }));
    const finance: ProductFinanceVM = {
      vaseCount: 0,
      bouquetWithVaseCount: 0,
      bouquetNoVaseCount: 0,
      unclassifiedCount: 0,
      missingCostCount: 0,
      overrideCount: 0,
    };
    const resolvedVariants = p.variants.map((v) => {
      const r = resolveVariantFinance({
        variant: { id: v.id, financialType: v.financialType, includesVase: v.includesVase },
        product: { id: p.id, financialType: p.financialType, defaultIncludesVase: p.defaultIncludesVase },
        costs: allCosts,
        at: now,
      });
      if (r.financialType === "VASE") finance.vaseCount += 1;
      if (r.financialType === "FLOWER_PRODUCT" && r.includesVase === true) finance.bouquetWithVaseCount += 1;
      if (r.financialType === "FLOWER_PRODUCT" && r.includesVase === false) finance.bouquetNoVaseCount += 1;
      if (r.financialType === null) finance.unclassifiedCount += 1;
      if (r.reviewReasons.includes("VASE_COST_MISSING")) finance.missingCostCount += 1;
      if (v.financialType != null || v.includesVase != null) finance.overrideCount += 1;
      return r;
    });
    // Индикатор составов: заполненные / всего (по неудалённым вариантам из выборки).
    const compTotal = p.variants.length;
    const compFilled = p.variants.filter((v) => v.floristComposition && v.floristComposition.trim()).length;
    return {
      id: p.id,
      name: p.name,
      image: p.image,
      siteName: p.site.shortName || p.site.name,
      siteColor: p.site.colorTag,
      status: p.status,
      remoteDeleted: p.remoteDeleted,
      sitePriceLabel: priceLabel(p.minPrice, p.maxPrice),
      floristPrice: p.floristPrice != null ? toNumber(p.floristPrice) : null,
      adminUrl: p.adminUrl,
      onlineUrl: p.onlineUrl,
      platform: p.site.platform,
      variantCount: variants.length,
      showVariants,
      compFilled,
      compTotal,
      finance,
      resolvedTypes: resolvedVariants.map((r) => r.financialType),
      resolvedVase: resolvedVariants.map((r) => r.includesVase),
      variants,
    };
  });

  // Фильтр по заполненности составов (in-memory — в БД «сколько вариантов заполнено» не выразить
  // без обхода whitespace-only значений, которые здесь считаются незаполненными).
  const matched = rows.filter((r) => {
    if (comp === "full" && !(r.compTotal > 0 && r.compFilled === r.compTotal)) return false;
    if (comp === "partial" && !(r.compFilled > 0 && r.compFilled < r.compTotal)) return false;
    if (comp === "empty" && r.compFilled !== 0) return false;

    // Финансовые фильтры — по ЭФФЕКТИВНЫМ значениям вариантов (с учётом наследования).
    if (ftype === "none" && r.finance.unclassifiedCount === 0) return false;
    if (ftype && ftype !== "none" && !r.resolvedTypes.includes(ftype as FinancialItemType)) return false;
    if (fvase === "yes" && r.finance.bouquetWithVaseCount === 0) return false;
    if (fvase === "no" && r.finance.bouquetNoVaseCount === 0) return false;
    if (fvase === "unknown" && !r.resolvedVase.includes(null)) return false;
    if (fcost && r.finance.missingCostCount === 0) return false;
    if (foverride && r.finance.overrideCount === 0) return false;
    return true;
  });

  // Всего под фильтр и строки текущей страницы. Без фильтра составов страница уже нарезана в БД.
  const total = compFilterActive ? matched.length : dbTotal;
  const filteredRows = compFilterActive ? matched.slice((page - 1) * perPage, page * perPage) : matched;

  const outOfRange = outOfRangePageUrl(flat, BASE_PATH, { total, page, perPage });
  if (outOfRange) redirect(outOfRange);

  // Возврат из карточки товара обратно на эту же страницу каталога: тащим весь текущий запрос
  // (фильтры, сортировку, страницу) в ссылку товара, иначе «← Товары» кидает на первую страницу.
  const backQuery = new URLSearchParams(
    Object.entries(flat).filter(([, v]) => v) as [string, string][]
  ).toString();

  const fieldLabel = "text-[11px] font-medium tracking-wide text-slate-400 uppercase";

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Товары <span className="text-sm font-normal text-slate-400">{total}</span>
          </span>
        }
        description="Цена сайта — из Shopify (только просмотр). Цена флориста и состав букета правятся локально."
        actions={<SyncProductsBar initial={summary} />}
      />

      {/* Поиск / фильтры / сортировка — GET-форма, состояние в URL */}
      <Card className="p-3">
        <form method="GET" className="flex flex-wrap items-end gap-2">
          {/* Размер страницы переживает смену фильтров; сама страница намеренно нет —
              после нового фильтра выдача другая, и оставаться на 5-й странице бессмысленно. */}
          <input type="hidden" name="perPage" value={String(perPage)} />
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Поиск</span>
            <Input name="q" defaultValue={q} placeholder="Название товара…" className="w-56" />
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Магазин</span>
            <Select name="site" defaultValue={siteId} wrapperClassName="w-36">
              <option value="">Все</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Статус</span>
            <Select name="status" defaultValue={statusFilter} disabled={!showInactive} wrapperClassName="w-32">
              <option value="">Любой</option>
              <option value="ACTIVE">Активные</option>
              <option value="DRAFT">Черновики</option>
              <option value="ARCHIVED">Архив</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Фото</span>
            <Select name="img" defaultValue={img} wrapperClassName="w-32">
              <option value="">Любое</option>
              <option value="yes">С фото</option>
              <option value="no">Без фото</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Составы</span>
            <Select name="comp" defaultValue={comp} wrapperClassName="w-44">
              <option value="">Все</option>
              <option value="full">Заполнены полностью</option>
              <option value="partial">Заполнены частично</option>
              <option value="empty">Не заполнены</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Фин. тип</span>
            <Select name="ftype" defaultValue={ftype} wrapperClassName="w-44">
              <option value="">Все</option>
              <option value="none">Без классификации</option>
              {FINANCIAL_TYPE_ORDER.map((t) => (
                <option key={t} value={t}>
                  {FINANCIAL_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Ваза</span>
            <Select name="fvase" defaultValue={fvase} wrapperClassName="w-40">
              <option value="">Все</option>
              <option value="yes">Букет с вазой</option>
              <option value="no">Без вазы</option>
              <option value="unknown">Не настроено</option>
            </Select>
          </label>
          <label className="flex h-9 items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name="fcost" value="1" defaultChecked={fcost} className="rounded border-slate-300" />
            Нет закуп. стоимости
          </label>
          <label className="flex h-9 items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name="foverride" value="1" defaultChecked={foverride} className="rounded border-slate-300" />
            Есть override
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Сортировка</span>
            <Select name="sort" defaultValue={sort} wrapperClassName="w-40">
              <option value="name">Название</option>
              <option value="price">Цена</option>
              <option value="synced">Синхронизация</option>
            </Select>
          </label>
          <label className="flex flex-col gap-1">
            <span className={fieldLabel}>Напр.</span>
            <Select name="dir" defaultValue={dir} wrapperClassName="w-28">
              <option value="asc">↑ возр.</option>
              <option value="desc">↓ убыв.</option>
            </Select>
          </label>
          <label className="flex h-9 items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" name="inactive" value="1" defaultChecked={showInactive} className="rounded border-slate-300" />
            Неактивные
          </label>
          <Button type="submit">Применить</Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/products">Сбросить</Link>
          </Button>
        </form>
      </Card>

      <OrdersNavProvider>
        <OrdersPendingArea>
          <div className="space-y-4">
            <Card className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-100 text-left text-[11px] tracking-wide text-slate-400 uppercase">
                    <th className="px-3 py-2 font-medium">Фото</th>
                    <th className="px-3 py-2 font-medium">Название</th>
                    <th className="px-3 py-2 font-medium">Магазин</th>
                    <th className="px-3 py-2 text-center font-medium">Вар-тов</th>
                    <th className="px-3 py-2 text-right font-medium">Цена сайта</th>
                    <th className="px-3 py-2 text-right font-medium">Цена флориста</th>
                    <th className="px-3 py-2 font-medium">Составы</th>
                    <th className="px-3 py-2 font-medium">Финансы</th>
                    <th className="px-3 py-2 font-medium">Статус</th>
                    <th className="px-3 py-2 font-medium">Действия</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="px-3 py-10 text-center text-sm text-slate-400">
                        Товаров нет. Подключите магазин или нажмите «Синхронизировать товары».
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((p) => <ProductRow key={p.id} p={p} backQuery={backQuery} />)
                  )}
                </tbody>
              </table>
            </Card>

            <OrdersPager page={page} perPage={perPage} total={total} basePath={BASE_PATH} />
          </div>
        </OrdersPendingArea>
      </OrdersNavProvider>
    </div>
  );
}
