import type { ReactNode } from "react";
import { Lora } from "next/font/google";

/**
 * Минимальный layout печати — БЕЗ sidebar/header/навигации dashboard (маршрут вне /dashboard).
 * Страница динамическая и авторизуемая (cookies) → ответ отдаётся как private/no-store.
 * Шрифт открыток — Lora (self-hosted next/font), доступен через CSS-переменную --font-lora.
 */
export const dynamic = "force-dynamic";
export const metadata = { title: "Печать открыток", robots: { index: false, follow: false } };

const lora = Lora({ subsets: ["latin", "cyrillic"], variable: "--font-lora", display: "swap" });

export default function PrintLayout({ children }: { children: ReactNode }) {
  return <div className={lora.variable}>{children}</div>;
}
