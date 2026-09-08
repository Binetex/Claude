import Link from "next/link";
import { Phone, MessageSquare, PhoneCall } from "lucide-react";
import { TOPIC_LABEL, type TopicKey } from "@/integrations/quo/otherMessages";
import { pluralRu } from "@/lib/plural";

export type ThreadRow = {
  href: string;
  phoneDisplay: string;
  storeLabel: string;
  storeKnown: boolean;
  topic: TopicKey;
  topicIsManual: boolean;
  lastText: string | null;
  lastAtLabel: string;
  smsCount: number;
  callCount: number;
  waitingForUs: boolean;
  wantsCall: boolean;
};

const TOPIC_TONE: Record<TopicKey, string> = {
  NEW_ORDER: "bg-emerald-50 text-emerald-700 border-emerald-200",
  PICKUP: "bg-sky-50 text-sky-700 border-sky-200",
  DELIVERY: "bg-sky-50 text-sky-700 border-sky-200",
  EXISTING_ORDER: "bg-amber-50 text-amber-700 border-amber-200",
  SPAM: "bg-slate-100 text-slate-500 border-slate-200",
  JOB: "bg-slate-100 text-slate-500 border-slate-200",
  SERVICE: "bg-slate-100 text-slate-500 border-slate-200",
  OTHER: "bg-slate-50 text-slate-600 border-slate-200",
};

function preview(row: ThreadRow): string {
  if (row.lastText?.trim()) return row.lastText.trim();
  if (row.callCount === 1) return "Звонок без сообщения";
  return `${row.callCount} ${pluralRu(row.callCount, "звонок", "звонка", "звонков")} без сообщений`;
}

/**
 * Строка списка — целиком ссылка, без единой кнопки внутри: так же сделана очередь отзывов
 * (components/reviews/ReviewQueue.tsx). Кнопку внутри ссылки нельзя нажать, не попав в ссылку,
 * поэтому все действия живут на странице переписки.
 *
 * В строке ровно то, по чему решают, открывать ли: кто, в какой магазин, о чём, когда и чей ход.
 */
export function ThreadList({ rows }: { rows: ThreadRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-white px-4 py-10 text-center text-sm text-slate-400">
        В этой категории за выбранный период ничего нет.
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li key={row.href}>
          <Link
            href={row.href}
            className={`block rounded-xl border px-4 py-3 transition-colors hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 ${
              row.waitingForUs ? "border-amber-300 bg-amber-50/40" : "border-slate-200 bg-white"
            }`}
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="font-medium text-slate-800 tabular-nums">{row.phoneDisplay}</span>

              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${row.storeKnown ? "border-slate-200 bg-slate-50 text-slate-600" : "border-dashed border-slate-300 bg-white text-slate-400"}`}>
                {row.storeLabel}
              </span>

              <span className={`rounded-full border px-2 py-0.5 text-[11px] ${TOPIC_TONE[row.topic]}`}>
                {TOPIC_LABEL[row.topic]}
                {row.topicIsManual && <span className="ml-1 opacity-60">вручную</span>}
              </span>

              {row.wantsCall && (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700">
                  <PhoneCall className="size-3" /> просит перезвонить
                </span>
              )}

              <span className="ml-auto text-[11px] text-slate-400">{row.lastAtLabel}</span>
            </div>

            <div className="mt-1 line-clamp-2 text-sm text-slate-600">{preview(row)}</div>

            <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400">
              {row.smsCount > 0 && (
                <span className="inline-flex items-center gap-1"><MessageSquare className="size-3" />{row.smsCount} SMS</span>
              )}
              {row.callCount > 0 && (
                <span className="inline-flex items-center gap-1"><Phone className="size-3" />{row.callCount} {pluralRu(row.callCount, "звонок", "звонка", "звонков")}</span>
              )}
              {row.waitingForUs && <span className="font-medium text-amber-700">ход за нами</span>}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}
