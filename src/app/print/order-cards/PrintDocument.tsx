"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { splitCardIntoParts } from "@/lib/print/splitNote";
import { fitFontPt, startingFontPt } from "@/lib/print/fitText";
import {
  buildOrderHalves,
  packOrderColumns,
  packColumnsIntoPages,
  type Half,
  type Page,
  type RecipientInfo,
} from "@/lib/print/packSheets";
import { escapeHtml, isBlankCardMessage } from "@/lib/print/cardText";
import { PRINT_CSS, CARD_PADDING_PX, CELL_W_PX, CELL_H_PX, MSG_LINE_HEIGHT } from "./printCss";
import type { PrintOrder } from "@/modules/print/loadPrintable";

// Размеры карточки берутся из printCss — того же модуля, что строит вёрстку. Разойдись они,
// подобранный кегль не совпадёт с реальной раскладкой.
const PAD = CARD_PADDING_PX; // поле карточки — то же значение, что в CSS (.card padding)
const NOTE_W = CELL_W_PX - 2 * PAD; // ширина текстовой области
const MSG_AREA_H = CELL_H_PX - 2 * PAD - 12; // доступная высота текста открытки в карточке

/**
 * Диапазон кегля текста открытки.
 *
 * 16pt — только для коротких записок, до четырёх строк включительно. С пятой строки текст
 * печатается 14pt: место на карточке ещё есть, но 16pt на такой объём выглядит крупно.
 * Дальше работает обычный подбор — если и 14pt не помещается, кегль опускается ниже.
 *
 * Минимум опущен с 12pt до 10pt намеренно. Площадь карточки теперь около трёх четвертей от
 * прежней половины, и на старом минимуме записки, которые раньше помещались целиком, начали
 * бы рваться на две карточки. 10pt восстанавливает прежний порог «влезает без разрыва».
 */
const BASE_FONT_PT = 16;
const CROWDED_FONT_PT = 14;
const BASE_MAX_LINES = 4;
const MIN_FONT_PT = 10;

function recipientOf(o: PrintOrder): RecipientInfo {
  return {
    recipientName: o.recipientName,
    recipientPhone: o.recipientPhone,
    addressLine: o.addressLine,
    apartment: o.apartment,
    city: o.city,
    state: o.state,
    zip: o.zip,
  };
}

function cityStateZip(r: RecipientInfo): string {
  const sz = [r.state, r.zip].filter(Boolean).join(" ");
  return [r.city, sz].filter(Boolean).join(", ");
}

export function PrintDocument({ orders }: { orders: PrintOrder[] }) {
  const measRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[] | null>(null);

  useLayoutEffect(() => {
    const meas = measRef.current;
    if (!meas) return;
    meas.style.width = `${NOTE_W}px`;
    const measure = (text: string, fontPt: number): number => {
      meas.style.fontSize = `${fontPt}pt`;
      meas.innerHTML = `<div style="white-space:pre-wrap;line-height:${MSG_LINE_HEIGHT}">${escapeHtml(text)}</div>`;
      return meas.offsetHeight;
    };

    const perOrder: Half[][] = orders.map((o) => {
      const recipient = recipientOf(o);
      if (isBlankCardMessage(o.cardMessage)) return buildOrderHalves(recipient, [], BASE_FONT_PT);

      // Кегль подбирается ДЛЯ КАЖДОЙ открытки отдельно: короткая записка не должна мельчать
      // из-за того, что в этом же документе печатается длинная.
      const startPt = startingFontPt(
        o.cardMessage,
        {
          basePt: BASE_FONT_PT,
          crowdedPt: CROWDED_FONT_PT,
          maxLinesAtBase: BASE_MAX_LINES,
          lineHeightRatio: MSG_LINE_HEIGHT,
        },
        measure
      );
      const { fontPt, fits } = fitFontPt(
        o.cardMessage,
        { basePt: startPt, minPt: MIN_FONT_PT, areaHeightPx: MSG_AREA_H },
        measure
      );

      // Поместилось целиком — одна половина, без разрыва. Иначе (даже на минимуме не влезло)
      // разбиваем на части тем же минимальным кеглем: текст не обрезаем.
      const parts = fits
        ? [o.cardMessage]
        : splitCardIntoParts(
            o.cardMessage,
            { firstHeightPx: MSG_AREA_H, contHeightPx: MSG_AREA_H },
            (t) => measure(t, fontPt)
          );
      return buildOrderHalves(recipient, parts.length ? parts : [o.cardMessage], fontPt);
    });

    setPages(packColumnsIntoPages(packOrderColumns(perOrder)));
  }, [orders]);

  return (
    <>
      <style>{PRINT_CSS}</style>
      <div ref={measRef} className="no-print measurer" aria-hidden />

      <div className="no-print toolbar">
        <span className="toolbar-title">Печать открыток · {orders.length} заказ(ов)</span>
        <button type="button" onClick={() => window.print()} className="toolbar-btn">Печать / Сохранить как PDF</button>
        <button type="button" onClick={() => history.back()} className="toolbar-btn ghost">Назад</button>
      </div>

      {orders.length === 0 && <div className="no-print empty">Нет заказов для печати.</div>}

      <div className="doc">
        {(pages ?? []).map((page, i) => (
          <div className="sheet" key={i}>
            {/* Порядок ячеек — построчный, поэтому столбец = заказ: слева левый заказ
                (получатель над текстом), справа правый. */}
            <div className="grid">
              <CardView half={page.left.top} />
              <CardView half={page.right?.top ?? EMPTY} />
              <CardView half={page.left.bottom} />
              <CardView half={page.right?.bottom ?? EMPTY} />
              <div className="cut-v" aria-hidden />
              <div className="cut-h" aria-hidden />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

const EMPTY: Half = { kind: "empty" };

function CardView({ half }: { half: Half }) {
  if (half.kind === "empty") return <div className="card" />;
  if (half.kind === "recipient") {
    const r = half.recipient;
    return (
      <div className="card">
        <div className="rec-name">{r.recipientName}</div>
        <div className="rec-phone">{r.recipientPhone}</div>
        <div className="rec-addr">
          {r.addressLine}
          {r.apartment ? `, ${r.apartment}` : ""}
        </div>
        <div className="rec-addr">{cityStateZip(r)}</div>
      </div>
    );
  }
  // message (может быть пустым — тогда просто пустое поле)
  return (
    <div className="card">
      {half.body ? (
        <div className="msg" style={{ fontSize: `${half.fontPt}pt` }}>
          {half.body}
        </div>
      ) : null}
    </div>
  );
}
