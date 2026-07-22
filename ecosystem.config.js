// PM2 конфигурация для floremart.com.
// Порт НЕ должен пересекаться с другими сайтами на этом VPS — проверьте
// свободные порты перед первым запуском (см. README-deploy.md).
module.exports = {
  apps: [
    {
      name: "floremart",
      script: "./node_modules/.bin/next",
      args: "start",
      cwd: __dirname,
      // Явно фиксируем интерпретатор Node (nvm-окружение сайта), чтобы PM2
      // резолвил его правильно даже без PATH из интерактивной shell-сессии
      // (например, после `pm2 resurrect` при перезагрузке сервера).
      interpreter: process.execPath,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
        PORT: 3010,
      },
      time: true,
      out_file: "./logs/out.log",
      error_file: "./logs/error.log",
      merge_logs: true,
    },
  ],
};
