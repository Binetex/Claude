import Link from "next/link";
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import type { ProductStatus } from "@/generated/prisma/enums";
import { Card } from "@/components/ui/Card";
import { PageHeader } from "@/components/ui/misc";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { formatMoney, toNumber } from "@/lib/money";
import { ProductRow, type ProductVM, type VariantVM } from "./ProductRow";
import { SyncProductsBar } from "./SyncProductsBar";
import { ownerGetProductsSyncSummary } from "@/app/dashboard/(owner)/actions";

export const dynamic = "force-dynamic";

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
  const q = str(sp.q).trim();
  const siteId = str(sp.site);
  const statusFilter = str(sp.status);
  const img = str(sp.img); // "" | "yes" | "no"
  const sort = str(sp.sort) || "name"; // name | price | synced
  const dir: "asc" | "desc" = str(sp.dir) === "desc" ? "desc" : "asc";
  const showInactive = str(sp.inactive) === "1";
  const comp = str(sp.comp); // "" | "full" | "partial" | "empty" — фильтр по составам

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

  const [products, sites, summary] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      include: {
        site: { select: { name: true, shortName: true, colorTag: true } },
        variants: { where: { remoteDeleted: false }, orderBy: [{ position: "asc" }, { title: "asc" }] },
      },
    }),
    prisma.site.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    ownerGetProductsSyncSummary(),
  ]);

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
      variantCount: variants.length,
      showVariants,
      compFilled,
      compTotal,
      variants,
    };
  });

  // Фильтр по заполненности составов (in-memory — товаров немного).
  const filteredRows = rows.filter((r) => {
    if (comp === "full") return r.compTotal > 0 && r.compFilled === r.compTotal;
    if (comp === "partial") return r.compFilled > 0 && r.compFilled < r.compTotal;
    if (comp === "empty") return r.compFilled === 0;
    return true;
  });

  const fieldLabel = "text-[11px] font-medium tracking-wide text-slate-400 uppercase";

  return (
    <div className="space-y-4">
      <PageHeader
        title={
          <span className="flex items-baseline gap-2">
            Товары <span className="text-sm font-normal text-slate-400">{rows.length}</span>
          </span>
        }
        description="Цена сайта — из Shopify (только просмотр). Цена флориста и состав букета правятся локально."
        actions={<SyncProductsBar initial={summary} />}
      />

      {/* Поиск / фильтры / сортировка — GET-форма, состояние в URL */}
      <Card className="p-3">
        <form method="GET" className="flex flex-wrap items-end gap-2">
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
              filteredRows.map((p) => <ProductRow key={p.id} p={p} />)
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
