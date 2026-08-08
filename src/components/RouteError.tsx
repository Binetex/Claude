"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

/**
 * UI для route-level error boundary (Next.js `error.tsx`).
 *
 * ПОКАЗЫВАЕТ ОДНО И ТО ЖЕ ВСЕГДА — спокойное «Богдан сейчас изменяет сайт» с анимацией.
 * Красной технической ошибки здесь больше нет, и возвращать её не надо.
 *
 * Почему так. Раньше это сообщение было спрятано за условием «сервер не отвечает», и
 * владелец его почти никогда не видел: при деплое вкладка чаще всего просто ждёт, а вот
 * упасть страница может и на живом сервере. В итоге на экране была красная плашка
 * «Не удалось загрузить раздел» — она пугает, ничего не объясняет и предлагает сообщить
 * администратору самому же администратору.
 *
 * Диагностика не потеряна: причина уходит в консоль вместе с digest, по которому ошибка
 * находится в логах сервера.
 *
 * Сам возвращается к работе двумя путями:
 *  - сервер лежал (деплой) и снова ответил — перерисовываем сразу, без клика;
 *  - сервер жив, ошибка разовая — пробуем ещё несколько раз с паузой. Бесконечно повторять
 *    нельзя: если страница падает стабильно, цикл reset → падение → reset сожжёт браузер.
 */

/** Пауза между опросами health и потолок ожидания: деплой укладывается в пару минут. */
const PROBE_DELAY_MS = 3000;
const MAX_PROBES = 40;

/** Сколько раз пробуем перерисоваться сами, когда сервер отвечает. */
const MAX_AUTO_RETRIES = 3;
const AUTO_RETRY_DELAY_MS = 4000;
/** Через столько тишины считаем, что это новая поломка, и снова даём три попытки. */
const INCIDENT_WINDOW_MS = 60_000;

/**
 * Счётчик попыток живёт ВНЕ компонента и это принципиально: `reset()` пересоздаёт границу
 * ошибок, поэтому любое состояние внутри неё обнуляется. Со счётчиком в useRef цикл
 * reset → падение → reset крутился бы вечно, а кнопка не появлялась никогда (проверено).
 */
let autoRetries = 0;
let lastAttemptAt = 0;

export function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [givenUp, setGivenUp] = useState(false);

  useEffect(() => {
    // Логируем для диагностики; PII в сообщение ошибки не попадает (см. правила логирования).
    console.error("[route-error]", error.digest ?? "", error.message);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    let probes = 0;
    // Сервер был недоступен хотя бы раз — только тогда возвращение health означает
    // «деплой закончился», и перерисовку можно запускать немедленно.
    let wasDown = false;

    const probe = async () => {
      if (cancelled) return;
      let alive = false;
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        alive = res.ok;
      } catch {
        alive = false;
      }
      if (cancelled) return;

      if (alive) {
        if (wasDown) return reset(); // деплой закончился — возвращаемся сразу
        // Сервер жив, значит упала сама страница. Пробуем несколько раз: ошибка могла быть
        // разовой. Дальше — только по кнопке, иначе бесконечный цикл падений.
        const now = Date.now();
        // Давно не падало — считаем это новой поломкой, а не продолжением прошлой.
        if (now - lastAttemptAt > INCIDENT_WINDOW_MS) autoRetries = 0;
        lastAttemptAt = now;

        if (autoRetries < MAX_AUTO_RETRIES) {
          autoRetries += 1;
          setTimeout(() => !cancelled && reset(), AUTO_RETRY_DELAY_MS);
        } else {
          setGivenUp(true);
        }
        return;
      }

      wasDown = true;
      probes++;
      // Потолок: если сервер не вернулся за две минуты, это уже не деплой.
      if (probes < MAX_PROBES) setTimeout(probe, PROBE_DELAY_MS);
      else setGivenUp(true);
    };

    probe();
    return () => {
      cancelled = true;
    };
  }, [reset]);

  return (
    <div className="p-6">
      <style>{`
        @keyframes fm-sweep { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }
        @keyframes fm-breathe { 0%, 100% { transform: scale(1); opacity: .9; } 50% { transform: scale(1.08); opacity: 1; } }
      `}</style>

      <div className="mx-auto max-w-md rounded-2xl border border-slate-200 bg-white px-6 py-9 text-center shadow-sm">
        <div
          className="mx-auto flex size-14 items-center justify-center rounded-full bg-violet-50 text-2xl"
          style={{ animation: "fm-breathe 2.4s ease-in-out infinite" }}
          aria-hidden
        >
          🌸
        </div>

        <div className="mt-4 text-base font-semibold text-slate-900">Богдан сейчас изменяет сайт</div>
        <p className="mt-2 text-sm text-slate-500">
          Идут улучшения. Раздел откроется сам через минуту — ничего делать не нужно.
        </p>

        {/* Бегущая полоса: показывает, что процесс идёт, и не притворяется прогрессом —
            сколько осталось, мы не знаем. */}
        <div className="mt-5 h-1 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          <div
            className="h-full w-1/3 rounded-full bg-violet-400"
            style={{ animation: "fm-sweep 1.6s ease-in-out infinite" }}
          />
        </div>

        <p className="mt-5 text-xs text-slate-400">Данные в безопасности, ничего не потерялось.</p>

        {/* Кнопка появляется, только когда сами уже не пробуем: раньше она была бы советом
            сделать то, что и так происходит. */}
        {givenUp && (
          <div className="mt-5">
            <Button variant="outline" size="sm" onClick={reset}>
              Открыть заново
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
