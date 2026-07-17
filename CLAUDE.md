## Fast diagnostics

- Do not query production database for UI or data-mapping investigations unless explicitly requested.
- Do not read `.env` or execute ad-hoc database scripts without explicit approval.
- If a diagnostic command is blocked or fails once, do not retry it through alternative wrappers, temporary files, SSH, SCP, or different shells.
- After the first blocked diagnostic command, stop and explain what could not be verified.
- Prefer static code inspection, existing logs, API responses, and already available data.
- Do not create temporary diagnostic scripts unless explicitly requested.
- For small investigations, spend no more than 2 minutes on diagnostics before reporting the likely cause and proposed fix.

# Project rules

- Stack: Next.js, TypeScript, Prisma.
- Production deployment only after explicit user approval.
- Never commit secrets, tokens, credentials, private keys, or .env files.
- Do not modify deploy.sh, ecosystem.config.js, authentication, Prisma schema, migrations, production configuration, or infrastructure without explicit approval.
- For small UI tasks, inspect only directly relevant files.
- Do not scan or analyze the entire repository unless required.
- Do not refactor unrelated code.
- Do not fix unrelated issues without approval.
- Run targeted checks first.
- Run full build only before deployment, before a major merge, or after architecture, dependency, routing, database, or configuration changes.
- One task per commit.
- Do not push, merge, deploy, restart production services, or modify production data automatically.
- Read detailed documentation only when the current task requires it.

## Быстрый деплой (solo-dev)

- Для быстрых UI и обычных кодовых задач НЕ использовать GitHub в процессе деплоя.
- «Быстрый деплой» = запуск ./deploy-fast.sh (локальная рабочая папка → production напрямую).
- Не выполнять commit, push или обычный ./deploy.sh без отдельного запроса.
- Не запускать полный build после каждой мелкой правки — build выполняется один раз внутри быстрого деплоя.
- Для локальных UI-задач не читать docs/HANDOFF.md / docs/ARCHITECTURE.md, если задача этого не требует.
- Для простой задачи менять только напрямую связанные файлы, без несвязанного рефакторинга.
- Миграции Prisma на проде не применять автоматически: deploy-fast.sh при неприменённых миграциях останавливается и спрашивает подтверждение.

## Detailed documentation

- docs/HANDOFF.md — current project state and remaining work.
- docs/ARCHITECTURE.md — overall architecture.
- docs/integrations/shopify.md — Shopify integration.
- TODO.md — task backlog.

@AGENTS.md
