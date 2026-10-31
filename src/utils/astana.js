/**
 * Время в веб-админке показываем и фильтруем по Астане (UTC+5).
 * DATETIME-колонки с DEFAULT CURRENT_TIMESTAMP пишутся в часовом поясе сессии MySQL;
 * DB_SHIFT — на сколько секунд он отличается от Астаны.
 */
const ASTANA_SEC = 5 * 3600;
const DB_SHIFT = `(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) - ${ASTANA_SEC})`;
/** SQL: время Астаны (выражение) → время БД. */
export const toDbTime = (expr) => `DATE_ADD(${expr}, INTERVAL ${DB_SHIFT} SECOND)`;
/** SQL: колонка времени БД → строка «дд.мм.гггг чч:мм» по Астане. */
export const astanaFmt = (col) => `DATE_FORMAT(DATE_SUB(${col}, INTERVAL ${DB_SHIFT} SECOND), '%d.%m.%Y %H:%i')`;
