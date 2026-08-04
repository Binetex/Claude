"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { formatMoney } from "@/lib/money";
import { ownerSearchCatalog, type CatalogHit } from "./actions";
import type { DraftItem } from "./itemTypes";

/**
 * Выбор товара из каталога — Dialog + Input + список, без сторонних библиотек.
 *
 * Именно Dialog, а не Popover: поповер пришлось бы открывать ИЗ поповера меню «Добавить
 * позицию», а вложенные поповеры друг друга закрывают — внутренний просто не успевал
 * появиться. Модалка к триггеру не привязана, поэтому конфликта нет, и на телефоне она
 * ведёт себя лучше выпадашки, прижатой к кнопке в углу.
 *
 * Список — это ВАРИАНТЫ, а не товары: в заказ кладётся конкретный вариант, от него зависят
 * цена, состав и финансовый тип. Поиск идёт на сервере (каталог в несколько сотен позиций
 * незачем гонять в браузер) и с задержкой, чтобы не дёргать его на каждую букву.
 */
export function CatalogPicker({
  sites,
  open,
  onOpenChange,
  onPick,
}: {
  sites: { id: string; name: string }[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onPick: (item: DraftItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [siteId, setSiteId] = useState<string>("");
  const [hits, setHits] = useState<CatalogHit[]>([]);
  const [pending, start] = useTransition();
  // Счётчик вместо Date.now(): ключ строки нужен только для React, а вызов часов
  // в теле компонента правило чистоты (react-hooks/purity) справедливо запрещает.
  const seq = useRef(0);

  // Задержка 250 мс: без неё каждый символ уходил бы в отдельный запрос.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => {
      start(async () => {
        setHits(await ownerSearchCatalog(query, siteId || null));
      });
    }, 250);
    return () => clearTimeout(t);
  }, [query, siteId, open]);

  function pick(h: CatalogHit) {
    onPick({
      key: `cat-${h.variantId ?? h.productId}-${(seq.current += 1)}`,
      kind: "catalog",
      productId: h.productId,
      variantId: h.variantId,
      name: h.productName,
      variantName: h.variantName,
      image: h.image,
      quantity: 1,
      customerPrice: h.customerPrice,
      floristPrice: h.floristPrice,
      composition: h.composition,
      financialType: null,
      purchaseCostCents: null,
    });
    onOpenChange(false);
    setQuery("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0">
        <DialogHeader className="mb-0 px-4 pt-4">
          <DialogTitle>Товар из каталога</DialogTitle>
        </DialogHeader>
        <div className="space-y-2 p-4 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Название товара…"
              className="pl-8"
              aria-label="Поиск по каталогу"
            />
          </div>
          {sites.length > 1 && (
            <Select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="Магазин">
              <option value="">Все магазины</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          )}
        </div>

        <div className="max-h-72 overflow-y-auto border-t border-slate-100">
          {pending && hits.length === 0 && <div className="p-3 text-sm text-slate-400">Ищу…</div>}
          {!pending && hits.length === 0 && (
            <div className="p-3 text-sm text-slate-400">
              {query ? "Ничего не нашлось. Попробуйте другое слово." : "Начните вводить название."}
            </div>
          )}
          <ul>
            {hits.map((h) => (
              <li key={`${h.productId}-${h.variantId ?? "base"}`}>
                <button
                  type="button"
                  onClick={() => pick(h)}
                  className="flex w-full items-center gap-3 border-b border-slate-50 px-3 py-2 text-left last:border-0 hover:bg-slate-50"
                >
                  {h.image ? (
                    // Обычный img: каталожные фото лежат на доменах магазинов, и next/image
                    // потребовал бы вносить каждый из них в remotePatterns.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={h.image} alt="" className="size-10 shrink-0 rounded object-cover" />
                  ) : (
                    <span className="size-10 shrink-0 rounded bg-slate-100" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-slate-800">{h.productName}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {h.variantName ?? "без вариантов"} · {h.siteName}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs whitespace-nowrap">
                    <span className="block font-medium text-slate-800 tabular-nums">{formatMoney(h.customerPrice)}</span>
                    <span className="block text-slate-400 tabular-nums">{formatMoney(h.floristPrice)} флористу</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
