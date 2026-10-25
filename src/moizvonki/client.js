import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../utils/sleep.js';

const PAGE = 500; // больше 500 за запрос API «Мои звонки» не отдаёт

/** Вызов API «Мои звонки» (POST JSON с user_name/api_key/action). */
async function mz(action, params = {}, { retries = 3, timeoutMs = 60_000 } = {}) {
  const { url, user, apiKey } = config.moizvonki;
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json;charset=utf-8' },
        body: JSON.stringify({ user_name: user, api_key: apiKey, action, ...params }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Мои звонки ${action}: HTTP ${res.status} ${text.slice(0, 200)}`);
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`Мои звонки ${action}: ответ не JSON`);
      }
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = 1000 * 2 ** attempt;
      logger.warn({ action, attempt, wait, err: err.message }, 'Мои звонки: повтор запроса');
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}

export const isMoiZvonkiConfigured = () => Boolean(config.moizvonki.url && config.moizvonki.user && config.moizvonki.apiKey);

/** Все звонки компании (supervised) начиная с fromTs (unix, сек). */
export async function listCalls(fromTs, toTs = Math.floor(Date.now() / 1000)) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const data = await mz('calls.list', { from_date: fromTs, to_date: toTs, supervised: 1, max_results: PAGE, from_offset: offset });
    const list = data.results || [];
    out.push(...list);
    if (list.length < PAGE || !data.results_remains) return out;
  }
}
