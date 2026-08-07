"use client";
/**
 * Форма настроек печати для одной раскладки.
 *
 * Отступы карточки НЕ вводятся: карточка задана размером листа, поэтому отступ и поле для
 * текста — одно и то же число с двух сторон ((карточка − поле) / 2). Крутится поле для
 * текста, отступ показывается пересчётом рядом — иначе два поля спорили бы друг с другом.
 */
import { useActionState, useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import {
  PRINT_FIELDS,
  PRINT_LIMITS,
  SHEET_FORMAT,
  geometry,
  type PrintLayout,
  type PrintSettings,
} from "@/modules/print/settings";
import { savePrintSettingsAction, resetPrintSettingsAction, type PrintSettingsResult } from "./actions";

const EMPTY: PrintSettingsResult = {};

const GROUPS: { title: string; hint: string; fields: (keyof PrintSettings)[] }[] = [
  {
    title: "Поле для текста",
    hint: "Сколько места занимает текст записки. Отступы карточки — остаток, они считаются сами.",
    fields: ["textWidthPx", "textHeightPx", "safeMarginMils"],
  },
  {
    title: "Кегль записки",
    hint: "Короткая записка печатается максимальным кеглем. Длиннее указанного числа строк — сразу на ступень мельче, дальше подбор идёт до минимума. Ниже минимума текст не мельчает, а переносится на следующий лист.",
    fields: ["basePt", "minPt", "baseMaxLines", "crowdedStepPt", "lineHeightPct"],
  },
  {
    title: "Блок получателя",
    hint: "Имя, телефон и адрес — та половина карточки, по которой везут букет.",
    fields: ["recipientPt", "recipientLiftPx"],
  },
];

export function PrintSettingsForm({ layout, initial }: { layout: PrintLayout; initial: PrintSettings }) {
  const [saved, save] = useActionState(savePrintSettingsAction, EMPTY);
  const [wasReset, reset] = useActionState(resetPrintSettingsAction, EMPTY);
  const [draft, setDraft] = useState<PrintSettings>(initial);

  // Форма следует за сервером. После сохранения значения могли быть подрезаны, после
  // сброса — замениться на стандартные, и показывать при этом введённое раньше нельзя:
  // на экране было бы одно, а на бумаге другое. Отпечаток меняется только когда сервер
  // прислал НОВЫЕ значения, поэтому набранное вручную не стирается на каждый рендер.
  const fingerprint = PRINT_FIELDS.map((k) => initial[k]).join(",");
  const [applied, setApplied] = useState(fingerprint);
  if (applied !== fingerprint) {
    setApplied(fingerprint);
    setDraft(initial);
  }

  const g = geometry(layout, draft);
  const format = SHEET_FORMAT[layout];
  // clampSettings мог подрезать введённое — показываем именно то, что будет напечатано.
  const corrected = PRINT_FIELDS.filter((k) => g.settings[k] !== Number(draft[k]));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{format.title}</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            {layout === "tall" ? "Флористы с доступом «Полная цена»" : "Флористы с доступом «Только своя цена»"} ·
            лист {format.w}×{format.h}in · карточка {Math.round(g.cell.w)}×{Math.round(g.cell.h)}px
          </p>
        </div>
        <a
          href={`/print/order-cards/sample?layout=${layout}`}
          target="_blank"
          rel="noreferrer"
          className="shrink-0 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Посмотреть образец
        </a>
      </CardHeader>

      <CardBody className="space-y-5">
        <form action={save} className="space-y-5">
          <input type="hidden" name="layout" value={layout} />

          {GROUPS.map((group) => (
            <div key={group.title} className="space-y-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">{group.title}</h3>
                <p className="text-xs text-slate-500">{group.hint}</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {group.fields.map((key) => {
                  const lim = PRINT_LIMITS[key];
                  return (
                    <label key={key} className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">
                        {lim.label}, {lim.unit}
                      </span>
                      <Input
                        type="number"
                        name={key}
                        value={String(draft[key])}
                        min={lim.min}
                        max={lim.max}
                        step={lim.step}
                        onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                      />
                      <span className="mt-1 block text-[11px] text-slate-400">
                        от {lim.min} до {lim.max}
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

          <div className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <span className="font-medium text-slate-700">Пересчёт: </span>
            отступы карточки {Math.round(g.padY)}px сверху и снизу, {Math.round(g.padX)}px по бокам ·
            поле снизу у получателя {Math.round(g.recipientPadBottom)}px ·
            интерлиньяж {g.lineHeight.toFixed(2)}
            {corrected.length > 0 && (
              <span className="mt-1 block text-amber-700">
                Подрезано до допустимого: {corrected.map((k) => `${PRINT_LIMITS[k].label} → ${g.settings[k]}`).join(", ")}
              </span>
            )}
          </div>

          {saved.error && <p className="text-sm text-rose-600">{saved.error}</p>}
          {saved.message && <p className="text-sm text-emerald-700">{saved.message}</p>}

          <div className="flex items-center gap-2">
            <Button type="submit">Сохранить</Button>
          </div>
        </form>

        <form action={reset} className="flex items-center gap-3 border-t border-slate-100 pt-3">
          <input type="hidden" name="layout" value={layout} />
          <Button type="submit" variant="ghost" className="text-slate-600">
            Сбросить к стандартным
          </Button>
          {wasReset.error && <p className="text-sm text-rose-600">{wasReset.error}</p>}
          {wasReset.message && <p className="text-sm text-emerald-700">{wasReset.message}</p>}
        </form>
      </CardBody>
    </Card>
  );
}
