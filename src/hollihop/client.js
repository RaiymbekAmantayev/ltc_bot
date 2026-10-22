import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../utils/sleep.js';

const BASE = `https://${config.hh.subdomain}.t8s.ru/Api/V2`;

/**
 * Вызов HolliHop API 2.0. Лимит API: 600 запросов / 30 сек.
 * При "Requests limit is exceeded" ждём 31 сек и повторяем.
 */
export async function hh(fn, params = {}, { retries = 4, timeoutMs = 60_000 } = {}) {
  const body = { authkey: config.hh.authKey };
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) body[k] = v;
  }

  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${BASE}/${fn}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`HolliHop ${fn}: ответ не JSON (HTTP ${res.status})`);
      }
      if (data && data.Error) {
        const e = new Error(`HolliHop ${fn}: ${data.Error}`);
        e.fromApi = true;
        e.rateLimited = /limit is exceeded/i.test(data.Error);
        throw e;
      }
      return data;
    } catch (err) {
      // Ошибки API (неверный ключ/аргумент) не повторяем, лимиты и сетевые — повторяем
      const retryable = err.rateLimited || !err.fromApi;
      if (!retryable || attempt >= retries) throw err;
      const wait = err.rateLimited ? 31_000 : 1000 * 2 ** attempt;
      logger.warn({ fn, attempt, wait, err: err.message }, 'HolliHop: повтор запроса');
      await sleep(wait);
    } finally {
      clearTimeout(timer);
    }
  }
}
