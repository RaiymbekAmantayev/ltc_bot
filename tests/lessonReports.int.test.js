// Интеграционный тест мини-отчётов: полный цикл pollLessonReports на временной БД MySQL
// (из .env проекта, база ltc_bot_lr_test_<pid> создаётся и удаляется), кабинет — HTTP-заглушка, Telegram — фейк.
// Нет доступа к MySQL — тест пропускается.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import 'dotenv/config';
import mysql from 'mysql2/promise';

const DB = `ltc_bot_lr_test_${process.pid}`;
const dbConn = { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306), user: process.env.DB_USER, password: process.env.DB_PASSWORD || '' };

let admin = null;
try { admin = await mysql.createConnection(dbConn); } catch { /* нет MySQL */ }
const skip = admin ? false : 'нет доступа к MySQL';

/* ---------------- Заглушка кабинета ---------------- */
const cab = { records: [], requests: [], status: 200, delayMs: 0 };
const server = http.createServer((req, res) => {
  cab.requests.push(new URL(req.url, 'http://x'));
  setTimeout(() => {
    res.writeHead(cab.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(cab.status === 200 ? { data: cab.records, page: { limit: 500, next_cursor: null, has_more: false } } : { error: 'boom' }));
  }, cab.delayMs);
});

/* ---------------- Фейковый Telegram ---------------- */
const tg = { sent: [], calls: 0, plan: new Map() };   // plan: chat_id -> массив ответов по очереди ('ok' | {code, desc, retry})
const tgError = ({ code, desc = 'err', retry }) => Object.assign(new Error(desc), { response: { error_code: code, description: desc, parameters: retry != null ? { retry_after: retry } : undefined } });
const bot = {
  telegram: {
    async sendMessage(chatId, text) {
      tg.calls++;
      const queue = tg.plan.get(chatId);
      const step = queue && queue.length ? queue.shift() : 'ok';
      if (step !== 'ok') throw tgError(step);
      tg.sent.push({ chatId, text });
      return { message_id: tg.calls };
    },
  },
};

let poll, config, query, pool;

before(async () => {
  if (skip) return;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  await admin.query(`CREATE DATABASE ${DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  Object.assign(process.env, {
    DB_NAME: DB, BOT_TOKEN: process.env.BOT_TOKEN || '1:x', HH_SUBDOMAIN: process.env.HH_SUBDOMAIN || 'x',
    HH_AUTH_KEY: process.env.HH_AUTH_KEY || 'x', LOG_LEVEL: 'silent',
  });
  ({ config } = await import('../src/config.js'));
  Object.assign(config.lessonReports, {
    url: `http://127.0.0.1:${server.address().port}`, key: 'k', dryRun: false, excludeBranches: ['ТЕСТ'],
    overlapMin: 15, maxAgeDays: 2, ratePerSec: 25,
  });
  config.sync.timezone = 'Asia/Almaty';
  const { migrate } = await import('../src/migrate.js');
  await migrate();
  ({ query, pool } = await import('../src/db.js'));
  ({ pollLessonReports: poll } = await import('../src/services/lessonReports.js'));

  // ученики: 801 — два родителя (ru, kk); 802 — без привязок; 803 — родитель заблокирует бота;
  // 804 — привязан только как ученик; 805 — родитель отписан; 806 — Telegram отклонит первую отправку
  const students = [[801, 'Аня'], [802, 'Боря'], [803, 'Вика'], [804, 'Гена'], [805, 'Дана'], [806, 'Ержан'], [807, 'Жанна']];
  await query('INSERT INTO students (client_id, hh_id, first_name, last_name, synced_at) VALUES ?', [students.map(([id, n]) => [id, id + 1000, n, 'Тестова', new Date()])]);
  const users = [[111, 'ru', 1], [112, 'kk', 1], [113, 'ru', 1], [114, 'ru', 1], [115, 'ru', 0], [116, 'ru', 1], [117, null, 1]];
  await query('INSERT INTO tg_users (id, chat_id, lang, is_subscribed) VALUES ?', [users.map(([c, l, s]) => [c, c, l, s])]);
  await query('INSERT INTO tg_links (tg_user_id, student_client_id, relation) VALUES ?', [[
    [111, 801, 'parent'], [112, 801, 'parent'], [113, 803, 'parent'], [114, 804, 'student'], [115, 805, 'parent'], [116, 806, 'parent'], [117, 807, 'parent'],
  ]]);
});

