<?php
/**
 * Plugin Name: Floremart — замки дня
 * Description: Закрывает доставку в дни, закрытые замком в «Графике доставки» Floremart: утро (до 15:00), всё до вечера (до 18:00) или весь день.
 *
 * Ставится в wp-content/mu-plugins/ сайтов с плагином доставки PI (TheFlow, JF). Источник —
 * https://floremart.com/api/public/morning-closures: `openFrom` — с какой минуты день открыт
 * (null — закрыт целиком). Ответ кэшируется на 2 минуты. Floremart недоступен — ничего не
 * закрываем (сайт работает как обычно).
 * Лимит «4 заказа на утренний слот» живёт отдельно, в настройках самого плагина доставки.
 */
if (!defined('ABSPATH')) exit;

/** День «YYYY-MM-DD» → с какой минуты открыт (null — закрыт целиком). Дней без замка нет. */
function floremart_day_closures() {
    $cached = get_transient('floremart_day_closures');
    if (is_array($cached)) return $cached;
    $closures = array();
    $res = wp_remote_get('https://floremart.com/api/public/morning-closures', array('timeout' => 3));
    if (!is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200) {
        $body = json_decode(wp_remote_retrieve_body($res), true);
        if (is_array($body) && isset($body['openFrom']) && is_array($body['openFrom'])) {
            $closures = $body['openFrom'];
        } elseif (is_array($body) && isset($body['days']) && is_array($body['days'])) {
            // Прежний ответ Floremart знал только утренние замки.
            foreach ($body['days'] as $day) $closures[$day] = 15 * 60;
        }
        set_transient('floremart_day_closures', $closures, 2 * MINUTE_IN_SECONDS);
    } else {
        // Ошибку кэшируем коротко, чтобы не держать каждый показ чекаута в ожидании таймаута.
        set_transient('floremart_day_closures', $closures, MINUTE_IN_SECONDS);
    }
    return $closures;
}

/** Дата плагина «2026/09/30» → «2026-09-30». */
function floremart_day_key($date) {
    return str_replace('/', '-', (string)$date);
}

/** Начало слота «11:00 AM» или «15:00» → минуты от полуночи; не разобрали — null. */
function floremart_slot_start_min($slot) {
    $from = is_array($slot) ? trim((string)($slot['from'] ?? '')) : '';
    if ($from === '') return null;
    $t = strtotime('1970-01-01 ' . $from . ' UTC');
    return $t === false ? null : intdiv($t % 86400, 60);
}

// Слот, который начинается раньше, чем день открыт, — лимит 0: плагин понимает его как «слот
// недоступен» (class-time-slot.php::removeOrderFilledSlots). День закрыт целиком — все слоты.
add_filter('pisol_dtt_time_slot_order_limit_filter', function ($limit, $slot, $date) {
    $closures = floremart_day_closures();
    $day = floremart_day_key($date);
    if (!array_key_exists($day, $closures)) return $limit;
    if ($closures[$day] === null) return 0;
    $start = floremart_slot_start_min($slot);
    return ($start !== null && $start < (int)$closures[$day]) ? 0 : $limit;
}, 10, 3);

// День закрыт целиком — его нет в календаре: ни при выборе даты, ни при проверке заказа
// (class-date.php применяет этот фильтр в обоих местах, для доставки и для самовывоза).
add_filter('pisol_valid_dates', function ($dates, $type = null) {
    if (!is_array($dates)) return $dates;
    $closures = floremart_day_closures();
    return array_values(array_filter($dates, function ($d) use ($closures) {
        $day = floremart_day_key($d);
        return !(array_key_exists($day, $closures) && $closures[$day] === null);
    }));
}, 10, 2);
