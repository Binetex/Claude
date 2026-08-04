import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // Каталог сборки. По умолчанию `.next`, но деплой собирает новую версию В СТОРОНЕ
  // (NEXT_DIST_DIR=.next.build) и подменяет каталог только после успешной сборки.
  //
  // Зачем: `next start` читает страницы и JS-чанки с диска ПО МЕРЕ НАДОБНОСТИ, а не держит
  // всё в памяти. Пока сборка шла поверх боевого `.next`, работающий сервер терял свои файлы
  // на всё время сборки — полторы минуты «Failed to load chunk» и белых экранов у флористов.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // Явно фиксируем корень проекта (в системе есть другой lockfile выше по дереву).
  turbopack: {
    root: path.resolve(__dirname),
  },
  experimental: {
    serverActions: {
      // По умолчанию 1MB — фото букета с телефона (data URL) почти всегда больше и
      // ловило "Body exceeded 1 MB limit". Клиент уже сжимает фото перед отправкой
      // (см. FloristOrderActions.tsx), но оставляем запас на нетипично крупные снимки.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
