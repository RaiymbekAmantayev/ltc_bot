import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import { loginPage, dashboardPage, errorPage, broadcastFormPage, broadcastsPage } from './views.js';
import { createBroadcast, cancelBroadcast, startWorker } from '../services/broadcast.js';
import { toRecipients, ROW_COLUMNS } from '../services/recipients.js';
export const startWeb = startWebServer;
const PER_PAGE = 50;
const SESSION_TTL = 12 * 60 * 60 * 1000;

const SECRET = config.web.secret
  ? Buffer.from(config.web.secret)
  : crypto.createHash('sha256').update(`${config.botToken}:${config.web.password}`).digest();

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const makeToken = () => {
  const exp = String(Date.now() + SESSION_TTL);
  return `${exp}.${sign(exp)}`;
};
function validToken(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readCookie(req, key) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function passwordOk(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(config.web.password).digest();
  return crypto.timingSafeEqual(a, b);
}

// ограничение попыток входа: 10 за 15 минут с одного IP
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() > a.resetAt) return false;
  return a.count >= 10;
}
function addAttempt(ip) {
  const a = attempts.get(ip);
  if (!a || Date.now() > a.resetAt) attempts.set(ip, { count: 1, resetAt: Date.now() + 15 * 60 * 1000 });
  else a.count += 1;
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function requireAuth(req, res, next) {
  if (validToken(readCookie(req, 'sid'))) return next();
  return res.redirect('/login');
}

const asArray = (v) => (v === undefined || v === null ? [] : [].concat(v));

function parseFilters(q) {
  const statuses = [...new Set(asArray(q.status).map((x) => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, 50);
  const branches = [...new Set(asArray(q.branch).map(String).filter((x) => /^\d{1,10}$/.test(x)).map(Number))].slice(0, 200);
  return {
    q: String(q.q || '').trim().slice(0, 100),
    statuses, // несколько статусов; '__none__' = «без статуса»
    branches, // несколько филиалов
    bot: ['yes', 'no', 'parent', 'student'].includes(q.bot) ? q.bot : '',
    page: Math.max(1, parseInt(q.page, 10) || 1),
  };
}

const BOT_EXISTS = `EXISTS (SELECT 1 FROM tg_links l JOIN tg_users u ON u.id = l.tg_user_id
  WHERE l.student_client_id = s.client_id AND u.is_blocked = 0 AND u.is_subscribed = 1)`;
const RELATION_EXISTS = (rel) => `EXISTS (SELECT 1 FROM tg_links l WHERE l.student_client_id = s.client_id AND l.relation = '${rel}')`;

function buildWhere(f) {
  const where = [];
  const params = [];
  if (f.statuses.length) {
    const named = f.statuses.filter((x) => x !== '__none__');
    const parts = [];
    if (named.length) { parts.push('s.status IN (?)'); params.push(named); }
    if (f.statuses.includes('__none__')) parts.push('s.status IS NULL');
    where.push(`(${parts.join(' OR ')})`);
  }
  if (f.branches.length) {
    where.push('EXISTS (SELECT 1 FROM student_branches sb WHERE sb.student_client_id = s.client_id AND sb.branch_id IN (?))');
    params.push(f.branches);
  }
  if (/^\d+$/.test(f.q)) {
    where.push('(s.hh_id = ? OR s.client_id = ?)');
    params.push(Number(f.q), Number(f.q));
  } else if (f.q) {
    for (const w of f.q.split(/\s+/).slice(0, 4)) {
      const like = `%${w.replace(/[\\%_]/g, '\\$&')}%`;
      where.push('(s.last_name LIKE ? OR s.first_name LIKE ? OR s.middle_name LIKE ?)');
      params.push(like, like, like);
    }
  }
  if (f.bot === 'yes') where.push(BOT_EXISTS);
  if (f.bot === 'no') where.push(`NOT ${BOT_EXISTS}`);
  if (f.bot === 'parent' || f.bot === 'student') where.push(RELATION_EXISTS(f.bot));
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const BRANCHES_SUB = `(SELECT GROUP_CONCAT(b.name ORDER BY b.name SEPARATOR ', ')
  FROM student_branches sb JOIN branches b ON b.id = sb.branch_id WHERE sb.student_client_id = s.client_id)`;
const BOT_COUNT_SUB = `(SELECT COUNT(DISTINCT u.chat_id) FROM tg_links l JOIN tg_users u ON u.id = l.tg_user_id
  WHERE l.student_client_id = s.client_id AND u.is_blocked = 0 AND u.is_subscribed = 1)`;

const group = (rows, key) => {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r[key])) m.set(r[key], []);
    m.get(r[key]).push(r);
  }
  return m;
};

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // защита от CSV-инъекций в Excel
  return `"${s.replace(/"/g, '""')}"`;
};

