"use client";
import { useRef, useState, useTransition } from "react";
import { MapPin, Plus, Trash2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardBody } from "@/components/ui/Card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { saveLocationAction, deleteLocationAction, checkZipAction } from "./actions";

type Loc = { id: string; name: string; reviewUrl: string; zipCode: string | null; isDefault: boolean; isActive: boolean };
type SiteBlock = { siteId: string; siteName: string; siteReviewUrl: string | null; locations: Loc[] };

const EMPTY: Loc = { id: "", name: "", reviewUrl: "", zipCode: null, isDefault: false, isActive: true };

/**
 * Точки Google по магазинам. Правка идёт прямо в строке, без отдельного экрана: точек у
 * магазина две-три, и переход на страницу ради одного ZIP стоил бы дороже самой правки.
 */
export function LocationsPanel({ sites }: { sites: SiteBlock[] }) {
  return (
    <div className="space-y-4">
      {sites.map((s) => (
        <SiteCard key={s.siteId} site={s} />
      ))}
      {sites.length === 0 && <p className="text-sm text-slate-500">Магазинов пока нет.</p>}
    </div>
  );
}

function SiteCard({ site }: { site: SiteBlock }) {
  const [editing, setEditing] = useState<string | null>(null);
  const hasDefault = site.locations.some((l) => l.isDefault && l.isActive);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 py-2.5">
        <CardTitle icon={MapPin}>{site.siteName}</CardTitle>
        <ZipCheck siteId={site.siteId} />
      </CardHeader>
      <CardBody className="space-y-2 py-3">
        {site.locations.map((l) =>
          editing === l.id ? (
            <LocationForm
              key={l.id}
              siteId={site.siteId}
              initial={l}
              onDone={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <LocationRow key={l.id} loc={l} onEdit={() => setEditing(l.id)} />
          )
        )}

        {editing === "new" ? (
          <LocationForm
            siteId={site.siteId}
            initial={{ ...EMPTY, isDefault: !hasDefault }}
            onDone={() => setEditing(null)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setEditing("new")} className="text-slate-500">
            <Plus className="size-4" /> Добавить точку
          </Button>
        )}

        {/* Пока справочник пуст, заказы получают старую ссылку магазина. Сказать об этом
            прямо — единственный способ объяснить, почему клиентам всё ещё что-то уходит. */}
        {site.locations.length === 0 && (
          <p className="pt-1 text-xs text-slate-500">
            {site.siteReviewUrl
              ? "Точек нет — используется общая ссылка магазина из раздела «Автоматизации»."
              : "Точек нет и общей ссылки у магазина тоже нет: просить отзыв по заказам этого магазина не получится."}
          </p>
        )}
        {site.locations.length > 0 && !hasDefault && (
          <p className="pt-1 text-xs text-amber-700">
            Нет запасной точки: заказ с незнакомым индексом уйдёт на общую ссылку магазина.
          </p>
        )}
      </CardBody>
    </Card>
  );
}

