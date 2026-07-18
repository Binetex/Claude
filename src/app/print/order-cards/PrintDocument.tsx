"use client";
import { useLayoutEffect, useRef, useState } from "react";
import { splitCardIntoParts } from "@/lib/print/splitNote";
import { buildOrderHalves, packOrderSheets, type Half, type Sheet, type RecipientInfo } from "@/lib/print/packSheets";
import { escapeHtml, isBlankCardMessage } from "@/lib/print/cardText";
import type { PrintOrder } from "@/modules/print/loadPrintable";
import { PRINT_CSS } from "./printCss";

const PX = 96; // CSS px на дюйм — экранный замер согласован с печатью
const HALF_H = 5.5 * PX;
const PAD = 0.5 * PX; // поле карточки
const NOTE_W = 8.5 * PX - 2 * PAD; // ширина текстовой области
const MSG_AREA_H = HALF_H - 2 * PAD - 12; // доступная высота текста открытки в половине

/** Размер шрифта текста открытки по длине: 16 / 14 / 12pt (никогда < 12pt). */
function pickFontPt(text: string): number {
  const n = text.trim().length;
  if (n <= 160) return 16;
  if (n <= 420) return 14;
  return 12;
}

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
  const [sheets, setSheets] = useState<Sheet[] | null>(null);

  useLayoutEffect(() => {
    const meas = measRef.current;
    if (!meas) return;
    meas.style.width = `${NOTE_W}px`;
    const measure = (text: string, fontPt: number): number => {
      meas.style.fontSize = `${fontPt}pt`;
      meas.innerHTML = `<div style="white-space:pre-wrap;line-height:1.4">${escapeHtml(text)}</div>`;
      return meas.offsetHeight;
    };

    const perOrder: Half[][] = orders.map((o) => {
      const recipient = recipientOf(o);
      if (isBlankCardMessage(o.cardMessage)) return buildOrderHalves(recipient, [], 16);
      const fontPt = pickFontPt(o.cardMessage);
      const parts = splitCardIntoParts(
        o.cardMessage,
        { firstHeightPx: MSG_AREA_H, contHeightPx: MSG_AREA_H },
        (t) => measure(t, fontPt)
      );
      return buildOrderHalves(recipient, parts.length ? parts : [o.cardMessage], fontPt);
    });

    setSheets(packOrderSheets(perOrder));
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
        {(sheets ?? []).map((sheet, i) => (
          <div className="sheet" key={i}>
            <HalfView half={sheet.top} />
            <div className="cut-line" aria-hidden />
            <HalfView half={sheet.bottom} />
          </div>
        ))}
      </div>
    </>
  );
}

function HalfView({ half }: { half: Half }) {
  if (half.kind === "empty") return <div className="half" />;
  if (half.kind === "recipient") {
    const r = half.recipient;
    return (
      <div className="half">
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
    <div className="half">
      {half.body ? (
        <div className="msg" style={{ fontSize: `${half.fontPt}pt` }}>
          {half.body}
        </div>
      ) : null}
    </div>
  );
}
