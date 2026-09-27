# Tasks: Планирование времени доставки

**Input**: Design documents from `specs/001-delivery-time-planning/`

Первоначальный список (извлечение времени отдельным запросом, модуль политики, колонка
`Order.customerTime`) пересмотрен 28.09.2026 по указанию владельца «не городить прослойки» — ниже
выполненный список. Одна выкатка: модель, расписание и ассистент зависят друг от друга.

## Phase 1: Setup

- [x] T001 Начало работы флористов: `Florist.workStartMin` (миграция 20260928120000) и разовый scripts/set-florist-work-start.ts (сухой прогон по умолчанию)

## Phase 2: Foundational

- [x] T002 [P] Модель времени и стартовые значения замера 28.09 в src/modules/timing/model.ts (+ model.test.ts)
- [x] T003 Выборки Burq за 60 дней и кэш 6 ч в src/modules/timing/stats.ts
- [x] T004 [P] Расписание: planDay, canFit, earliestBy в src/modules/timing/planner.ts (+ planner.test.ts)
- [x] T005 Помощники дня (размер букета, допуск 20 мин, подписи) в src/modules/timing/day.ts (+ day.test.ts)
- [x] T006 Загрузка из БД: orderEarliest, siteEarliest, loadDaySchedule в src/modules/timing/load.ts

## Phase 3: US1 + US3 — честное время и расписание

- [x] T007 График: очередь флориста, плановое время, риск, «Новый заказ — к», ранний старт, «Как считаем время» в src/app/dashboard/(owner)/schedule/*
- [x] T008 «Начинает работу в» вместо «успевает к 15:00» в src/app/dashboard/(owner)/florists/WorkStartEditor.tsx, floristActions.ts, page.tsx
- [x] T009 Удалить src/modules/capacity целиком (баллы, вердикты, leadMinutes) — заменён расписанием

## Phase 4: US2 — разговор о времени

- [x] T010 Одно правило времени с цифрой «Earliest possible delivery» вместо четырёх наборов; поля confirmed_from/until; проверка по минутам в src/modules/assistant/prompt.ts (+ prompt.test.ts)
- [x] T011 Окно заказа по обещанному (confirmedWindow, planReschedule) вместо разбора слов клиента в src/modules/assistant/reschedule.ts (+ reschedule.test.ts)
- [x] T012 Обработчик: цифра из timing/load, проверка, запись окна (только сторона заказа, не при вызванном курьере) в src/modules/assistant/handler.ts

## Phase 5: Проверка и выкатка

- [x] T013 Сверка расписания с фактом scripts/timing-backtest.ts
- [x] T014 Полный прогон тестов, сборка, браузер на floremart_uitest
- [x] T015 Выкатка, set-florist-work-start --apply на проде, сверка на проде (только чтение); живой прогон обработчика на floremart_uitest с подменённой моделью
- [ ] T016 CLAUDE.md, память, отчёт владельцу
