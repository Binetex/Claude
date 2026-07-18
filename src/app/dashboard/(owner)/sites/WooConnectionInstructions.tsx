"use client";
/** Пошаговая инструкция владельцу: где взять Consumer Key/Secret в WooCommerce. */
export function WooConnectionInstructions() {
  return (
    <details className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
      <summary className="cursor-pointer font-medium text-slate-700">Как получить Consumer Key и Secret в WooCommerce</summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5">
        <li>Откройте WordPress Admin.</li>
        <li>Перейдите: WooCommerce → Settings → Advanced → REST API.</li>
        <li>Нажмите «Add key».</li>
        <li>Укажите описание: <code>Floremart</code>.</li>
        <li>Выберите пользователя с нужными правами.</li>
        <li>Установите Permissions: <b>Read/Write</b>.</li>
        <li>Сгенерируйте ключ.</li>
        <li>Скопируйте Consumer Key и Consumer Secret.</li>
        <li>Вставьте их во Floremart (поля ниже).</li>
        <li>Нажмите «Проверить подключение».</li>
      </ol>
      <p className="mt-2 rounded-md bg-amber-50 p-2 text-amber-800">
        ⚠️ Consumer Secret показывается WooCommerce <b>только при создании</b>. Сохраните его сразу — позже его нельзя посмотреть.
      </p>
    </details>
  );
}
