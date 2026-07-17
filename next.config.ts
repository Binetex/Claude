import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
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
