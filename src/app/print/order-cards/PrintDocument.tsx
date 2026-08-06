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
import { printCss, cellSize, CARD_PADDING_PX, MSG_LINE_HEIGHT, type PrintLayout } from "./printCss";
import type { PrintOrder } from "@/modules/print/loadPrintable";

// Размеры карточки берутся из printCss — того же модуля, что строит вёрстку. Разойдись они,
// подобранный кегль не совпадёт с реальной раскладкой. У портретной раскладки карточка
// вчетверо больше, поэтому и область текста считается по ней, а не по одной константе.
const PAD = CARD_PADDING_PX; // поле карточки — то же значение, что в CSS (.card padding)
const textArea = (layout: PrintLayout) => {
  const cell = cellSize(layout);
  return { width: cell.w - 2 * PAD, height: cell.h - 2 * PAD - 12 };
};

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

export function PrintDocument({ orders, layout }: { orders: PrintOrder[]; layout: PrintLayout }) {
  const wide = layout === "wide";
  const measRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState<Page[] | null>(null);

  useLayoutEffect(() => {
    const meas = measRef.current;
    if (!meas) return;
    const area = textArea(layout);
    meas.style.width = `${area.width}px`;
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
        { basePt: startPt, minPt: MIN_FONT_PT, areaHeightPx: area.height },
        measure
      );

      // Поместилось целиком — одна половина, без разрыва. Иначе (даже на минимуме не влезло)
      // разбиваем на части тем же минимальным кеглем: текст не обрезаем.
      const parts = fits
        ? [o.cardMessage]
        : splitCardIntoParts(
            o.cardMessage,
            { firstHeightPx: area.height, contHeightPx: area.height },
            (t) => measure(t, fontPt)
          );
      return buildOrderHalves(recipient, parts.length ? parts : [o.cardMessage], fontPt);
    });

    setPages(packColumnsIntoPages(packOrderColumns(perOrder), layout === "wide" ? 2 : 1));
  }, [orders, layout]);

  return (
    <>
      <style>{printCss(layout)}</style>
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
                (получатель над текстом), справа правый. В портретной раскладке столбец
                один — второй ячейки в строке нет, и вертикального реза тоже. */}
            <div className="grid">
              <CardView half={page.left.top} />
              {wide && <CardView half={page.right?.top ?? EMPTY} />}
              <CardView half={page.left.bottom} />
              {wide && <CardView half={page.right?.bottom ?? EMPTY} />}
              {wide && <div className="cut-v" aria-hidden />}
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
