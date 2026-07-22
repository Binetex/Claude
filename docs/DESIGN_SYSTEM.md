# Floremart — Design System

Единый визуальный язык дашборда. Собран из фактических примитивов (`src/components/ui/*`)
и семантики статусов (`src/lib/statuses.ts`). Цель — консистентность и отсутствие ad-hoc
разметки. Стек: Tailwind v4 + cva + Radix. Палитра — `slate` (нейтраль) + семантические тона.

## 1. Токены

### Цветовые тона статусов (семантика, не «радуга»)
Определены в `lib/statuses.ts`:
| Тон | Значение | Класс |
|---|---|---|
| neutral | покой/ожидание | `bg-slate-100 text-slate-600 border-slate-200` |
| info | в работе | `bg-blue-50 text-blue-700 border-blue-200` |
| success | готово/доставлено | `bg-emerald-50 text-emerald-700 border-emerald-200` |
| danger | проблема | `bg-red-50 text-red-700 border-red-200` |

> Долг: часть карт статусов (`paymentStatusMeta`, `assignmentStatusMeta` и т.д.) использует
> собственные цвета вместо этих 4 тонов. Унификацию делать с визуальной проверкой (backlog D).

### Радиусы
`rounded` (бейджи-пиллы), `rounded-lg` (кнопки/инпуты), `rounded-xl` (карточки).

### Типографика (шкала, как используется)
- Заголовки секций: `text-sm font-semibold text-slate-700` (см. `CardTitle`).
- Тело: `text-sm text-slate-700`.
- Вторичный/мета: `text-xs` / `text-[11px]` / `text-[10px] text-slate-400`.
- Плотные таблицы заказов используют мелкие размеры (`text-[12px]`/`text-[13px]`) осознанно —
  ради плотности данных. Новые экраны — от `text-sm`.

### Отступы
Вертикальные ритмы секций: `space-y-4` (страница), `space-y-3`/`space-y-2.5` (списки),
`gap-1.5`/`gap-2` (внутри карточек). Карточка: `p-4` (десктоп), `p-2.5` (мобайл).

## 2. Примитивы (`src/components/ui/`)

| Компонент | Файл | Назначение |
|---|---|---|
| `Button` (+`buttonVariants`) | `button.tsx` | cva-варианты: default/secondary/outline/ghost/destructive/link; размеры sm/default/lg/icon/iconSm. Единое фокус-кольцо. |
| `Badge` | `Badge.tsx` | пилюля-бейдж; цвет задаётся `className` из статус-карт. |
| `Card`/`CardHeader`/`CardTitle`/`CardBody` | `Card.tsx` | контейнеры. |
| `Input`/`Textarea`/`Label`/`Select` | `input.tsx`/`textarea.tsx`/`label.tsx`/`select.tsx` | формы. |
| `Dialog` | `dialog.tsx` | модал (Radix). |
| `ConfirmDialog` | `confirm-dialog.tsx` | подтверждение опасных действий. |
| `Tooltip` | `tooltip.tsx` | подсказки (Radix). |
| `PageHeader` и пр. | `misc.tsx` | заголовок страницы. |
| **`EmptyState`/`ErrorState`/`LoadingState`/`Spinner`/`Skeleton`** | `states.tsx` 🆕 | единые состояния списков. |
| Status badges | `components/StatusBadge.tsx` | `OrderStatusBadge`/`PaymentStatusBadge`/… поверх `Badge` + статус-карт. |

### Toast
Инфраструктура тостов — библиотека `sonner` (в зависимостях). Использовать её единый
`<Toaster/>` и `toast(...)` для обратной связи по действиям, без самодельных уведомлений.

## 3. Состояния (обязательны для списков/детали)
Каждый список/секция с данными должен обрабатывать три состояния через примитивы `states.tsx`:
- **empty** — `EmptyState` (заголовок + опционально иконка/описание/действие);
- **error** — `ErrorState` (роль `alert`, красный тон);
- **loading** — `LoadingState`/`Skeleton`/`Spinner`.

Пример адаптации: `OrdersTable` пустое состояние переведено на `EmptyState` (устранён дубль
desktop/mobile), текст и вид сохранены.

## 4. Правила
- Не вводить ad-hoc цвета статусов — только тона из `lib/statuses.ts`.
- Кнопки — только через `Button`/`buttonVariants` (единые высоты и фокус).
- Иконочные кнопки обязаны иметь `aria-label` (см. accessibility-reviewer).
- Новые экраны — от `text-sm`; мелкие размеры только для осознанно плотных таблиц.
- Мобильные карточки: проверять 375/390/430px, без горизонтального скролла, тач-таргеты ≥44px.
- Роль-видимость сохраняется на уровне сериализаторов — UI не должен «дорисовывать» скрытые данные.

## 5. Не сделано ночью (визуальная проверка заблокирована)
Полный визуальный рефактор Orders/Order details/«Сегодня нужно купить»/мобильных карточек
требует запущенного приложения с БД, что ночью недоступно (нет локальной БД, prod-БД запрещена).
Выполнены только безопасные, статически проверяемые изменения (примитивы + DRY пустого состояния).
Визуальный проход — утром на локальной/тестовой БД (см. `AUTONOMOUS_REFACTOR_REPORT.md`).
