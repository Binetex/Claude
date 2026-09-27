import { prisma } from "@/lib/db";
import { todayStrInTz, DEFAULT_STORE_TZ } from "@/lib/tz";
import { loadDaySchedule, loadTimeModel, type FloristDay } from "@/modules/timing/load";
import { fmtDuration } from "@/modules/timing/day";
import type { TimeModel } from "@/modules/timing/model";
import { DayCard } from "./DayCard";
import { loadShopsOf } from "./shops";

export const dynamic = "force-dynamic";

/** Сколько дней вперёд показываем (решение владельца: три). */
const DAYS_AHEAD = 3;
const LABELS = ["Сегодня", "Завтра", "Послезавтра"];

export default async function SchedulePage() {
  const today = todayStrInTz(DEFAULT_STORE_TZ);
  const days = Array.from({ length: DAYS_AHEAD }, (_, i) => new Date(Date.parse(`${today}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));
  const [schedules, shopsOf, model] = await Promise.all([
    Promise.all(days.map((d) => loadDaySchedule(prisma, d))),
    loadShopsOf(prisma),
    loadTimeModel(prisma),
  ]);

  return (
    <div className="space-y-5">
      {schedules.map((s, i) => (
        <DayCard key={s.day} schedule={s} label={LABELS[i]} shopsOf={shopsOf} mode="plan" />
      ))}
      <HowWeCount model={model} florists={schedules[0].florists} />
    </div>
  );
}

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];

/**
 * Из каких чисел складывается расписание — чтобы владелец видел, что они замерены, а не выдуманы:
 * пересчитываются по доставкам Burq за 60 дней (modules/timing/stats.ts).
 */
function HowWeCount({ model, florists }: { model: TimeModel; florists: FloristDay[] }) {
  const since = new Date(`${model.sample.since}T00:00:00Z`);
  return (
    <section className="rounded-2xl border border-slate-200 bg-slate-50 px-6 py-4 text-sm text-slate-600">
      <h3 className="mb-2 font-medium text-slate-800">Как считаем время</h3>
      <p className="mb-2 text-slate-500">
        {model.sample.measured
          ? `По доставкам Burq с ${since.getUTCDate()} ${MONTH[since.getUTCMonth()]}: ${model.sample.deliveries}. Пересчитывается сам.`
          : "Доставок пока мало — стартовые значения замера 28 сентября."}
      </p>
      <ul className="space-y-1">
        {florists.map((f) => {
          const prep = model.prep[f.id] ?? model.prepDefault;
          const setup = model.setup[f.id] ?? model.setupDefault;
          return (
            <li key={f.id}>
              <b className="font-medium text-slate-800">{f.name}</b>: первый букет готов к {hm(f.workStartMin + setup + prep.small)} (начало {hm(f.workStartMin)}
              {setup > 0 && ` + подготовка ${fmtDuration(setup)}`}), дальше маленький букет — {prep.small} мин, большой — {prep.big} мин
            </li>
          );
        })}
        <li>Курьер приезжает за букетом — до {model.courierMin} мин</li>
        <li>
          Дорога от флориста: {model.drive.filter((b) => b.toMiles <= 25).map((b) => `${b.fromMiles}–${b.toMiles} миль — ${b.min} мин`).join(" · ")}
        </li>
        <li>Кого собирать первым — по сроку клиента с учётом дороги; опоздание до 20 минут опозданием не считаем</li>
      </ul>
    </section>
  );
}
