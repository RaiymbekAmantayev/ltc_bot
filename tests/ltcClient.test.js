// Клиент LTC Integration API (src/ltc/client.js) против заглушки LTC: запросы, кэш, ошибки.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const P = { from: '2026-09-01', to: '2026-09-30' };
const stub = { mode: 'ok', requests: [], hang: false };
const student = () => ({ studentId: '801', student: 'Аня', groups: [{ id: '81', name: 'G81' }], group: 'G81', lessons: 3, absent: 2, rate: 0.6667, feedback: null });

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    stub.requests.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
    if (stub.mode === 'hang') return;
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (stub.mode === 'html') return send(200, '<html>nginx</html>', 'text/html');
    if (stub.mode !== 'ok') return send(Number(stub.mode), stub.mode === '400' ? { error: 'bad_items', errors: [{ index: 0, field: 'studentId' }, { index: 0, field: 'feedbackAt' }] } : { error: 'x' });
    const u = new URL(req.url, 'http://x');
    if (req.method === 'GET') return send(200, { from: u.searchParams.get('from'), to: u.searchParams.get('to'), total: 1, students: [student()] });
    return send(200, { ok: 1, saved: JSON.parse(body).length });
  });
});

let ltc, config;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    LTC_API_URL: `http://127.0.0.1:${server.address().port}/`, INTEGRATION_KEY: 'test-key',
    BOT_TOKEN: process.env.BOT_TOKEN || '1:x', DB_USER: process.env.DB_USER || 'x', DB_NAME: process.env.DB_NAME || 'x',
    HH_SUBDOMAIN: process.env.HH_SUBDOMAIN || 'x', HH_AUTH_KEY: process.env.HH_AUTH_KEY || 'x', LOG_LEVEL: 'silent',
  });
  ({ config } = await import('../src/config.js'));
  config.ltc.url = `http://127.0.0.1:${server.address().port}`;   // .env проекта мог задать свой адрес
  config.ltc.key = 'test-key';
  ltc = await import('../src/ltc/client.js');
});
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { stub.mode = 'ok'; stub.requests = []; });

let n = 0;
const fresh = () => ({ from: P.from, to: `2026-10-${String(++n).padStart(2, '0')}` });   // свой период — свой ключ кэша

test('GET /integration-api/absences: параметры from/to и заголовок X-Api-Key', async () => {
  const p = fresh();
  const data = await ltc.getAbsences(p.from, p.to);
  assert.equal(data.students[0].studentId, '801');
  const [r] = stub.requests;
  assert.equal(r.method, 'GET');
  assert.equal(r.url, `/integration-api/absences?from=${p.from}&to=${p.to}`);
  assert.equal(r.headers['x-api-key'], 'test-key');
});

test('кэш: повтор из кэша, refresh — в сеть, параллельные запросы схлопываются, ошибка не кэшируется', async () => {
  const p = fresh();
  await ltc.getAbsences(p.from, p.to);
  await ltc.getAbsences(p.from, p.to);
  assert.equal(stub.requests.length, 1);
  await ltc.getAbsences(p.from, p.to, { refresh: true });
  assert.equal(stub.requests.length, 2);
  const q = fresh();
  const [a, b] = await Promise.all([ltc.getAbsences(q.from, q.to), ltc.getAbsences(q.from, q.to)]);
  assert.equal(stub.requests.length, 3);
  assert.equal(a, b);
  const e = fresh();
  stub.mode = '500';
  await assert.rejects(ltc.getAbsences(e.from, e.to));
  stub.mode = 'ok';
  assert.equal((await ltc.getAbsences(e.from, e.to)).total, 1);
});

test('POST /integration-api/absence-feedback: массив из одной записи с JSON Content-Type', async () => {
  const item = { studentId: '801', period: P, status: 'Связались', reason: 'Болел(а)', mentor: 'М', feedbackAt: '2026-10-02T10:00:00Z' };
  await ltc.sendFeedback(item);
  const [r] = stub.requests;
  assert.deepEqual([r.method, r.url, r.headers['content-type'], r.headers['x-api-key']], ['POST', '/integration-api/absence-feedback', 'application/json', 'test-key']);
  assert.deepEqual(r.body, [item]);
});

test('sendFeedback обновляет кэш так же, как LTC отдаст запись (пустой текст — null, UTC без миллисекунд)', async () => {
  const p = fresh();
  await ltc.getAbsences(p.from, p.to);
  await ltc.sendFeedback({ studentId: 801, period: p, status: 'Рассылка ушла', reason: '', mentor: ' М ', feedbackAt: '2026-10-02T15:00:00.123+05:00' });
  const fb = (await ltc.getAbsences(p.from, p.to)).students[0].feedback;
  assert.deepEqual(fb, { status: 'Рассылка ушла', reason: null, mentor: 'М', period: p, feedbackAt: '2026-10-02T10:00:00Z' });
  assert.equal(stub.requests.length, 2, 'кэш обновлён без повторного GET');
});

test('ошибки LTC → LtcError с понятным текстом', async () => {
  const cases = [['401', /проверьте INTEGRATION_KEY/], ['429', /слишком много запросов/], ['400', /bad_items \(studentId, feedbackAt\)/],
    ['413', /HTTP 413/], ['500', /временно недоступен \(HTTP 500\)/], ['502', /HTTP 502/], ['html', /не в формате JSON/]];
  for (const [mode, re] of cases) {
    stub.mode = mode;
    const p = fresh();
    await assert.rejects(ltc.getAbsences(p.from, p.to), (e) => e instanceof ltc.LtcError && re.test(e.message), mode);
  }
});

test('нет связи с LTC и не настроен адрес/ключ → LtcError', async () => {
  const { url, key } = config.ltc;
  try {
    config.ltc.url = 'http://127.0.0.1:1';
    await assert.rejects(ltc.getAbsences(...Object.values(fresh())), (e) => e instanceof ltc.LtcError && /Не удалось связаться/.test(e.message));
    config.ltc.url = '';
    assert.equal(ltc.ltcConfigured(), false);
    await assert.rejects(ltc.getAbsences(...Object.values(fresh())), (e) => e instanceof ltc.LtcError && /не настроен/.test(e.message));
    config.ltc.url = url; config.ltc.key = '';
    assert.equal(ltc.ltcConfigured(), false);
  } finally { config.ltc.url = url; config.ltc.key = key; }
});

test('LTC не отвечает → через 30 с LtcError «не ответил вовремя» (sendFeedback)', { timeout: 45_000 }, async () => {
  stub.mode = 'hang';
  const t = Date.now();
  await assert.rejects(ltc.sendFeedback({ studentId: '1', period: P, status: 's', feedbackAt: new Date().toISOString() }),
    (e) => e instanceof ltc.LtcError && /не ответил вовремя/.test(e.message));
  assert.ok(Date.now() - t >= 29_000);
});