// ---------- рассылка из веб-админки ----------
const csrfOf = (req) => sign(`csrf:${readCookie(req, 'sid')}`);
function csrfOk(req) {
  const a = Buffer.from(String(req.body?.csrf ?? ''));
  const b = Buffer.from(csrfOf(req));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Получатели = подключённые к боту пользователи учеников, подходящих под фильтр. */
function recipientsQuery(f, audience, select) {
  const w = buildWhere({ ...f, bot: '' });
  const conds = w.sql ? [w.sql.slice('WHERE '.length)] : [];
  const params = [...w.params];
  conds.push('u.is_subscribed = 1', 'u.is_blocked = 0');
  if (audience === 'parents') conds.push("l.relation = 'parent'");
  if (audience === 'students') conds.push("l.relation = 'student'");
  if (config.allowedStatuses.length) { conds.push('s.status IN (?)'); params.push(config.allowedStatuses); }
  return {
    sql: `SELECT ${select} FROM students s
          JOIN tg_links l ON l.student_client_id = s.client_id
          JOIN tg_users u ON u.id = l.tg_user_id
          WHERE ${conds.join(' AND ')}`,
    params,
  };
}

async function broadcastCounts(f) {
  const w = buildWhere({ ...f, bot: '' });
  const [t] = await query(`SELECT COUNT(*) AS n FROM students s ${w.sql}`, w.params);
  const pair = "CONCAT(u.chat_id, '-', s.client_id)";
  const q = recipientsQuery(f, 'all',
    `COUNT(DISTINCT u.chat_id) AS all_people,
     COUNT(DISTINCT ${pair}) AS all_msgs,
     COUNT(DISTINCT IF(l.relation = 'parent', u.chat_id, NULL)) AS parents_people,
     COUNT(DISTINCT IF(l.relation = 'parent', ${pair}, NULL)) AS parents_msgs,
     COUNT(DISTINCT IF(l.relation = 'student', u.chat_id, NULL)) AS students_people,
     COUNT(DISTINCT IF(l.relation = 'student', ${pair}, NULL)) AS students_msgs,
     COUNT(DISTINCT s.client_id) AS connected`);
  const [r] = await query(q.sql, q.params);
  const n = (v) => Number(v);
  return {
    totalStudents: n(t.n), connected: n(r.connected),
    all: { people: n(r.all_people), messages: n(r.all_msgs) },
    parents: { people: n(r.parents_people), messages: n(r.parents_msgs) },
    students: { people: n(r.students_people), messages: n(r.students_msgs) },
  };
}

async function filterTitle(f) {
  const parts = [];
  if (f.statuses.length) parts.push(`статус: ${f.statuses.map((x) => (x === '__none__' ? 'без статуса' : x)).join(', ')}`);
  if (f.branches.length) {
    const rows = await query('SELECT name FROM branches WHERE id IN (?) ORDER BY name', [f.branches]);
    parts.push(`филиал: ${rows.map((r) => r.name).join(', ') || f.branches.join(', ')}`);
  }
  if (f.q) parts.push(`поиск: ${f.q}`);
  return parts.join('; ') || 'все ученики';
}

export function startWebServer(bot = null) {
  if (!config.web.password) {
    logger.warn('ADMIN_WEB_PASSWORD не задан — веб-админка отключена');
    return null;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.get('/login', (req, res) => res.send(loginPage()));

  app.post('/login', (req, res) => {
    if (tooManyAttempts(req.ip)) return res.status(429).send(loginPage('Слишком много попыток. Попробуйте позже.'));
    if (!passwordOk(req.body.password ?? '')) {
      addAttempt(req.ip);
      return res.status(401).send(loginPage('Неверный пароль'));
    }
    res.cookie('sid', makeToken(), {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.web.secureCookie,
      maxAge: SESSION_TTL,
    });
    return res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    res.clearCookie('sid');
    res.redirect('/login');
  });

  app.get('/', requireAuth, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const w = buildWhere(f);

    const [{ n: total }] = await query(`SELECT COUNT(*) AS n FROM students s ${w.sql}`, w.params);
    const rows = await query(
      `SELECT s.client_id, s.hh_id, s.first_name, s.last_name, s.middle_name, s.status, s.mobile, s.phone, s.email,
              ${BRANCHES_SUB} AS branches, ${BOT_COUNT_SUB} AS bot_users
       FROM students s ${w.sql}
       ORDER BY s.last_name, s.first_name, s.client_id
       LIMIT ? OFFSET ?`,
      [...w.params, PER_PAGE, (f.page - 1) * PER_PAGE],
    );

    const ids = rows.map((r) => r.client_id);
    const agents = ids.length
      ? await query('SELECT student_client_id, first_name, last_name, middle_name, who_is, mobile, phone FROM agents WHERE student_client_id IN (?)', [ids])
      : [];
    const tgs = ids.length
      ? await query(
          `SELECT l.student_client_id, l.relation, u.chat_id, u.username, u.first_name, u.is_blocked, u.is_subscribed, u.lang
           FROM tg_links l JOIN tg_users u ON u.id = l.tg_user_id WHERE l.student_client_id IN (?)`,
          [ids],
        )
      : [];

    // сколько аккаунтов Telegram зарегистрировалось как родитель / ученик среди учеников по фильтру
    const [reg] = await query(
      `SELECT COUNT(DISTINCT IF(l.relation = 'parent', l.tg_user_id, NULL)) AS parents,
              COUNT(DISTINCT IF(l.relation = 'student', l.tg_user_id, NULL)) AS students
       FROM students s JOIN tg_links l ON l.student_client_id = s.client_id ${w.sql}`,
      w.params,
    );

    const [st] = await query(
      `SELECT (SELECT COUNT(*) FROM students) AS students,
              (SELECT COUNT(DISTINCT student_client_id) FROM tg_links) AS connected,
              (SELECT COUNT(*) FROM tg_users WHERE is_blocked = 0 AND is_subscribed = 1) AS activeUsers,
              (SELECT COUNT(DISTINCT tg_user_id) FROM tg_links WHERE relation = 'parent') AS parents,
              (SELECT COUNT(DISTINCT tg_user_id) FROM tg_links WHERE relation = 'student') AS studentUsers,
              (SELECT COUNT(*) FROM branches WHERE is_active = 1) AS branches`,
    );
    const statuses = await query('SELECT status, COUNT(*) AS n FROM students GROUP BY status ORDER BY n DESC');
    const branches = await query('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY name');

    res.send(dashboardPage({
      f, stats: st, statuses, branches, rows, total: Number(total), reg, perPage: PER_PAGE,
      agentsBy: group(agents, 'student_client_id'), tgBy: group(tgs, 'student_client_id'),
      regField: config.regIdField,
    }));
  }));

  app.get('/export.csv', requireAuth, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const w = buildWhere(f);
    const rows = await query(
      `SELECT s.hh_id, s.client_id, s.last_name, s.first_name, s.middle_name, s.status, s.mobile, s.phone,
              ${BRANCHES_SUB} AS branches,
              (SELECT GROUP_CONCAT(CONCAT_WS(' ', a.last_name, a.first_name, COALESCE(a.mobile, a.phone, '')) SEPARATOR '; ')
                 FROM agents a WHERE a.student_client_id = s.client_id) AS parents,
              ${BOT_COUNT_SUB} AS bot_users
       FROM students s ${w.sql} ORDER BY s.last_name, s.first_name LIMIT 100000`,
      w.params,
    );
    const head = ['ID', 'ClientId', 'Фамилия', 'Имя', 'Отчество', 'Статус', 'Телефон ученика', 'Филиалы', 'Родители', 'Подключено в боте'];
    const lines = [head.map(csvCell).join(';')];
    for (const r of rows) {
      lines.push([r.hh_id, r.client_id, r.last_name, r.first_name, r.middle_name, r.status, r.mobile || r.phone, r.branches, r.parents, r.bot_users]
        .map(csvCell).join(';'));
    }
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="students.csv"' });
    res.send(`\uFEFF${lines.join('\r\n')}`); // BOM, чтобы Excel открыл кириллицу
  }));

  app.get('/broadcast', requireAuth, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    res.send(broadcastFormPage({
      f, title: await filterTitle(f), counts: await broadcastCounts(f), csrf: csrfOf(req), restricted: config.allowedStatuses,
      personalize: true,
    }));
  }));

  app.post('/broadcast', requireAuth, wrap(async (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(errorPage('Сессия устарела — обновите страницу и повторите.'));
    if (!bot) return res.status(500).send(errorPage('Бот недоступен.'));

    const f = parseFilters(req.body);
    const text = String(req.body.text ?? '').trim();
    const audience = ['all', 'parents', 'students'].includes(req.body.audience) ? req.body.audience : 'all';
    const html = req.body.html === '1';
    const personalize = req.body.personalize === '1';
    const title = await filterTitle(f);
    const fail = async (error) =>
      res.status(400).send(broadcastFormPage({
        f, title, counts: await broadcastCounts(f), csrf: csrfOf(req), error, text, audience, html, personalize, restricted: config.allowedStatuses,
      }));

    if (!text) return fail('Введите текст сообщения.');
    if (text.length > 3800) return fail('Текст длиннее 3800 символов (с учётом обращения к родителю).');
    if (req.body.confirm !== '1') return fail('Подтвердите отправку галочкой.');

    // защита от двойной отправки (двойной клик, повторная отправка формы)
    const [dup] = await query('SELECT id FROM broadcasts WHERE text = ? AND created_at > (NOW() - INTERVAL 1 MINUTE) LIMIT 1', [text]);
    if (dup) return fail(`Такая рассылка уже создана минуту назад (#${dup.id}).`);

    const q = recipientsQuery(f, audience, `DISTINCT ${ROW_COLUMNS}`);
    const recipients = toRecipients(await query(q.sql, q.params), personalize);
    if (!recipients.length) return fail('По этому фильтру нет ни одного получателя в боте.');

    const audLabel = { all: 'родители и ученики', parents: 'родители', students: 'ученики' }[audience];
    const { id } = await createBroadcast({
      adminChatId: config.adminIds[0] ?? 0,
      audience, recipients, text, parseMode: html ? 'HTML' : null,
      title: `${title} · ${audLabel}`,
    });
    startWorker(bot);
    return res.redirect(`/broadcasts?created=${id}`);
  }));

  app.get('/broadcasts', requireAuth, wrap(async (req, res) => {
    const rows = await query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 30');
    const fmt = (d) => (d ? new Date(d).toLocaleString('ru-RU', { timeZone: config.sync.timezone }) : '—');
    res.send(broadcastsPage({
      rows: rows.map((b) => ({ ...b, created: fmt(b.created_at) })),
      csrf: csrfOf(req),
      createdId: /^\d+$/.test(String(req.query.created || '')) ? Number(req.query.created) : null,
      refresh: rows.some((b) => b.status === 'running'),
    }));
  }));

  app.post('/broadcasts/:id/stop', requireAuth, wrap(async (req, res) => {
    if (!csrfOk(req)) return res.status(403).send(errorPage('Сессия устарела — обновите страницу.'));
    if (/^\d+$/.test(req.params.id)) await cancelBroadcast(Number(req.params.id));
    res.redirect('/broadcasts');
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err }, 'Ошибка веб-админки');
    res.status(500).send(errorPage());
  });

  const server = app.listen(config.web.port, () => logger.info({ port: config.web.port }, 'Веб-админка запущена'));
  return server;
}
