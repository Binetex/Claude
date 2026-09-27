# Tasks: Планирование времени доставки

**Input**: Design documents from `specs/001-delivery-time-planning/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/

**Tests**: обязательны по конституции (принцип V) — тесты на примерах прода для каждого чистого модуля.

**Organization**: по историям. Порядок выполнения US1 → US3 → US2: разговору (US2) нужно расписание
(US3), поэтому US3 идёт раньше, хотя её приоритет ниже. Каждый этап выкатывается отдельно.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Setup

- [ ] T001 Добавить `Order.customerTime Json?` в prisma/schema.prisma и аддитивную миграцию prisma/migrations/20260928140000_order_customer_time/migration.sql
- [ ] T002 Проставить начало работы флористов (Настя 600, Ольга 720) скриптом scripts/set-florist-work-start.ts с сухим прогоном по умолчанию

---

## Phase 2: Foundational (блокирует все истории)

- [ ] T003 [P] Модель времени: типы, стартовые значения замера 28.09 (курьер p80 24; дорога p80 28/51/63/71/90/90 по корзинам 0–3/3–6/6–10/10–15/15–25/25+; сборка Настя 47/64, Ольга 43/63, общая 45/64), `computeModel`, `driveMin` (интерполяция между серединами корзин), `prepMin`, `setupMin` в src/modules/timing/model.ts
- [ ] T004 [P] Тесты модели на выборках прода (минимумы данных → стартовые значения; интерполяция дороги; разгон не меньше 0) в src/modules/timing/model.test.ts
- [ ] T005 Сбор выборок из Burq за 60 дней (SCHEDULED → PICKED_UP/IN_TRANSIT → deliveredAt, расстояние от точки забора до индекса; интервалы сборки; первый вызов в дни с 2+ утренними) и кэш на 6 часов в src/modules/timing/stats.ts
- [ ] T006 [P] Расписание: `planDay` (EDD по последнему моменту готовности, старт сегодня = max(начало, сейчас), другой день — раньше начала, если иначе не успеть, не раньше 6:00; фиксированные задания вне очереди), `canFit`, `earliestBy`; допуск 20 минут в src/modules/timing/planner.ts
- [ ] T007 [P] Тесты расписания: порядок по срокам, плановое время = сумма этапов, риск, «успеем ли» не портит чужие сроки, другой день разрешает раннее начало в src/modules/timing/planner.test.ts
- [ ] T008 Загрузка из БД: задания флориста на день (срок = время клиента «до», иначе конец окна; размер; дорога), `floristDayPlan`, `orderTiming`, `siteOutlook` в src/modules/timing/load.ts

**Checkpoint**: модель и расписание считаются и покрыты тестами.

---

## Phase 3: User Story 1 — Честная оценка времени (Priority: P1) 🎯 MVP

**Goal**: самое раннее время день в день — от начала работы флориста или «сейчас» по фактическим цифрам; заранее — без ограничения раннего часа.

**Independent Test**: у заказа на сегодня ИИ получает «Earliest possible delivery TODAY» = расчёт модели; на графике виден блок «Как считаем время».

- [ ] T009 [US1] Самое раннее время для заказа (morningForOrder/earliest) через модель и начало работы флориста вместо констант leadMinutes в src/modules/capacity/load.ts и src/modules/capacity/morning.ts
- [ ] T010 [US1] Ассистент: самое раннее время сегодня и допуск согласия из модели (приёмы есть в handler) в src/modules/assistant/handler.ts
- [ ] T011 [P] [US1] «Начинает работу» (выбор времени, шаг 30 минут) вместо «успевает к 15:00» в src/app/dashboard/(owner)/florists/MorningCapacityEditor.tsx → WorkStartEditor.tsx, floristActions.ts, page.tsx
- [ ] T012 [P] [US1] Блок «Как считаем время» (курьер, дорога по корзинам, сборка по флористам, по скольким доставкам) в src/app/dashboard/(owner)/schedule/page.tsx
- [ ] T013 [P] [US1] Бэктест модели на 60 днях (доля ошибок ≤ 15 мин, цель ≥ 70%) в scripts/timing-backtest.ts
- [ ] T014 [US1] Тесты, выкатка этапа 1, запуск бэктеста на проде, запись в CLAUDE.md

**Checkpoint**: US1 работает на проде.

---

## Phase 4: User Story 3 — Расписание флориста (Priority: P2)

**Goal**: очередь по срокам, плановое время и риск; вердикты утра для ИИ — из расписания; клетки убраны.

**Independent Test**: на графике у флориста очередь с плановым временем; заказ, не успевающий к сроку, помечен риском.

- [ ] T015 [US3] Вердикт утра для заказа и нового клиента из расписания (FIRST/AVAILABLE/FULL выводятся из earliestBy и начала очереди) в src/modules/capacity/load.ts (переезжает на timing/load)
- [ ] T016 [US3] График: карточка флориста показывает очередь (порядок, плановое время, срок, риск) вместо клеток; строка «новому клиенту» — из расписания в src/app/dashboard/(owner)/schedule/DayCard.tsx и page.tsx
- [ ] T017 [US3] Убрать баллы/клетки как второй источник правды (morningVerdict по баллам, orderPoints, capacity в loadDaySchedule) в src/modules/capacity/*
- [ ] T018 [US3] Тесты, браузер на тестовой базе, выкатка этапа 2, запись в CLAUDE.md

**Checkpoint**: US3 работает на проде; ИИ отвечает про утро по расписанию.

---

## Phase 5: User Story 2 — Разговор о времени (Priority: P1)

**Goal**: ИИ спрашивает крайний срок, подтверждает «до HH», спрашивает запасное время — по решению кода; время клиента хранится у заказа.

**Independent Test**: разбор «ready at 11» / «until 4» / «until 1» / «anytime» / «after 5» / «tomorrow at 9» даёт ходы из спецификации; окно и время клиента записаны.

- [ ] T019 [P] [US2] Время клиента: тип, разбор/сборка JSON (`from < until`, `altFrom < altUntil`, 0–1440, `day`), слияние в src/modules/timing/customerTime.ts
- [ ] T020 [P] [US2] Тесты времени клиента в src/modules/timing/customerTime.test.ts
- [ ] T021 [P] [US2] Извлечение времени (запрос к модели, строгий JSON по contracts/extract-time.md, ворота `mentionsTime`, проверка формата) в src/modules/assistant/extractTime.ts
- [ ] T022 [P] [US2] Тесты извлечения (разбор ответов модели, отказ на мусор) в src/modules/assistant/extractTime.test.ts
- [ ] T023 [P] [US2] Политика: `decideTime`, `agreeFromMin`, `windowAfter` по research R7 в src/modules/timing/policy.ts
- [ ] T024 [P] [US2] Тесты политики на сценариях спецификации US2 1–6 в src/modules/timing/policy.test.ts
- [ ] T025 [US2] Промпт: блок «TIME DECISION» (что сказать по решению) вместо вердиктов утра; извлечённое время не просим у основной модели в src/modules/assistant/prompt.ts
- [ ] T026 [US2] Оркестрация: извлечь → решить → ответить → проверить → записать окно и время клиента (только сторона заказа, не при вызванном курьере) в src/modules/assistant/handler.ts
- [ ] T027 [US2] Время клиента в карточке заказа (все роли) и под заказом на графике в src/components/orders/OrderPageShell.tsx, src/app/dashboard/(owner)/schedule/DayCard.tsx
- [ ] T028 [US2] Тесты, выкатка этапа 3, запись в CLAUDE.md

**Checkpoint**: все истории работают на проде.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T029 Убрать мёртвый код (старые правила про 16:00 там, где решает политика; leadMinutes-константы) и обновить тесты в src/modules/assistant/prompt.ts, src/modules/capacity/morning.ts
- [ ] T030 Полный прогон тестов, проверка на проде (только чтение): расписание на сегодня/завтра, решения на последних сообщениях из журнала
- [ ] T031 Итоговый отчёт владельцу и обновление памяти

---

## Dependencies & Execution Order

- Setup (T001–T002) → Foundational (T003–T008) → US1 (T009–T014) → US3 (T015–T018) → US2 (T019–T028) → Polish.
- US2 зависит от расписания (T006–T008) и вердиктов (T015).
- Внутри фаз [P] — разные файлы без зависимостей.

## Parallel Example: Foundational

```text
T003 model.ts  ∥  T006 planner.ts  ∥  T004/T007 тесты
```

## Implementation Strategy

MVP — US1 (честное самое раннее время), выкатывается первым. Каждый следующий этап выкатывается после
тестов и проверки в браузере; миграции только добавляют.
