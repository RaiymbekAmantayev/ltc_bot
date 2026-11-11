import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * LTC Integration API (сервис менторов):
 *  - GET  /integration-api/absences?from&to          — ученики с пропусками за период и их обратная связь;
 *  - POST /integration-api/absence-feedback           — статус и причина пропуска (запись целиком, до 1000 за раз).
 * Ключ — INTEGRATION_KEY (заголовок X-Api-Key), адрес — LTC_API_URL.
 */
export class LtcError extends Error {}

const CACHE_TTL = 5 * 60 * 1000;
const cache = new Map(); // `${from}|${to}` -> { at, data, pending }

export const ltcConfigured = () => Boolean(config.ltc.url && config.ltc.key);

async function call(method, path, { params, body, timeoutMs = 90_000 } = {}) {
  if (!ltcConfigured()) throw new LtcError('LTC API не настроен: задайте LTC_API_URL и INTEGRATION_KEY в .env.');
  const url = new URL(`${config.ltc.url}${path}`);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-Api-Key': config.ltc.key, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* не JSON */ }
    if (!res.ok) {
      logger.warn({ path, status: res.status, error: data?.error, errors: data?.errors }, 'LTC API: ошибка');
      if (res.status === 401) throw new LtcError('LTC отклонил ключ интеграции (401) — проверьте INTEGRATION_KEY.');
      if (res.status === 429) throw new LtcError('LTC: слишком много запросов — попробуйте через минуту.');
      if (res.status === 400) throw new LtcError(`LTC отклонил запрос: ${data?.error || 'неверные данные'}${data?.errors ? ` (${data.errors.map((e) => e.field).join(', ')})` : ''}.`);
      throw new LtcError(`LTC временно недоступен (HTTP ${res.status}) — попробуйте позже.`);
    }
    if (!data) throw new LtcError('LTC вернул ответ не в формате JSON.');
    return data;
  } catch (err) {
    if (err instanceof LtcError) throw err;
    logger.warn({ path, err: err.message }, 'LTC API: нет ответа');
    throw new LtcError(err.name === 'AbortError' ? 'LTC не ответил вовремя — попробуйте ещё раз.' : 'Не удалось связаться с LTC — попробуйте позже.');
  } finally {
    clearTimeout(timer);
  }
}

/** Ученики с пропусками за период (кэш 5 минут; ответ LTC строится несколько секунд). */
export async function getAbsences(from, to, { refresh = false } = {}) {
  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (!refresh && hit?.data && Date.now() - hit.at < CACHE_TTL) return hit.data;
  if (hit?.pending) return hit.pending;
  const pending = call('GET', '/integration-api/absences', { params: { from, to } })
    .then((data) => {
      cache.set(key, { at: Date.now(), data });
      return data;
    })
    .catch((err) => {
      if (cache.get(key)?.pending === pending) cache.delete(key);
      throw err;
    });
  cache.set(key, { ...(hit || {}), pending });
  return pending;
}

/**
 * Отправить обратную связь по одному ученику за период. LTC перезаписывает запись целиком,
 * поэтому передаём все поля. После успеха обновляем кэш выгрузки, чтобы список сразу показал новый статус.
 */
export async function sendFeedback(item) {
  await call('POST', '/integration-api/absence-feedback', { body: [item], timeoutMs: 30_000 });
  const hit = cache.get(`${item.period.from}|${item.period.to}`);
  const st = hit?.data?.students?.find((x) => String(x.studentId) === String(item.studentId));
  if (st) {
    // так же, как LTC отдаст эту запись в выгрузке: пустой текст — null, время — UTC без миллисекунд
    const textOf = (v) => (v == null ? null : String(v).trim() || null);
    st.feedback = {
      status: textOf(item.status),
      reason: textOf(item.reason),
      mentor: textOf(item.mentor),
      period: { from: item.period.from, to: item.period.to },
      feedbackAt: `${new Date(item.feedbackAt).toISOString().slice(0, 19)}Z`,
    };
  }
}
