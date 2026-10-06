"use client";
/**
 * Форма настроек печати для одной раскладки — в САНТИМЕТРАХ и с живой картинкой листа (владелец
 * 05.10.2026: «мне проще смотреть отступы от верхней границы и писать сразу см … сделай это всё
 * понятно и интерактивно»).
 *
 * В базе по-прежнему px, тысячные дюйма и сдвиги блоков от середины своей половины листа
 * (`PrintSettings`) — форма только переводит. Положение блока — от ВЕРХНЕГО КРАЯ листа до его
 * середины: так его меряют линейкой, и от числа строк в блоке оно не зависит. На картинке блоки
 * тянутся мышью, а в фокусе — стрелками. Сервер получает прежние поля скрытыми input'ами, поэтому
 * сохранение и подрезка на сервере (`clampSettings`) не менялись.
 *
 * Отступ карточки по-прежнему не вводится: это остаток от карточки и поля для текста.
 */
import { Fragment, useActionState, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/Card";
import {
  PRINT_FIELDS,
  PX_PER_CM,
  SHEET_FORMAT,
  blockCenters,
  cmOfMils,
  cmOfPx,
  geometry,
  milsOfCm,
  pxOfCm,
  withBlockCenters,
  type PrintGeometry,
  type PrintLayout,
  type PrintSettings,
} from "@/modules/print/settings";
import { savePrintSettingsAction, resetPrintSettingsAction, type PrintSettingsResult } from "./actions";

const EMPTY: PrintSettingsResult = {};
/** px печати на дюйм — те же 96 dpi, что в settings.ts. */
const PX = 96;

const fmt = (n: number, digits: number) => n.toFixed(digits).replace(".", ",");
const parse = (text: string): number | null => {
  const n = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(n) ? n : null;
};

type Centers = { recipient: number; message: number };

/** Поле формы: как показать значение и как записать введённое обратно в единицы базы. */
type Field = {
  key: string;
  label: string;
  unit: string;
  digits: number;
  get: (g: PrintGeometry, c: Centers) => number;
  set: (s: PrintSettings, v: number) => PrintSettings;
};

function fieldGroups(layout: PrintLayout): { title: string; hint: string; fields: Field[] }[] {
  const pt = (key: keyof PrintSettings, label: string, unit: string): Field => ({
    key,
    label,
    unit,
    digits: 0,
    get: (g) => g.settings[key],
    set: (s, v) => ({ ...s, [key]: Math.round(v) }),
  });
  return [
    {
      title: "Где печатается",
      hint: "Расстояние от верхнего края листа до СЕРЕДИНЫ блока — меряйте линейкой. Блоки на картинке можно тянуть мышью.",
      fields: [
        {
          key: "recipient",
          label: "Получатель (имя, телефон, адрес)",
          unit: "см от верха",
          digits: 1,
          get: (_g, c) => cmOfPx(c.recipient),
          set: (s, v) => withBlockCenters(layout, s, { recipient: v * PX_PER_CM }),
        },
        {
          key: "message",
          label: "Текст открытки",
          unit: "см от верха",
          digits: 1,
          get: (_g, c) => cmOfPx(c.message),
          set: (s, v) => withBlockCenters(layout, s, { message: v * PX_PER_CM }),
        },
      ],
    },
    {
      title: "Размер текста открытки",
      hint: "Сколько места занимает текст записки. Длинный текст мельчает, пока не влезет в это место.",
      fields: [
        { key: "textWidthPx", label: "Ширина", unit: "см", digits: 1, get: (g) => cmOfPx(g.settings.textWidthPx), set: (s, v) => ({ ...s, textWidthPx: pxOfCm(v) }) },
        { key: "textHeightPx", label: "Высота", unit: "см", digits: 1, get: (g) => cmOfPx(g.settings.textHeightPx), set: (s, v) => ({ ...s, textHeightPx: pxOfCm(v) }) },
        {
          key: "safeMarginMils",
          label: "Поле листа (у края принтер не печатает)",
          unit: "см",
          digits: 1,
          get: (g) => cmOfMils(g.settings.safeMarginMils),
          // Поле листа сдвигает карточки, а блоки должны остаться там, где их поставили на листе.
          set: (s, v) => withBlockCenters(layout, { ...s, safeMarginMils: milsOfCm(v) }, blockCenters(layout, s)),
        },
      ],
    },
    {
      title: "Кегль записки",
      hint: "Короткая записка печатается максимальным кеглем. Длиннее указанного числа строк — сразу на ступень мельче, дальше подбор идёт до минимума. Ниже минимума текст не мельчает, а переносится на следующий лист.",
      fields: [
        pt("basePt", "Максимальный кегль", "pt"),
        pt("minPt", "Минимальный кегль", "pt"),
        pt("baseMaxLines", "Строк максимальным кеглем", "строк"),
        pt("crowdedStepPt", "Шаг уменьшения кегля", "pt"),
        pt("lineHeightPct", "Интерлиньяж", "%"),
      ],
    },
    {
      title: "Блок получателя",
      hint: "Имя, телефон и адрес — половина листа, по которой везут букет.",
      fields: [pt("recipientPt", "Кегль", "pt")],
    },
  ];
}

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

  // Всё показываемое — после подрезки: экран обязан совпадать с бумагой.
  const g = geometry(layout, draft);
  const centers = blockCenters(layout, draft);
  const format = SHEET_FORMAT[layout];
  const groups = fieldGroups(layout);
  const msgFrom = centers.message - g.messageHeightPx / 2;
  const msgTo = centers.message + g.messageHeightPx / 2;
  const stuck = [
    draft.recipientLiftPx !== g.settings.recipientLiftPx && "получатель упёрся в край своей половины листа",
    draft.messageDropPx !== g.settings.messageDropPx && "текст открытки упёрся в край своей половины листа",
  ].filter(Boolean);

  const move = (which: keyof Centers, centerPx: number) => setDraft((d) => withBlockCenters(layout, d, { [which]: centerPx }));

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div>
          <CardTitle>{format.title}</CardTitle>
          <p className="mt-1 text-xs text-slate-500">
            {layout === "tall" ? "Флористы с доступом «Полная цена»" : "Флористы с доступом «Только своя цена»"} · лист{" "}
            {fmt(format.w * 2.54, 1)}×{fmt(format.h * 2.54, 1)} см (US Letter)
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
        <form action={save} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_auto]">
          <input type="hidden" name="layout" value={layout} />
          {PRINT_FIELDS.map((k) => (
            <input key={k} type="hidden" name={k} value={String(g.settings[k])} />
          ))}

          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.title} className="space-y-2">
                <div>
                  <h3 className="text-sm font-semibold text-slate-800">{group.title}</h3>
                  <p className="text-xs text-slate-500">{group.hint}</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {group.fields.map((f) => (
                    <label key={f.key} className="block">
                      <span className="mb-1 block text-xs font-medium text-slate-600">{f.label}</span>
                      <div className="flex items-center gap-2">
                        <NumberInput
                          value={f.get(g, centers)}
                          digits={f.digits}
                          ariaLabel={`${f.label}, ${f.unit}`}
                          onValue={(v) => setDraft((d) => f.set(d, v))}
                        />
                        <span className="shrink-0 text-xs text-slate-500">{f.unit}</span>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            ))}

            {stuck.length > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Дальше нельзя: {stuck.join("; ")}. На картинке — где он напечатается на самом деле.
              </p>
            )}

            {saved.error && <p className="text-sm text-rose-600">{saved.error}</p>}
            {saved.message && <p className="text-sm text-emerald-700">{saved.message}</p>}

            <div className="flex items-center gap-2">
              <Button type="submit">Сохранить</Button>
            </div>
          </div>

          {/* Картинка — первой, пока экран узкий: сначала видно, потом правится. */}
          <div className="order-first space-y-2 xl:order-none">
            <div className="overflow-x-auto pb-1">
              <SheetPreview layout={layout} g={g} centers={centers} onMove={move} />
            </div>
            <p className="max-w-[26rem] text-[11px] leading-relaxed text-slate-500">
              Получатель — середина на <b className="text-slate-700">{fmt(cmOfPx(centers.recipient), 1)} см</b> от верха. Текст
              открытки — место от <b className="text-slate-700">{fmt(cmOfPx(msgFrom), 1)}</b> до{" "}
              <b className="text-slate-700">{fmt(cmOfPx(msgTo), 1)} см</b>, середина на{" "}
              <b className="text-slate-700">{fmt(cmOfPx(centers.message), 1)} см</b>. Пунктир посередине — линия реза.
            </p>
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

