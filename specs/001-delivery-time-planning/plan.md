# Implementation Plan: Планирование времени доставки

**Branch**: `001-delivery-time-planning` (работа в `main`) | **Date**: 2026-09-28 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `specs/001-delivery-time-planning/spec.md`

## Summary

Прежние механизмы ЗАМЕНЯЮТСЯ, а не обрастают новыми слоями (владелец, 28.09.2026: «не городить
прослойки — исправь, как это изначально работало»):

1. **Модель времени** (`modules/timing/model.ts` + `stats.ts`) вместо констант `leadMinutes`
   (75/105/30/4 мин): длительности этапов из фактических доставок Burq за 60 дней — ожидание курьера
   и дорога по расстоянию с запасом (p80), сборка по размеру у каждого флориста (медиана), подготовка
   к первому букету дня; пересчёт на лету с кэшем на 6 часов; стартовые значения замера 28.09.2026.
2. **Расписание флориста** (`modules/timing/planner.ts` + `load.ts`) вместо баллов и клеток утра
   (`modules/capacity` удалён целиком): очередь по крайнему сроку (правило Джексона), плановое время
   доставки и риск; «самое раннее время» — минимальный срок, при котором заказ влезает, не сорвав
   остальным их сроки.
3. **Ассистент**: четыре набора правил про время (граница 16:00, вердикты утра, варианты для
   незнакомых номеров) заменены ОДНИМ правилом с одной цифрой «Earliest possible delivery». Модель
   ведёт разговор по сценарию владельца и отдаёт, что пообещала, полями `confirmed_from` /
   `confirmed_until`; код проверяет их по той же цифре и пишет окно заказа (`assistant/reschedule.ts`
   — прежний разбор слов клиента `laterWindowFromWish` удалён).

## Technical Context

**Language/Version**: TypeScript 5, Node 24
**Primary Dependencies**: Next.js (App Router, server actions), Prisma 7, DeepSeek (`deepseek-reasoner`)
**Storage**: PostgreSQL — новых колонок нет (`Florist.workStartMin` добавлен 28.09 раньше; `Florist.morningCapacity` больше не читается, колонка снимается отдельно)
**Testing**: vitest (чистые модули — юнит-тесты), браузер на `floremart_uitest`, сверка с фактом `scripts/timing-backtest.ts`
**Target Platform**: сервер Linux (PM2: `floremart` + `floremart-worker`), дашборд в браузере
**Project Type**: web-приложение (монорепо Next.js, модули в `src/modules`)
**Performance Goals**: расписание дня < 50 мс; статистика — раз в 6 часов на процесс
**Constraints**: клиенту только английский; ни одного согласия раньше расчётного; миграции только добавляют
**Scale/Scope**: 6 магазинов, 2–3 флориста, до ~15 заказов на флориста в день, ~400 доставок за 60 дней

## Constitution Check

| Принцип | Как соблюдается |
|---|---|
| I. Молчание безопаснее | Нет флориста — модель получает осторожное «4 PM (estimate)»; ответ, согласный раньше расчётного, уходит человеку; посторонний номер и вызванный курьер заказ не двигают |
| II. Решает код | «Успеем ли» и самое раннее время считает расписание; проверка ответа — код; окно заказа пишет код |
| III. Одна правда | Загрузка — только расписание (баллы удалены); окно — `windowOf`; обещанное клиенту = окно заказа |
| IV. Простота | Минус модуль `capacity`, минус 3 набора правил; без таблицы статистики, без второго запроса к модели, без новых колонок |
| V. Проверено | Юнит-тесты модели, расписания, правила и разбора ответа; браузер; сверка с фактом на проде |
| VI. Решения записаны | Константы с комментариями о решении владельца; CLAUDE.md обновлён |

## Project Structure

```text
src/lib/deliveryWindow.ts            # (было) окно «с — до»
src/modules/timing/
├── model.ts / model.test.ts         # чистый: TimeModel, стартовые значения, расчёт из выборок
├── stats.ts                         # server-only: выборки Burq → TimeModel, кэш 6 ч
├── planner.ts / planner.test.ts     # чистый: planDay, canFit, earliestBy
├── day.ts / day.test.ts             # чистый: размер букета, допуск опоздания, подписи времени
└── load.ts                          # server-only: orderEarliest, siteEarliest, loadDaySchedule
src/modules/assistant/
├── prompt.ts                        # одно правило времени, agreeFromMin, confirmed_from/until
├── reschedule.ts                    # confirmedWindow, planReschedule (день и окно по обещанному)
└── handler.ts                       # цифра из timing/load → запрос → проверка → окно заказа
src/app/dashboard/(owner)/schedule/  # очередь флориста, плановое время, риск, «Как считаем время»
src/app/dashboard/(owner)/florists/  # «Начинает работу в» (WorkStartEditor)
scripts/set-florist-work-start.ts    # разово: Настя 10:00, Ольга 12:00
scripts/timing-backtest.ts           # сверка расписания с фактом (только чтение)
```

## Этапы выкатки

Одна выкатка: модель, расписание и ассистент зависят друг от друга, а старый модуль удаляется целиком.
После — `set-florist-work-start.ts --apply` и сверка `timing-backtest.ts` на проде.

## Complexity Tracking

Отступлений нет. Прежний план (отдельный запрос «извлеки время», модуль политики, колонка
`Order.customerTime`) отменён владельцем как лишние слои.
