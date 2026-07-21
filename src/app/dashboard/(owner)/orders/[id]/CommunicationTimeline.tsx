"use client";
import { useState } from "react";
import { ZoomableImage } from "@/components/ImageLightbox";

export type TimelineItem = {
  id: string;
  type: "SMS" | "CALL" | "VOICEMAIL";
  direction: "INBOUND" | "OUTBOUND";
  status: string;
  partyRole: "CUSTOMER" | "RECIPIENT" | "UNKNOWN";
  externalPhone: string;
  messageText: string | null;
  durationSeconds: number | null;
  recordingUrl: string | null;
  transcript: string | null;
  summary: string | null;
  attachments: { url: string; type: string | null }[];
  occurredAt: string; // ISO
  sentByName?: string | null;
};

function isImageAttachment(url: string, type: string | null): boolean {
  if (type && type.toLowerCase().startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif|bmp)(\?|#|$)/i.test(url);
}
function attachmentName(url: string): string {
  try { return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() || "вложение"); } catch { return "вложение"; }
}

/**
 * Одно MMS-вложение. Изображение → миниатюра через ZoomableImage (клик = lightbox) + ссылка «Открыть»
 * (страхует, если URL протух/битый — сама лента при этом не ломается). Не-картинка → безопасная ссылка.
 */
function AttachmentView({ url, type }: { url: string; type: string | null }) {
  if (isImageAttachment(url, type)) {
    return (
      <span className="inline-flex flex-col items-start gap-0.5">
        <ZoomableImage src={url} alt="Вложение" className="h-28 w-28 rounded border border-slate-200 object-cover" />
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-sky-600 underline">Открыть</a>
      </span>
    );
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-600 underline">
      📎 {type ? `${attachmentName(url)} · ${type}` : attachmentName(url)}
    </a>
  );
}

const STATUS_RU: Record<string, string> = { PENDING: "отправляется", SENT: "отправлено", DELIVERED: "доставлено", RECEIVED: "получено", COMPLETED: "звонок", MISSED: "пропущен", FAILED: "ошибка" };
const COLLAPSE = 300;

function statusClass(s: string): string {
  if (s === "FAILED") return "text-red-600";
  if (s === "MISSED") return "text-amber-600";
  if (s === "DELIVERED" || s === "RECEIVED" || s === "COMPLETED") return "text-emerald-700";
  return "text-slate-500";
}

function fmtTime(iso: string, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

/** Длинный текст со сворачиванием («Показать полностью»). */
function CollapsibleText({ text, id, kind }: { text: string; id: string; kind: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > COLLAPSE;
  const shown = open || !long ? text : text.slice(0, COLLAPSE) + "…";
  return (
    <div className="mt-0.5">
      <div className="text-xs whitespace-pre-wrap break-words text-slate-700">{shown}</div>
      {long && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="mt-0.5 text-[11px] text-sky-600 underline" data-testid={`toggle-${kind}-${id}`}>
          {open ? "Свернуть" : "Показать полностью"}
        </button>
      )}
    </div>
  );
}

/**
 * Единая хронологическая лента коммуникаций заказа (presentational). Порядок задаёт родитель.
 * История читается из локальной БД (не из QUO). Длинные SMS/транскрипты сворачиваются; запись
 * звонка — через безопасный <audio> + ссылку. Отсутствие записи/транскрипта — не ошибка.
 * Адаптивно: узкие блоки, break-words, без фиксированной ширины → корректно на 375px.
 */
export function CommunicationTimeline({ items, storeTimeZone, inboundLabel = "Клиент" }: { items: TimelineItem[]; storeTimeZone?: string; inboundLabel?: string }) {
  if (items.length === 0) return <div className="text-xs text-slate-400">Коммуникаций пока нет.</div>;
  return (
    <ul className="space-y-2">
      {items.map((c) => (
        <li key={c.id} className="rounded border border-slate-100 bg-slate-50 p-2 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <span className="font-medium text-slate-700">
              {c.direction === "OUTBOUND" ? "🌸 Вы" : inboundLabel}
            </span>
            <span className={statusClass(c.status)}>{STATUS_RU[c.status] ?? c.status}</span>
          </div>

          {c.type === "SMS" && (
            c.messageText
              ? <CollapsibleText text={c.messageText} id={c.id} kind="sms" />
              : c.attachments.length === 0
                ? <div className="mt-0.5 text-xs text-slate-400 italic">(без текста)</div>
                : null
          )}

          {c.attachments.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-2">
              {c.attachments.map((a, i) => <AttachmentView key={i} url={a.url} type={a.type} />)}
            </div>
          )}

          {c.type !== "SMS" && (
            <div className="mt-0.5 space-y-1">
              {c.durationSeconds != null && <div className="text-slate-500">Длительность: {c.durationSeconds} сек</div>}
              {c.recordingUrl ? (
                <div>
                  <audio controls preload="none" src={c.recordingUrl} className="h-8 w-full max-w-full" />
                  <a href={c.recordingUrl} target="_blank" rel="noopener noreferrer" className="text-[11px] text-sky-600 underline">Открыть запись</a>
                </div>
              ) : (
                <div className="text-[11px] text-slate-400">Запись недоступна</div>
              )}
              {c.transcript ? (
                <div><div className="text-[11px] font-medium text-slate-500">Транскрипт</div><CollapsibleText text={c.transcript} id={c.id} kind="transcript" /></div>
              ) : null}
              {c.summary ? (
                <div><div className="text-[11px] font-medium text-slate-500">Краткое содержание</div><CollapsibleText text={c.summary} id={c.id} kind="summary" /></div>
              ) : null}
            </div>
          )}

          <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-slate-400">
            <span>{fmtTime(c.occurredAt, storeTimeZone)}</span>
            <span className="break-all">{c.externalPhone}</span>
            {c.direction === "OUTBOUND" && c.sentByName && <span>· отправил: {c.sentByName}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