/**
 * Число с запятой. Пока поле в фокусе — показываем набранное как есть («4,» не превращается в «4»),
 * вне фокуса — значение из формы: его могли поменять перетаскиванием на картинке или подрезкой.
 */
function NumberInput({ value, digits, ariaLabel, onValue }: { value: number; digits: number; ariaLabel: string; onValue: (n: number) => void }) {
  const shown = fmt(value, digits);
  const [text, setText] = useState<string | null>(null);
  return (
    <Input
      type="text"
      inputMode="decimal"
      aria-label={ariaLabel}
      value={text ?? shown}
      onFocus={() => setText(shown)}
      onBlur={() => setText(null)}
      onChange={(e) => {
        setText(e.target.value);
        const n = parse(e.target.value);
        if (n != null) onValue(n);
      }}
      className="w-24 tabular-nums"
    />
  );
}

const SAMPLE_RECIPIENT = ["Jane Doe", "+1 310 555 0100", "1234 Sunset Blvd, Apt 5", "Los Angeles, CA 90026"];
const SAMPLE_MESSAGE = "Happy birthday!\nWith love, Anna";

/**
 * Живая картинка листа: что и где напечатается при этих настройках. Линейка слева — сантиметры
 * от верхнего края листа, та же мера, что в полях формы. Блоки тянутся мышью, а в фокусе —
 * стрелками вверх и вниз (с Shift — по сантиметру); шаг — миллиметр.
 */
