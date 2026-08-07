"use client";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { printCss, textArea, sheetWidthPx, SHEET_IN, MSG_LINE_HEIGHT, type PrintLayout } from "./printCss";
import type { PrintOrder } from "@/modules/print/loadPrintable";

/**
 * Диапазон кегля берётся из раскладки (см. SHEET_IN): у портретной карточки потолок ниже,
 * потому что она сама крупнее, и пол ниже, чтобы длинная записка помещалась одним куском.
 *
 * Базовый кегль достаётся только коротким запискам — до четырёх строк включительно. С пятой
 * строки текст сразу печатается на ступень мельче: место ещё есть, но крупный шрифт на
 * такой объём выглядит по-плакатному. Дальше работает обычный подбор до пола раскладки.
 */
const BASE_MAX_LINES = 4;
const CROWDED_STEP_PT = 2;

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

  // Экранный масштаб листа. Лист задан в дюймах, поэтому альбомные 11" (1056px) в окно уже
  // этого не влезали и обрезались по правому краю. Уменьшаем ТОЛЬКО показ; печать берёт
  // настоящие размеры, потому что правило с --fit живёт внутри @media screen.
  // 1 — потолок: растягивать лист больше натуральной величины незачем.
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const update = () => setFit(Math.min(1, (window.innerWidth - 32) / sheetWidthPx(layout)));
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [layout]);

  useLayoutEffect(() => {
    const meas = measRef.current;
    if (!meas) return;
    const area = textArea(layout);
    const { basePt, minPt } = SHEET_IN[layout];
    meas.style.width = `${area.width}px`;
    const measure = (text: string, fontPt: number): number => {
      meas.style.fontSize = `${fontPt}pt`;
      meas.innerHTML = `<div style="white-space:pre-wrap;line-height:${MSG_LINE_HEIGHT}">${escapeHtml(text)}</div>`;
      return meas.offsetHeight;
    };

    const perOrder: Half[][] = orders.map((o) => {
      const recipient = recipientOf(o);
      if (isBlankCardMessage(o.cardMessage)) return buildOrderHalves(recipient, [], basePt);

      // Кегль подбирается ДЛЯ КАЖДОЙ открытки отдельно: короткая записка не должна мельчать
      // из-за того, что в этом же документе печатается длинная.
      const startPt = startingFontPt(
        o.cardMessage,
        {
          basePt,
          crowdedPt: Math.max(basePt - CROWDED_STEP_PT, minPt),
          maxLinesAtBase: BASE_MAX_LINES,
          lineHeightRatio: MSG_LINE_HEIGHT,
        },
        measure
      );
      const { fontPt, fits } = fitFontPt(
        o.cardMessage,
        { basePt: startPt, minPt, areaHeightPx: area.height },
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

      <div className="doc" style={{ "--fit": fit } as React.CSSProperties}>
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
      <div className="card recipient">
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