after(async () => {
  if (skip) return;
  await pool?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.end();
  server.closeAllConnections(); server.close();
});

beforeEach(() => { cab.records = []; cab.requests = []; cab.status = 200; cab.delayMs = 0; tg.sent = []; tg.calls = 0; tg.plan.clear(); });

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty' }).format(new Date());
const rec = (sub, client, o = {}) => ({
  record_id: `${sub}:${client}`, submission_id: String(sub), date: today(), group_name: 'Elementary 3', branch: 'Абая',
  hollyhop_client_id: String(client), student_fio: 'Фио Из Кабинета', attendance: 'present', topic: 'Past Simple',
  activity: 4, behaviour: 5, homework: 0, homework_assignment: 'Ex. 5', updated_at: new Date().toISOString(), ...o,
});
const rows = () => query('SELECT record_id, chat_id, status, error, text FROM lesson_reports ORDER BY record_id, chat_id');
const since = async () => (await query("SELECT v FROM sync_state WHERE k = 'lesson_reports_since'"))[0]?.v;

test('первый запуск: окно = последние 15 минут, date_from = сегодня − 2 дня', { skip }, async () => {
  const t0 = Date.now();
  const stats = await poll(bot);
  assert.equal(stats.records, 0);
  const u = cab.requests[0];
  assert.equal(u.pathname, '/attendance-api/v1/lessons');
  const s = Date.parse(u.searchParams.get('updated_since'));
  assert.ok(Math.abs(t0 - 15 * 60_000 - s) < 5000, 'updated_since ≈ сейчас − 15 мин');
  const d = new Date(`${today()}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 2);
  assert.equal(u.searchParams.get('date_from'), d.toISOString().slice(0, 10));
  assert.ok(Math.abs(Date.parse(await since()) - t0) < 5000, 'окно сдвинуто на время опроса');
});

test('рассылка: всем родителям на их языке; ТЕСТ, без родителей, ученик, отписанный — без отправки', { skip }, async () => {
  cab.records = [
    rec(10, 801), rec(10, 802), rec(10, 804), rec(10, 805),
    rec(11, 801, { branch: 'ТЕСТ', record_id: '11:801' }),
    rec(12, 'abc'),
    rec(13, 807, { attendance: 'absent', activity: null, behaviour: null, homework: null }),
  ];
  const stats = await poll(bot);
  assert.deepEqual(stats, { records: 7, excludedBranch: 1, invalid: 1, noParents: 3, sent: 3, failed: 0, blocked: 0, duplicate: 0 });
  const byChat = Object.fromEntries(tg.sent.map((m) => [m.chatId, m.text]));
  assert.deepEqual(Object.keys(byChat).map(Number).sort(), [111, 112, 117]);
  assert.match(byChat[111], /^Добрый день!\n📘 Elementary 3, \d\d\.\d\d\.\d{4}\nТема урока: Past Simple\n\nАктивность: 4\/5\nПоведение: 5\/5\nДЗ за прошлый урок: 0\/5\n\nДомашнее задание: Ex\. 5$/);
  assert.match(byChat[112], /Сабақ тақырыбы: Past Simple/);
  assert.match(byChat[117], /^Қайырлы күн!\n\nБалаңыздың сабаққа келмегенін хабарлаймыз\.\n\n📘 .+\nСабақ тақырыбы: Past Simple\nҮй тапсырмасы: Ex\. 5$/, 'язык не выбран → казахский');
  assert.doesNotMatch(byChat[117], /Белсенділік/);
  const r = await rows();
  assert.deepEqual(r.map((x) => [x.record_id, Number(x.chat_id), x.status]), [['10:801', 111, 'sent'], ['10:801', 112, 'sent'], ['13:807', 117, 'sent']]);
  assert.equal(r[0].text, byChat[111], 'в журнале — отправленный текст');
});

test('повторный опрос и правка той же записи — дублей нет; новый ученик в той же отметке — уходит', { skip }, async () => {
  const before = Date.parse(await since());
  cab.records = [rec(10, 801, { topic: 'Исправленная тема', updated_at: new Date().toISOString() }), rec(10, 806)];
  tg.plan.set(116, [{ code: 400, desc: 'Bad Request: message is too long' }]);   // первая отправка 806 — отказ
  const stats = await poll(bot);
  assert.equal(stats.duplicate, 2);
  assert.equal(stats.failed, 1);
  assert.equal(tg.sent.length, 0);
  assert.ok(Date.parse(cab.requests[0].searchParams.get('updated_since')) === before - 15 * 60_000, 'окно = прошлый опрос − перекрытие');
  assert.equal((await rows()).find((x) => x.record_id === '10:806').status, 'failed');

  // следующий опрос: failed повторяется и уходит, sent — нет
  const s2 = await poll(bot);
  assert.equal(s2.sent, 1);
  assert.equal(s2.duplicate, 2);
  assert.deepEqual(tg.sent.map((m) => m.chatId), [116]);
  const r = (await rows()).find((x) => x.record_id === '10:806');
  assert.equal(r.status, 'sent');
  assert.equal(r.error, null);
});

test('родитель заблокировал бота (403): blocked, is_blocked = 1, дальше ему не шлём', { skip }, async () => {
  cab.records = [rec(20, 803)];
  tg.plan.set(113, [{ code: 403, desc: 'Forbidden: bot was blocked by the user' }]);
  const s = await poll(bot);
  assert.equal(s.blocked, 1);
  assert.equal((await rows()).find((x) => x.record_id === '20:803').status, 'blocked');
  assert.equal(Number((await query('SELECT is_blocked FROM tg_users WHERE chat_id = 113'))[0].is_blocked), 1);
  cab.records = [rec(21, 803)];
  const s2 = await poll(bot);
  assert.equal(s2.noParents, 1);
  assert.equal(tg.calls, 1);
});

test('Telegram 429 и 5xx — повтор с паузой, одно сообщение', { skip }, async () => {
  cab.records = [rec(30, 801)];
  tg.plan.set(111, [{ code: 429, desc: 'Too Many Requests', retry: 0 }]);
  tg.plan.set(112, [{ code: 502, desc: 'Bad Gateway' }]);
  const s = await poll(bot);
  assert.equal(s.sent, 2);
  assert.equal(tg.sent.length, 2);
  assert.equal(tg.calls, 4);
});

test('кабинет недоступен — ошибка, окно не сдвигается, ничего не записано', { skip }, async () => {
  const before = await since();
  const n = (await rows()).length;
  cab.status = 500;
  cab.records = [rec(40, 801)];
  await assert.rejects(poll(bot), /HTTP 500/);
  assert.equal(await since(), before);
  assert.equal((await rows()).length, n);
  assert.equal(tg.calls, 0);
  // после восстановления запись уходит
  cab.status = 200;
  assert.equal((await poll(bot)).sent, 2);
});

test('кабинет 401 (неверный ключ) — ошибка, окно не сдвигается', { skip }, async () => {
  const before = await since();
  cab.status = 401;
  await assert.rejects(poll(bot), /HTTP 401/);
  assert.equal(await since(), before);
});

test('dry run — без отправки, без записей, окно не сдвигается', { skip }, async () => {
  const before = await since();
  const n = (await rows()).length;
  config.lessonReports.dryRun = true;
  try {
    cab.records = [rec(50, 801)];
    await poll(bot);
  } finally { config.lessonReports.dryRun = false; }
  assert.equal(tg.calls, 0);
  assert.equal((await rows()).length, n);
  assert.equal(await since(), before);
});

test('пустой список исключений — ТЕСТ тоже уходит', { skip }, async () => {
  config.lessonReports.excludeBranches = [];
  try {
    cab.records = [rec(60, 807, { branch: 'ТЕСТ' })];
    assert.equal((await poll(bot)).sent, 1);
  } finally { config.lessonReports.excludeBranches = ['ТЕСТ']; }
});

test('параллельный опрос не запускается, пока идёт предыдущий', { skip }, async () => {
  cab.delayMs = 300;
  const [a, b] = await Promise.all([poll(bot), poll(bot)]);
  assert.equal(b.skipped, 'running');
  assert.equal(a.skipped, undefined);
  assert.equal(cab.requests.length, 1);
});