function SheetPreview({ layout, g, centers, onMove }: { layout: PrintLayout; g: PrintGeometry; centers: Centers; onMove: (which: keyof Centers, centerPx: number) => void }) {
  const f = SHEET_FORMAT[layout];
  const sheetW = f.w * PX;
  const sheetH = f.h * PX;
  const k = (layout === "tall" ? 300 : 400) / sheetW; // экранных px на px печати
  const margin = g.safeMarginIn * PX;
  const s = g.settings;
  const drag = useRef<{ which: keyof Centers; startY: number; startCenter: number } | null>(null);

  const snap = (px: number) => (Math.round(cmOfPx(px) * 10) / 10) * PX_PER_CM;
  const fontPx = (pt: number) => ((pt * PX) / 72) * k;

  // Тянуть можно блок в любом столбце; в фокус (стрелки с клавиатуры) встаёт только первый —
  // второй столбец альбомной раскладки двигается вместе с ним.
  const dragHandlers = (which: keyof Centers) => ({
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      drag.current = { which, startY: e.clientY, startCenter: centers[which] };
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      const d = drag.current;
      if (d) onMove(d.which, snap(d.startCenter + (e.clientY - d.startY) / k));
    },
    onPointerUp: () => {
      drag.current = null;
    },
  });
  const slider = (which: keyof Centers) => ({
    ...dragHandlers(which),
    role: "slider" as const,
    tabIndex: 0,
    "aria-label": which === "recipient" ? "Блок получателя: тяните вверх или вниз" : "Текст открытки: тяните вверх или вниз",
    "aria-valuemin": 0,
    "aria-valuemax": Number(fmt(f.h * 2.54, 1).replace(",", ".")),
    "aria-valuenow": Number(cmOfPx(centers[which]).toFixed(1)),
    "aria-valuetext": `${fmt(cmOfPx(centers[which]), 1)} см от верхнего края`,
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const stepCm = (e.shiftKey ? 1 : 0.1) * (e.key === "ArrowDown" ? 1 : -1);
      onMove(which, snap(centers[which] + stepCm * PX_PER_CM));
    },
  });

  const block = "absolute flex cursor-ns-resize touch-none flex-col items-center justify-center rounded-sm text-center outline-none focus-visible:ring-2 focus-visible:ring-sky-500";

  return (
    <div className="flex select-none gap-1 pr-12">
      <Ruler k={k} heightCm={f.h * 2.54} />
      <div className="relative shrink-0 bg-white shadow-sm ring-1 ring-slate-300" style={{ width: sheetW * k, height: sheetH * k }}>
        {/* Кромка, где принтер не печатает. */}
        <div className="absolute border border-dashed border-slate-200" style={{ inset: margin * k }} aria-hidden />
        {/* Линии реза — как на настоящем листе. */}
        <div className="absolute inset-x-0 border-t border-dashed border-slate-400" style={{ top: (sheetH / 2) * k }} aria-hidden />
        {f.cols > 1 && <div className="absolute inset-y-0 border-l border-dashed border-slate-400" style={{ left: (sheetW / 2) * k }} aria-hidden />}

        {Array.from({ length: f.cols }, (_, i) => {
          const x = margin + i * g.cell.w;
          const textLeft = x + (g.cell.w - s.textWidthPx) / 2;
          return (
            <Fragment key={i}>
              <div
                {...(i === 0 ? slider("recipient") : dragHandlers("recipient"))}
                className={`${block} bg-sky-50/70 px-1 py-0.5 ring-1 ring-sky-300`}
                style={{ left: textLeft * k, width: s.textWidthPx * k, top: centers.recipient * k, transform: "translateY(-50%)", fontSize: fontPx(s.recipientPt), lineHeight: 1.3 }}
              >
                {SAMPLE_RECIPIENT.map((line) => (
                  <span key={line} className="block whitespace-nowrap text-slate-700">{line}</span>
                ))}
              </div>
              <div
                {...(i === 0 ? slider("message") : dragHandlers("message"))}
                className={`${block} border border-dashed border-rose-300 bg-rose-50/60`}
                style={{ left: textLeft * k, width: s.textWidthPx * k, top: (centers.message - g.messageHeightPx / 2) * k, height: g.messageHeightPx * k, fontSize: fontPx(s.basePt), lineHeight: g.lineHeight }}
              >
                <span className="whitespace-pre-line font-serif text-slate-800">{SAMPLE_MESSAGE}</span>
              </div>
            </Fragment>
          );
        })}

        {/* Подписи середин справа за краем листа — те же числа, что в полях формы. */}
        {(["recipient", "message"] as const).map((w) => (
          <span
            key={w}
            className={`pointer-events-none absolute left-full ml-1 -translate-y-1/2 whitespace-nowrap text-[10px] font-medium tabular-nums ${w === "recipient" ? "text-sky-700" : "text-rose-700"}`}
            style={{ top: centers[w] * k }}
          >
            {fmt(cmOfPx(centers[w]), 1)} см
          </span>
        ))}
      </div>
    </div>
  );
}

/** Линейка в сантиметрах от верхнего края листа: риска на каждый сантиметр, число — на чётный. */
function Ruler({ k, heightCm }: { k: number; heightCm: number }) {
  const step = PX_PER_CM * k; // экранных px на сантиметр
  return (
    <div className="relative w-6 shrink-0 text-[9px] text-slate-400" style={{ height: heightCm * step }} aria-hidden>
      {Array.from({ length: Math.floor(heightCm) + 1 }, (_, cm) => (
        <div key={cm} className="absolute right-0 flex items-center gap-0.5" style={{ top: cm * step, transform: "translateY(-50%)" }}>
          {cm % 2 === 0 && <span className="leading-none tabular-nums">{cm}</span>}
          <span className={cm % 2 === 0 ? "h-px w-2 bg-slate-400" : "h-px w-1 bg-slate-300"} />
        </div>
      ))}
    </div>
  );
}
