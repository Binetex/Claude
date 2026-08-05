"use client";
import { useEffect, useState } from "react";
import { ErrorState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";

/**
 * Переиспользуемый UI для route-level error boundary (Next.js `error.tsx`).
 *
 * РАЗЛИЧАЕТ ДВА СЛУЧАЯ, и это главное, что он делает.
 *
 * 1. Сервер перезапускается (деплой). Открытая вкладка при переходе делает запрос, тот не
 *    проходит, и сюда прилетает ошибка. Страница обслуживания nginx здесь НЕ появится:
 *    вкладка уже загружена, она ждёт данные, а не новую страницу, и 503 с версткой для неё
 *    просто нечитаемый ответ. Поэтому показываем спокойное «обновляется» и сами
 *    возвращаемся к работе, как только сервер поднялся.
 * 2. Настоящая ошибка. Тогда прежнее сообщение и кнопка «Повторить».
 *
 * Отличаем опросом /api/health, а не разбором текста ошибки: текст зависит от браузера и
 * версии Next, а health отвечает на прямой вопрос — жив сервер или нет.
 */

/** Пауза между опросами и общий потолок ожидания: деплой укладывается в пару минут. */
const PROBE_DELAY_MS = 3000;
const MAX_PROBES = 40;

export function RouteError({
  error,
  reset,
  title = "Не удалось загрузить раздел",
}: {
  error: Error & { digest?: string };
  reset: () => void;
  title?: string;
}) {
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    // Логируем для диагностики; PII в сообщение ошибки не попадает (см. правила логирования).
    console.error("[route-error]", error.digest ?? "", error.message);
  }, [error]);

  useEffect(() => {
    let cancelled = false;
    let probes = 0;
    // Сервер был недоступен хотя бы раз — только тогда возвращение health означает
    // «деплой закончился», и перерисовку можно запускать самим.
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
        setUpdating(false);
        // Падали из-за перезапуска и сервер вернулся — сами повторяем, без клика.
        if (wasDown) reset();
        return;
      }

      wasDown = true;
      setUpdating(true);
      probes++;
      // Потолок: если сервер не вернулся за две минуты, это уже не деплой. Дальше
      // молчаливо крутиться нельзя — показываем обычную ошибку с кнопкой.
      if (probes < MAX_PROBES) setTimeout(probe, PROBE_DELAY_MS);
      else setUpdating(false);
    };

    probe();
    return () => {
      cancelled = true;
    };
  }, [reset]);

  if (updating) {
    return (
      <div className="p-6">
        <div className="mx-auto max-w-md rounded-xl border border-slate-200 bg-white px-6 py-8 text-center">
          <div className="text-base font-semibold text-slate-900">Богдан обновляет Floremart</div>
          <p className="mt-2 text-sm text-slate-500">
            Сейчас вносятся улучшения в работу сайта. Подождите 1–3 минуты — раздел откроется сам.
          </p>
          <div className="mt-4 flex justify-center gap-1.5" aria-hidden>
            <span className="size-1.5 animate-pulse rounded-full bg-slate-300" />
            <span className="size-1.5 animate-pulse rounded-full bg-slate-300 [animation-delay:200ms]" />
            <span className="size-1.5 animate-pulse rounded-full bg-slate-300 [animation-delay:400ms]" />
          </div>
          <p className="mt-4 text-xs text-slate-400">Ничего делать не нужно, данные в безопасности.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <ErrorState
        title={title}
        description="Попробуйте обновить. Если ошибка повторяется — сообщите администратору."
        action={
          <Button variant="outline" size="sm" onClick={reset}>
            Повторить
          </Button>
        }
      />
    </div>
  );
}
