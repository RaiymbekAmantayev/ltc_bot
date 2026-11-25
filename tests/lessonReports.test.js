// Мини-отчёты: текст сообщения (src/services/lessonReports.js) и обход Attendance API (src/ltc/attendance.js) на заглушке.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const stub = { requests: [], pages: [], status: 200 };
const server = http.createServer((req, res) => {
  stub.requests.push({ url: req.url, headers: req.headers });
  const u = new URL(req.url, 'http://x');
  const i = Number(u.searchParams.get('cursor') || 0);
  res.writeHead(stub.status, { 'content-type': 'application/json' });
  if (stub.status !== 200) return res.end(JSON.stringify({ error: 'unauthorized' }));
  const has = i + 1 < stub.pages.length;
  res.end(JSON.stringify({ data: stub.pages[i] || [], page: { limit: 500, next_cursor: has ? String(i + 1) : null, has_more: has } }));
});

let buildReport, localDate, fetchLessons, config;
before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    BOT_TOKEN: process.env.BOT_TOKEN || '1:x', DB_USER: process.env.DB_USER || 'x', DB_NAME: process.env.DB_NAME || 'x',
    HH_SUBDOMAIN: process.env.HH_SUBDOMAIN || 'x', HH_AUTH_KEY: process.env.HH_AUTH_KEY || 'x', LOG_LEVEL: 'silent',
  });
  ({ config } = await import('../src/config.js'));
  config.lessonReports.url = `http://127.0.0.1:${server.address().port}`;   // .env проекта мог задать свой адрес
  config.lessonReports.key = 'att-key';
  ({ buildReport, localDate } = await import('../src/services/lessonReports.js'));
  ({ fetchLessons } = await import('../src/ltc/attendance.js'));
});
after(() => { server.closeAllConnections(); server.close(); });
beforeEach(() => { stub.requests = []; stub.pages = []; stub.status = 200; });

const rec = (o = {}) => ({
  record_id: '10:801', date: '2026-11-20', group_name: 'Elementary 3', branch: 'Абая', hollyhop_client_id: '801',
  attendance: 'present', topic: 'Past Simple', activity: 4, behaviour: 5, homework: 3, homework_assignment: 'Ex. 5 p. 32', ...o,
});

test('пришёл: формат как в ТЗ (ru)', () => {
  assert.equal(buildReport(rec(), { lang: 'ru' }),
    `Добрый день!
📘 Elementary 3, 20.11.2026
Тема урока: Past Simple

Активность: 4/5
Поведение: 5/5
ДЗ за прошлый урок: 3/5

Домашнее задание: Ex. 5 p. 32`);
});

test('пришёл: казахская версия', () => {
  assert.equal(buildReport(rec(), { lang: 'kk' }),
    `Қайырлы күн!
📘 Elementary 3, 20.11.2026
Сабақ тақырыбы: Past Simple

Белсенділік: 4/5
Тәртіп: 5/5
Өткен сабақтың үй тапсырмасы: 3/5

Үй тапсырмасы: Ex. 5 p. 32`);
});

test('пустые поля не выводятся, оценка 0 выводится', () => {
  const text = buildReport(rec({ activity: null, behaviour: 0, homework: null, homework_assignment: '  ', topic: null }), { lang: 'ru' });
  assert.equal(text, `Добрый день!
📘 Elementary 3, 20.11.2026

Поведение: 0/5`);
});

test('не пришёл: тема, строка об отсутствии, ДЗ; без оценок (ru и kk)', () => {
  const r = rec({ attendance: 'absent', activity: null, behaviour: null, homework: null });
  assert.equal(buildReport(r, { lang: 'ru' }),
    `Добрый день!
📘 Elementary 3, 20.11.2026
Тема урока: Past Simple
Ваш ребенок отсутствовал на уроке

Домашнее задание: Ex. 5 p. 32`);
  assert.equal(buildReport(r, { lang: 'kk' }),
    `Қайырлы күн!

Балаңыздың сабаққа келмегенін хабарлаймыз.

📘 Elementary 3, 20.11.2026
Сабақ тақырыбы: Past Simple
Үй тапсырмасы: Ex. 5 p. 32`);
  assert.equal(buildReport(rec({ attendance: 'absent', topic: null, homework_assignment: null }), { lang: 'ru' }),
    `Добрый день!
📘 Elementary 3, 20.11.2026
Ваш ребенок отсутствовал на уроке`);
});

test('язык не выбран — казахский', () => {
  assert.match(buildReport(rec(), { lang: null }), /^Қайырлы күн!\n/);
});

test('localDate — дата по часовому поясу школы', () => {
  assert.equal(localDate(new Date('2026-11-22T20:30:00Z'), 'Asia/Almaty'), '2026-11-23');
});

test('fetchLessons: ключ, параметры и все страницы по курсору', async () => {
  stub.pages = [[rec()], [], [rec({ record_id: '11:802' })]];   // пустая страница с курсором — идём дальше
  const out = await fetchLessons({ updatedSince: new Date('2026-11-23T10:00:00Z'), dateFrom: '2026-11-21' });
  assert.deepEqual(out.map((r) => r.record_id), ['10:801', '11:802']);
  assert.equal(stub.requests.length, 3);
  assert.equal(stub.requests[0].headers['x-api-key'], 'att-key');
  const u = new URL(stub.requests[0].url, 'http://x');
  assert.equal(u.pathname, '/attendance-api/v1/lessons');
  assert.equal(u.searchParams.get('updated_since'), '2026-11-23T10:00:00.000Z');
  assert.equal(u.searchParams.get('date_from'), '2026-11-21');
});

test('fetchLessons: ошибка HTTP — исключение (окно опроса не сдвигается)', async () => {
  stub.status = 401;
  await assert.rejects(fetchLessons({ updatedSince: new Date(), dateFrom: '2026-11-21' }), /HTTP 401/);
});
