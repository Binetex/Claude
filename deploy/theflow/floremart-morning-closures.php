<?php
/**
 * Plugin Name: Floremart — утро закрыто
 * Description: Прячет утренний слот доставки (11:00–15:00) в дни, закрытые замком в «Графике доставки» Floremart.
 *
 * Ставится в wp-content/mu-plugins/ сайта TheFlow. Источник — https://floremart.com/api/public/morning-closures.
 * Ответ кэшируется на 2 минуты. Floremart недоступен — ничего не закрываем (сайт работает как обычно).
 * Лимит «4 заказа на утренний слот» живёт отдельно, в настройках самого плагина доставки.
 */
if (!defined('ABSPATH')) exit;

function floremart_closed_morning_days() {
    $cached = get_transient('floremart_morning_closures');
    if (is_array($cached)) return $cached;
    $days = array();
    $res = wp_remote_get('https://floremart.com/api/public/morning-closures', array('timeout' => 3));
    if (!is_wp_error($res) && wp_remote_retrieve_response_code($res) === 200) {
        $body = json_decode(wp_remote_retrieve_body($res), true);
        if (is_array($body) && isset($body['days']) && is_array($body['days'])) $days = $body['days'];
        set_transient('floremart_morning_closures', $days, 2 * MINUTE_IN_SECONDS);
    } else {
        // Ошибку кэшируем коротко, чтобы не держать каждый показ чекаута в ожидании таймаута.
        set_transient('floremart_morning_closures', $days, MINUTE_IN_SECONDS);
    }
    return $days;
}

// Лимит 0 плагин понимает как «слот недоступен» (class-time-slot.php::removeOrderFilledSlots).
add_filter('pisol_dtt_time_slot_order_limit_filter', function ($limit, $slot, $date) {
    if (!is_array($slot) || strpos((string)($slot['from'] ?? ''), '11:00') !== 0) return $limit;
    $day = str_replace('/', '-', (string)$date);
    return in_array($day, floremart_closed_morning_days(), true) ? 0 : $limit;
}, 10, 3);
