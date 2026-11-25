import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Attendance API кабинета (только чтение): GET /attendance-api/v1/lessons — журнал уроков «ученик × отметка».
 * Ключ — ATTENDANCE_API_KEY (X-Api-Key), адрес — ATTENDANCE_API_URL (по умолчанию LTC_API_URL).
 */
export class AttendanceError extends Error {}

export const attendanceConfigured = () => Boolean(config.lessonReports.url && config.lessonReports.key);

const PAGE_LIMIT = 500;
const MAX_PAGES = 200; // предохранитель от бесконечного курсора

async function getJson(path, params, timeoutMs = 30_000) {
  const url = new URL(`${config.lessonReports.url}${path}`);
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'X-Api-Key': config.lessonReports.key, Accept: 'application/json' }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* не JSON */ }
    if (!res.ok) throw new AttendanceError(`Attendance API: HTTP ${res.status}${data?.error ? ` (${data.error})` : ''}`);
    if (!data) throw new AttendanceError('Attendance API: ответ не JSON');
    return data;
  } catch (err) {
    if (err instanceof AttendanceError) throw err;
    throw new AttendanceError(err.name === 'AbortError' ? 'Attendance API: нет ответа (таймаут)' : `Attendance API: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Все записи журнала, созданные или исправленные начиная с updatedSince (Date), с уроками не раньше dateFrom (YYYY-MM-DD).
 * dateFrom заодно сужает выборку в кабинете индексом по lesson_date.
 */
export async function fetchLessons({ updatedSince, dateFrom }) {
  if (!attendanceConfigured()) throw new AttendanceError('Attendance API не настроен: задайте ATTENDANCE_API_KEY и ATTENDANCE_API_URL/LTC_API_URL.');
  const out = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await getJson('/attendance-api/v1/lessons', {
      updated_since: updatedSince.toISOString(), date_from: dateFrom, limit: PAGE_LIMIT, cursor,
    });
    out.push(...(Array.isArray(data.data) ? data.data : []));
    cursor = data.page?.has_more ? data.page.next_cursor : null;
    if (!cursor) return out;
  }
  // окно не сдвигаем — иначе остаток потеряется; на практике за 15 минут столько записей не бывает
  logger.warn({ pages: MAX_PAGES, records: out.length }, 'Attendance API: слишком много страниц');
  throw new AttendanceError('Attendance API: превышено число страниц');
}
