// ПРИМЕР PM2-конфигурации для отдельного процесса outbox-worker (floremart-worker).
// НЕ применяется автоматически и НЕ заменяет рабочий ecosystem.config.js.
// Владелец решает, как включить: отдельным файлом (`pm2 start ecosystem.worker.example.js`)
// или добавив блок `apps[]` в основной ecosystem.config.js (см. предложенный diff в
// docs/OUTBOX_AND_WORKER.md). PM2 в этой сессии НЕ запускается.
//
// Порт воркеру не нужен (он не слушает HTTP). Условие react-server обязательно, чтобы
// server-only-модули (Prisma-слой) резолвились как серверные — как в других скриптах проекта.
module.exports = {
  apps: [
    {
      name: "floremart-worker",
      // tsx запускается НАПРЯМУЮ (interpreter: none) — его shebang сам поднимает node.
      // Так сигналы PM2 (SIGINT/SIGTERM) доходят прямо до процесса → graceful shutdown работает.
      script: "./node_modules/.bin/tsx",
      args: "scripts/outbox-worker.ts",
      interpreter: "none",
      cwd: __dirname,
      instances: 1, // ВАЖНО: один инстанс на очередь (lease защищает и от нескольких, но так проще)
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      // Graceful shutdown: PM2 шлёт SIGINT/SIGTERM → worker доводит текущий батч и выходит.
      kill_timeout: 10000, // дать батчу завершиться до SIGKILL
      env: {
        NODE_ENV: "production",
        // Условие react-server нужно, чтобы server-only-модули (Prisma-слой) резолвились
        // как серверные — так же, как в других скриптах проекта.
        NODE_OPTIONS: "--conditions=react-server",
        // DATABASE_URL берётся из окружения/.env — тот же, что у основного приложения.
        OUTBOX_BATCH_SIZE: "20",
        OUTBOX_POLL_MS: "1000",
        OUTBOX_STUCK_MS: "60000",
      },
      time: true,
      out_file: "./logs/worker-out.log",
      error_file: "./logs/worker-error.log",
      merge_logs: true,
    },
  ],
};