function LocationRow({ loc, onEdit }: { loc: Loc; onEdit: () => void }) {
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm ${
        loc.isActive ? "border-slate-200" : "border-slate-200 bg-slate-50 text-slate-400"
      }`}
    >
      <button type="button" onClick={onEdit} className="font-medium text-slate-800 hover:underline">
        {loc.name}
      </button>
      {loc.isDefault && (
        <span className="rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-600">запасная</span>
      )}
      {!loc.isActive && (
        <span className="rounded bg-slate-100 px-1.5 py-px text-[11px] text-slate-500">выключена</span>
      )}
      <span className="font-mono text-xs text-slate-500">
        {loc.zipCode ?? "без индекса"}
      </span>
      <a
        href={loc.reviewUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto max-w-[240px] truncate text-xs text-sky-600 hover:underline"
      >
        {loc.reviewUrl}
      </a>
    </div>
  );
}

function LocationForm({
  siteId,
  initial,
  onDone,
  onCancel,
}: {
  siteId: string;
  initial: Loc;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial.name);
  const [reviewUrl, setReviewUrl] = useState(initial.reviewUrl);
  const [zipRaw, setZipRaw] = useState(initial.zipCode ?? "");
  const [isDefault, setIsDefault] = useState(initial.isDefault);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function save() {
    setError(null);
    start(async () => {
      const res = await saveLocationAction({
        id: initial.id || null,
        siteId,
        name,
        reviewUrl,
        zipRaw,
        isDefault,
        isActive,
      });
      if (res.error) setError(res.error);
      else onDone();
    });
  }

  function remove() {
    start(async () => {
      const res = await deleteLocationAction(initial.id);
      if (res.error) setError(res.error);
      else onDone();
    });
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs text-slate-600">
          Название точки
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Beverly Hills" className="mt-1" />
        </label>
        <label className="block text-xs text-slate-600">
          Ссылка «оставить отзыв»
          <Input
            value={reviewUrl}
            onChange={(e) => setReviewUrl(e.target.value)}
            placeholder="https://g.page/r/…/review"
            className="mt-1"
          />
        </label>
      </div>

      <label className="block text-xs text-slate-600">
        Индекс точки на карте
        <Input
          value={zipRaw}
          onChange={(e) => setZipRaw(e.target.value)}
          placeholder="90066"
          className="mt-1 w-32 font-mono"
        />
        <span className="mt-1 block text-[11px] text-slate-500">
          Индекс того места, где точка стоит в Google. Больше ничего указывать не нужно: каждый
          заказ уходит к <b>ближайшей</b> точке магазина, система считает расстояние сама.
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-slate-700">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={isDefault}
            onChange={(e) => setIsDefault(e.target.checked)}
            className="size-4 accent-slate-700"
          />
          Запасная точка магазина
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={isActive}
            onChange={(e) => setIsActive(e.target.checked)}
            className="size-4 accent-slate-700"
          />
          Активна
        </label>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          Сохранить
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={pending}>
          Отмена
        </Button>
        {initial.id && (
          <Button size="sm" variant="ghost" onClick={remove} disabled={pending} className="ml-auto text-red-600">
            <Trash2 className="size-4" /> Удалить
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * Проверка адреса. Разметка ZIP — это данные, а не код: опечатка в одном коде тихо уводит
 * часть заказов к запасной точке, и без проверки заметить это можно только по факту отправки.
 */
function ZipCheck({ siteId }: { siteId: string }) {
  const [zip, setZip] = useState("");
  const [res, setRes] = useState<{ name: string | null; reason: string; miles: number | null } | null>(null);
  const [pending, start] = useTransition();
  // Номер запроса: ответы приходят в любом порядке, и без него ответ по стёртому ZIP мог
  // перезаписать свежий — поле показывало бы чужую точку рядом с введённым адресом. Врало бы
  // оно правдоподобно, а перепроверить нечем: это и есть сама проверка.
  const seq = useRef(0);

  function check(value: string) {
    setZip(value);
    setRes(null);
    if (value.replace(/\D/g, "").length < 5) return;
    const mine = (seq.current += 1);
    start(async () => {
      const answer = await checkZipAction(siteId, value);
      if (seq.current === mine) setRes(answer);
    });
  }

  const label =
    res === null
      ? null
      : res.reason === "nearest"
        ? { text: `→ ${res.name} · ${res.miles!.toFixed(1)} мили`, cls: "text-emerald-700" }
        : res.reason === "default"
          ? { text: `→ ${res.name} (запасная)`, cls: "text-slate-600" }
          : res.reason === "site_fallback"
            ? { text: "→ общая ссылка магазина", cls: "text-amber-700" }
            : { text: "→ ссылки нет", cls: "text-red-600" };

  return (
    <div className="flex items-center gap-2">
      <Input
        value={zip}
        onChange={(e) => check(e.target.value)}
        placeholder="Проверить ZIP"
        className="h-8 w-36 font-mono text-xs"
      />
      {label && <span className={`text-xs ${label.cls}`}>{pending ? "…" : label.text}</span>}
    </div>
  );
}
