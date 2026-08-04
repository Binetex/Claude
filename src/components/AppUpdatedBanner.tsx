"use client";
import { useEffect, useState } from "react";

/**
 * «Сайт обновился» — для вкладок, открытых ДО деплоя.
 *
 * После обновления имена JS-чанков меняются, и вкладка, провисевшая с прошлой версии,
 * при переходе пытается загрузить файл, которого на диске больше нет. Пользователь видит
 * пустой экран или ошибку — при том что сайт полностью здоров, устарела только его вкладка.
 *
 * Здесь НЕТ автоматической перезагрузки, и это осознанно: чанк может не загрузиться и по
 * другой причине (сеть, прокси, оффлайн), а reload в такой ситуации уходит в бесконечный
 * цикл. Решение оставлено человеку — одна кнопка, один клик, никакого цикла.
 */

/** Ошибки именно «пропавшего чанка», а не любые сетевые. */
function isChunkError(value: unknown): boolean {
  const text =
    value instanceof Error
      ? `${value.name} ${value.message}`
      : typeof value === "string"
        ? value
        : "";
  if (!text) return false;
  return (
    /ChunkLoadError/i.test(text) ||
    /Loading chunk \S+ failed/i.test(text) ||
    /Loading CSS chunk/i.test(text) ||
    /(Failed to fetch|error loading) dynamically imported module/i.test(text) ||
    /Importing a module script failed/i.test(text)
  );
}

export function AppUpdatedBanner() {
  const [stale, setStale] = useState(false);

  useEffect(() => {
    const onError = (e: ErrorEvent) => {
      if (isChunkError(e.error) || isChunkError(e.message)) setStale(true);
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      if (isChunkError(e.reason)) setStale(true);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  if (!stale) return null;

  return (
    <div
      role="status"
      className="fixed inset-x-3 bottom-3 z-[100] mx-auto flex max-w-md flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-lg"
    >
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900">Сайт обновился</div>
        <div className="text-xs text-slate-500">Обновите страницу, чтобы продолжить.</div>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="ml-auto shrink-0 rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
      >
        Обновить страницу
      </button>
    </div>
  );
}
