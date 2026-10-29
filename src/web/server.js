import crypto from 'node:crypto';
import express from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { query } from '../db.js';
import ExcelJS from 'exceljs';
import { loginPage, mentorLoginPage, dashboardPage, errorPage, broadcastFormPage, broadcastsPage, mentorPage } from './views.js';
import { createBroadcast, cancelBroadcast, startWorker } from '../services/broadcast.js';
import { toRecipients, ROW_COLUMNS } from '../services/recipients.js';
import { getDataCheck, getNotAttending, getAdaptation, getNoCalls, getDailyCalls, PROBLEMS } from '../services/hhReports.js';
import { isMoiZvonkiConfigured } from '../moizvonki/client.js';
export const startWeb = startWebServer;
const PER_PAGE = 50;
const SESSION_TTL = 12 * 60 * 60 * 1000;

const SECRET = config.web.secret
  ? Buffer.from(config.web.secret)
  : crypto.createHash('sha256').update(`${config.botToken}:${config.web.password}`).digest();

const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
// роль в сессии: admin — вся админка; almaty / astana — менторы, только выгрузки (/mentor) по своим филиалам
const ROLES = ['admin', 'almaty', 'astana'];
const MENTOR_TITLE = { almaty: 'Ментор Алматы', astana: 'Ментор Астана' };
const makeToken = (role) => {
  const payload = `${role}.${Date.now() + SESSION_TTL}`;
  return `${payload}.${sign(payload)}`;
};
/** Роль из cookie-сессии или null. */
function tokenRole(tok) {
  if (!tok) return null;
  const [role, exp, sig] = tok.split('.');
  if (!ROLES.includes(role) || !exp || !sig || Number(exp) < Date.now()) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(`${role}.${exp}`));
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? role : null;
}
function readCookie(req, key) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === key) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function passwordEq(input, password) {
  if (!password) return false;
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(password).digest();
  return crypto.timingSafeEqual(a, b);
}
/** Ментор по логину и паролю: 'almaty' | 'astana' | null. */
function mentorByLogin(login, password) {
  const name = String(login ?? '').trim().toLowerCase();
  for (const [role, acc] of Object.entries(config.mentor.accounts)) {
    // пароль проверяем всегда, чтобы время ответа не выдавало существующий логин
    const ok = passwordEq(password, acc.password);
    if (ok && acc.login.toLowerCase() === name) return role;
  }
  return null;
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

// Сессии раздельные: sid — админка, msid — выгрузки менторов. В браузере активна только одна:
// вход в админку завершает сессию ментора и наоборот, поэтому переход в любую сторону требует пароль.
const ADMIN_COOKIE = 'sid';
const MENTOR_COOKIE = 'msid';

function requireAuth(req, res, next) {
  if (tokenRole(readCookie(req, ADMIN_COOKIE)) === 'admin') return next();
  return res.redirect('/login');
}
/** Выгрузки — только под логином ментора; роль (almaty / astana) кладём в req.role. */
function requireMentor(req, res, next) {
  const role = tokenRole(readCookie(req, MENTOR_COOKIE));
  if (role && role !== 'admin') {
    req.role = role;
    return next();
  }
  return res.redirect('/mentor/login');
}
const setSession = (res, cookie, role) =>
  res.cookie(cookie, makeToken(role), { httpOnly: true, sameSite: 'strict', secure: config.web.secureCookie, maxAge: SESSION_TTL });

const asArray = (v) => (v === undefined || v === null ? [] : [].concat(v));

/**
 * Время регистрации в боте показываем и фильтруем по Астане (UTC+5).
 * created_at пишется в часовом поясе сессии MySQL; DB_SHIFT — на сколько секунд он отличается от Астаны.
 */
const ASTANA_SEC = 5 * 3600;
const DB_SHIFT = `(TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) - ${ASTANA_SEC})`;
const toDbTime = (expr) => `DATE_ADD(${expr}, INTERVAL ${DB_SHIFT} SECOND)`;
const astanaFmt = (col) => `DATE_FORMAT(DATE_SUB(${col}, INTERVAL ${DB_SHIFT} SECOND), '%d.%m.%Y %H:%i')`;

/** 'YYYY-MM-DD' или 'YYYY-MM-DDTHH:MM' → 'YYYY-MM-DDTHH:MM'; без времени — начало (или конец) дня. */
function parseDateTime(v, endOfDay = false) {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(String(v ?? '').trim());
  if (!m || Number.isNaN(Date.parse(`${m[1]}T${m[2] || '00:00'}:00Z`))) return '';
  return `${m[1]}T${m[2] || (endOfDay ? '23:59' : '00:00')}`;
}
const sqlTime = (v) => `${v.replace('T', ' ')}:00`;

/** Условия на время регистрации привязки (alias — таблица tg_links); «по» — включительно до конца минуты. */
function regRange(f, alias = 'l') {
  const conds = [];
  const params = [];
  if (f.regFrom) { conds.push(`${alias}.created_at >= ${toDbTime('?')}`); params.push(sqlTime(f.regFrom)); }
  if (f.regTo) { conds.push(`${alias}.created_at < ${toDbTime('DATE_ADD(?, INTERVAL 1 MINUTE)')}`); params.push(sqlTime(f.regTo)); }
  return { conds, params };
}

function parseFilters(q) {
  const statuses = [...new Set(asArray(q.status).map((x) => String(x).trim().slice(0, 100)).filter(Boolean))].slice(0, 50);
  const branches = [...new Set(asArray(q.branch).map(String).filter((x) => /^\d{1,10}$/.test(x)).map(Number))].slice(0, 200);
  return {
    q: String(q.q || '').trim().slice(0, 100),
    statuses, // несколько статусов; '__none__' = «без статуса»
    branches, // несколько филиалов
    bot: ['yes', 'no', 'parent', 'student'].includes(q.bot) ? q.bot : '',
    regFrom: parseDateTime(q.reg_from), // дата и время регистрации в боте по Астане: с / по (включительно)
    regTo: parseDateTime(q.reg_to, true),
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
  const r = regRange(f, 'lr');
  if (r.conds.length) {
    // зарегистрировались в боте за период (родитель / ученик — если выбран в фильтре «Telegram-бот»)
    if (f.bot === 'parent' || f.bot === 'student') r.conds.push(`lr.relation = '${f.bot}'`);
    where.push(`EXISTS (SELECT 1 FROM tg_links lr WHERE lr.student_client_id = s.client_id AND ${r.conds.join(' AND ')})`);
    params.push(...r.params);
  }
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

/**
 * Выгрузка в Excel. columns: [{ header, width }], rows: массивы значений в порядке колонок.
 * Строки пишутся как текст (не формулы), поэтому «=…» из данных не исполняется.
 */
async function sendXlsx(res, filename, sheetName, columns, rows) {
  return sendWorkbook(res, filename, [{ name: sheetName, columns, rows }]);
}

/** Excel с несколькими листами: sheets = [{ name, columns, rows, filter = true }]. */
async function sendWorkbook(res, filename, sheets) {
  const wb = new ExcelJS.Workbook();
  for (const { name, columns, rows, filter = true } of sheets) {
    const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = columns.map((c) => ({ header: c.header, width: c.width ?? 18, ...(c.wrap ? { style: { alignment: { wrapText: true, vertical: 'top' } } } : {}) }));
    for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? '' : v)));
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    if (filter) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });
  await wb.xlsx.write(res);
  res.end();
}

// ---------- выгрузки для менторов ----------
const UNREG = {
  none: 'NOT EXISTS (SELECT 1 FROM tg_links l WHERE l.student_client_id = s.client_id)',
  parent: "NOT EXISTS (SELECT 1 FROM tg_links l WHERE l.student_client_id = s.client_id AND l.relation = 'parent')",
  student: "NOT EXISTS (SELECT 1 FROM tg_links l WHERE l.student_client_id = s.client_id AND l.relation = 'student')",
};
const parseUnreg = (q) => (Object.hasOwn(UNREG, q.who) ? q.who : 'none');
const parseProblems = (q) => [...new Set(asArray(q.problem).map(String).filter((x) => Object.hasOwn(PROBLEMS, x)))];

/** Филиалы, доступные роли: админ — все, ментор Алматы — MENTOR_ALMATY_BRANCHES, ментор Астаны — остальные. */
async function scopeBranches(role) {
  const all = await query('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY name');
  if (role === 'admin') return all;
  const almaty = new Set(config.mentor.almatyBranches.map((x) => x.toLowerCase()));
  return all.filter((b) => almaty.has(b.name.trim().toLowerCase()) === (role === 'almaty'));
}
/** Выбранные филиалы в пределах доступных; ничего не выбрано — все доступные (для админа null = без ограничения). */
async function effectiveBranches(role, f) {
  const ids = (await scopeBranches(role)).map((b) => b.id);
  const chosen = f.branches.filter((id) => ids.includes(id));
  if (chosen.length) return chosen;
  return role === 'admin' ? null : ids;
}
const inBranches = (ids) => (r) => ids === null || r.branchIds.some((id) => ids.includes(id));

async function unregisteredWhere(role, f, who) {
  const ids = await effectiveBranches(role, f);
  const w = buildWhere({ ...f, q: '', bot: '', regFrom: '', regTo: '', branches: ids ?? [] });
  const conds = [w.sql.replace(/^WHERE /, ''), UNREG[who]].filter(Boolean);
  if (ids && !ids.length) conds.push('0 = 1'); // у ментора нет ни одного филиала
  return { sql: `WHERE ${conds.join(' AND ')}`, params: w.params };
}

/** Колонки о звонках «Мои звонки» (main — последний звонок в 14+, самый длинный разговор в ежедневной). */
const CALL_COLS = (mainLabel) => [
  { header: `Номер (${mainLabel})`, width: 26 }, { header: `Дата (${mainLabel})`, width: 17 }, { header: 'Длительность, сек', width: 11 },
  { header: 'Все звонки (дата — номер — длительность)', width: 60, wrap: true },
];
const callCells = (r) => [r.callNumber, r.callDate, r.callSec, r.allCalls];

const COL = {
  hh: { header: 'ID HolliHop', width: 12 },
  name: { header: 'ФИО', width: 32 },
  status: { header: 'Статус', width: 14 },
  branch: { header: 'Филиал', width: 16 },
  phone: { header: 'Телефон ученика', width: 18 },
  parents: { header: 'Родители', width: 40 },
  groups: { header: 'Группы и расписание', width: 50 },
};

// ---------- рассылка из веб-админки ----------
const csrfOf = (req) => sign(`csrf:${readCookie(req, ADMIN_COOKIE)}`);
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
  const r = regRange(f);
  conds.push(...r.conds);
  params.push(...r.params);
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
  if (f.regFrom || f.regTo) parts.push(`регистрация в боте (Астана): ${f.regFrom.replace('T', ' ') || '…'} — ${f.regTo.replace('T', ' ') || '…'}`);
  return parts.join('; ') || 'все ученики';
}

export function startWebServer(bot = null) {
  if (!config.web.password) {
    logger.warn('ADMIN_WEB_PASSWORD не задан — веб-админка отключена');
    return null;
  }

  const app = express();
  app.disable('x-powered-by');
  // за nginx на этом же сервере: req.ip — реальный адрес клиента (иначе лимит попыток входа общий для всех)
  app.set('trust proxy', 'loopback');
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
    if (!passwordEq(req.body.password ?? '', config.web.password)) {
      addAttempt(req.ip);
      return res.status(401).send(loginPage('Неверный пароль'));
    }
    res.clearCookie(MENTOR_COOKIE);
    setSession(res, ADMIN_COOKIE, 'admin');
    return res.redirect('/');
  });

  app.get('/logout', (req, res) => {
    res.clearCookie(ADMIN_COOKIE);
    res.redirect('/login');
  });

  app.get('/mentor/login', (req, res) => res.send(mentorLoginPage()));

  app.post('/mentor/login', (req, res) => {
    if (tooManyAttempts(req.ip)) return res.status(429).send(mentorLoginPage('Слишком много попыток. Попробуйте позже.'));
    const role = mentorByLogin(req.body.login, req.body.password ?? '');
    if (!role) {
      addAttempt(req.ip);
      return res.status(401).send(mentorLoginPage('Неверный логин или пароль'));
    }
    res.clearCookie(ADMIN_COOKIE);
    setSession(res, MENTOR_COOKIE, role);
    return res.redirect('/mentor');
  });

  app.get('/mentor/logout', (req, res) => {
    res.clearCookie(MENTOR_COOKIE);
    res.redirect('/mentor/login');
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
          `SELECT l.student_client_id, l.relation, ${astanaFmt('l.created_at')} AS reg_at, u.chat_id, u.username, u.first_name, u.is_blocked, u.is_subscribed, u.lang
           FROM tg_links l JOIN tg_users u ON u.id = l.tg_user_id WHERE l.student_client_id IN (?)`,
          [ids],
        )
      : [];

    // сколько аккаунтов Telegram зарегистрировалось как родитель / ученик среди учеников по фильтру
    const rr = regRange(f);
    const regSql = [w.sql.replace(/^WHERE /, ''), ...rr.conds].filter(Boolean).join(' AND ');
    const [reg] = await query(
      `SELECT COUNT(DISTINCT IF(l.relation = 'parent', l.tg_user_id, NULL)) AS parents,
              COUNT(DISTINCT IF(l.relation = 'student', l.tg_user_id, NULL)) AS students
       FROM students s JOIN tg_links l ON l.student_client_id = s.client_id ${regSql ? `WHERE ${regSql}` : ''}`,
      [...w.params, ...rr.params],
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

  app.get('/export.xlsx', requireAuth, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const w = buildWhere(f);
    const rows = await query(
      `SELECT s.hh_id, s.client_id, s.last_name, s.first_name, s.middle_name, s.status, s.mobile, s.phone,
              ${BRANCHES_SUB} AS branches,
              (SELECT GROUP_CONCAT(CONCAT_WS(' ', a.last_name, a.first_name, COALESCE(a.mobile, a.phone, '')) SEPARATOR '; ')
                 FROM agents a WHERE a.student_client_id = s.client_id) AS parents,
              ${BOT_COUNT_SUB} AS bot_users,
              (SELECT ${astanaFmt('MIN(l.created_at)')} FROM tg_links l WHERE l.student_client_id = s.client_id) AS reg_at
       FROM students s ${w.sql} ORDER BY s.last_name, s.first_name LIMIT 100000`,
      w.params,
    );
    await sendXlsx(res, 'students.xlsx', 'Ученики',
      [COL.hh, { header: 'ClientId', width: 10 }, { header: 'Фамилия', width: 18 }, { header: 'Имя', width: 16 }, { header: 'Отчество', width: 16 },
        COL.status, COL.phone, COL.branch, COL.parents, { header: 'Подключено в боте', width: 12 }, { header: 'Первая регистрация в боте (Астана)', width: 18 }],
      rows.map((r) => [r.hh_id, r.client_id, r.last_name, r.first_name, r.middle_name, r.status, r.mobile || r.phone, r.branches, r.parents, Number(r.bot_users), r.reg_at]));
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

  // ---------- страница выгрузок (менторы и админы) ----------
  app.get('/mentor', requireMentor, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const who = parseUnreg(req.query);
    const w = await unregisteredWhere(req.role, f, who);
    const [{ n: unregistered }] = await query(`SELECT COUNT(*) AS n FROM students s ${w.sql}`, w.params);
    res.send(mentorPage({
      f, who, unregistered: Number(unregistered),
      statuses: await query('SELECT status, COUNT(*) AS n FROM students GROUP BY status ORDER BY n DESC'),
      branches: await scopeBranches(req.role),
      title: MENTOR_TITLE[req.role],
      activeStatuses: config.mentor.activeStatuses,
      fields: [config.mentor.scheduleField, config.mentor.timeField],
      testCategory: config.mentor.attendanceTestCategory,
      today: new Date().toLocaleDateString('sv-SE', { timeZone: config.sync.timezone }),
    }));
  }));

  app.get('/mentor/unregistered.xlsx', requireMentor, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const w = await unregisteredWhere(req.role, f, parseUnreg(req.query));
    const rows = await query(
      `SELECT s.hh_id, s.last_name, s.first_name, s.middle_name, s.status, s.mobile, s.phone,
              ${BRANCHES_SUB} AS branches,
              (SELECT GROUP_CONCAT(CONCAT_WS(' ', a.last_name, a.first_name, COALESCE(a.mobile, a.phone, '')) SEPARATOR '; ')
                 FROM agents a WHERE a.student_client_id = s.client_id) AS parents,
              (SELECT GROUP_CONCAT(DISTINCT IF(l.relation = 'parent', 'родитель', 'ученик') SEPARATOR ', ')
                 FROM tg_links l WHERE l.student_client_id = s.client_id) AS registered
       FROM students s ${w.sql} ORDER BY branches, s.last_name, s.first_name LIMIT 100000`,
      w.params,
    );
    await sendXlsx(res, 'ne-zaregistrirovany-v-bote.xlsx', 'Не в боте',
      [COL.hh, COL.name, COL.status, COL.branch, COL.phone, COL.parents, { header: 'Уже зарегистрирован в боте', width: 20 }],
      rows.map((r) => [r.hh_id, [r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' '), r.status,
        r.branches, r.mobile || r.phone, r.parents, r.registered || 'никто']));
  }));

  app.get('/mentor/hh-check.xlsx', requireMentor, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const wanted = parseProblems(req.query);
    const ids = await effectiveBranches(req.role, f);
    const { rows } = await getDataCheck({ refresh: req.query.refresh === '1' });
    const list = rows.filter((r) => inBranches(ids)(r) && (!wanted.length || r.problems.some((p) => wanted.includes(p))));
    const mark = (r, p) => (r.problems.includes(p) ? 'да' : '');
    await sendXlsx(res, 'proverka-dannyh.xlsx', 'Проверка данных',
      [COL.hh, COL.name, COL.status, COL.branch, { header: 'Проблемы', width: 40 },
        ...Object.values(PROBLEMS).map((header) => ({ header, width: 13 })),
        { header: `${config.mentor.scheduleField} (поле)`, width: 14 }, { header: `${config.mentor.timeField} (поле)`, width: 14 },
        COL.groups, { header: 'Расхождение', width: 50 }],
      list.map((r) => [r.hh_id, r.name, r.status, r.branches, r.problems.map((p) => PROBLEMS[p]).join(', '),
        ...Object.keys(PROBLEMS).map((p) => mark(r, p)), r.schedule, r.time, r.groups, r.mismatch]));
  }));

  app.get('/mentor/not-attending.xlsx', requireMentor, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const ids = await effectiveBranches(req.role, f);
    const { rows } = await getNotAttending({ refresh: req.query.refresh === '1' });
    await sendXlsx(res, 'ne-poseshchayut.xlsx', 'Не посещают',
      [COL.hh, COL.name, COL.status, COL.branch, { header: `Последний результат «${config.mentor.attendanceTestCategory}»`, width: 18 },
        COL.groups, COL.phone, COL.parents],
      rows.filter(inBranches(ids)).map((r) => [r.hh_id, r.name, r.status, r.branches, r.lastResult, r.groups, r.phone, r.parents]));
  }));

  app.get('/mentor/no-calls.xlsx', requireMentor, wrap(async (req, res) => {
    if (!isMoiZvonkiConfigured()) return res.status(503).send(errorPage('Интеграция «Мои звонки» не настроена (MOIZVONKI_* в .env).'));
    const f = parseFilters(req.query);
    const ids = await effectiveBranches(req.role, f);
    const { rows, days } = await getNoCalls({ refresh: req.query.refresh === '1' });
    await sendXlsx(res, '14plus.xlsx', '14+',
      [COL.hh, COL.name, COL.status, { header: 'Моб. телефон', width: 18 }, { header: 'Телефоны родителей', width: 36, wrap: true },
        { header: 'Ментор', width: 24 }, { header: 'День обзвона постоянное', width: 14 }, { header: 'Статус звонка', width: 14 }, COL.branch,
        { header: `Звонков за ${days} дн.`, width: 10 }, { header: 'Самый длинный разговор, сек', width: 12 }, ...CALL_COLS('последний звонок')],
      rows.filter(inBranches(ids)).map((r) => [r.hh_id, r.name, r.status, r.phone, r.parentPhones, r.mentor, r.callDay, r.callStatus, r.branches,
        r.calls, r.noPhones ? 'нет телефонов' : r.maxSec, ...callCells(r)]));
  }));

  app.get('/mentor/daily.xlsx', requireMentor, wrap(async (req, res) => {
    if (!isMoiZvonkiConfigured()) return res.status(503).send(errorPage('Интеграция «Мои звонки» не настроена (MOIZVONKI_* в .env).'));
    const day = String(req.query.day ?? '').trim();
    if (!/^\d{1,2}$/.test(day)) return res.status(400).send(errorPage('Выберите день обзвона.'));
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: config.sync.timezone });
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date)) && req.query.date <= today ? req.query.date : today;

    const f = parseFilters(req.query);
    const ids = await effectiveBranches(req.role, f);
    const { rows: all, minSec } = await getDailyCalls({ day, date, refresh: req.query.refresh === '1' });
    const rows = all.filter(inBranches(ids));

    // сводка: всего и по каждому ментору
    const sum = (list) => [list.length, list.filter((r) => r.reached).length, list.filter((r) => r.actual).length];
    const byMentor = new Map();
    for (const r of rows) {
      const key = r.mentor || 'без ментора';
      if (!byMentor.has(key)) byMentor.set(key, []);
      byMentor.get(key).push(r);
    }
    const dateRu = date.split('-').reverse().join('.');
    await sendWorkbook(res, `ezhednevnaya-den-${day}-${date}.xlsx`, [
      {
        name: 'Сводка',
        filter: false,
        columns: [{ header: `День обзвона ${day} · звонки за ${dateRu}`, width: 36 }, { header: 'Запланировано', width: 15 },
          { header: 'Дозвон (статус в HolliHop)', width: 18 }, { header: `Фактический (разговор > ${minSec} сек)`, width: 20 }],
        rows: [['Всего', ...sum(rows)], [], ['Ментор'], ...[...byMentor].map(([m, list]) => [m, ...sum(list)])],
      },
      {
        name: 'Ученики',
        columns: [COL.hh, COL.name, COL.status, { header: 'Моб. телефон', width: 18 }, { header: 'Телефоны родителей', width: 36, wrap: true },
          { header: 'Ментор', width: 24 }, { header: 'День обзвона постоянное', width: 12 }, { header: 'Статус звонка', width: 14 }, COL.branch,
          { header: `Фактический звонок ${dateRu}`, width: 14 }, { header: 'Звонков за день', width: 10 }, ...CALL_COLS('самый длинный разговор')],
        rows: rows.map((r) => [r.hh_id, r.name, r.status, r.phone, r.parentPhones, r.mentor, r.callDay, r.callStatus, r.branches,
          r.actual ? 'да' : 'нет', r.calls, ...callCells(r)]),
      },
    ]);
  }));

  app.get('/mentor/adaptation.xlsx', requireMentor, wrap(async (req, res) => {
    const f = parseFilters(req.query);
    const ids = await effectiveBranches(req.role, f);
    const { rows } = await getAdaptation({ refresh: req.query.refresh === '1' });
    await sendXlsx(res, 'adaptaciya.xlsx', 'Адаптация',
      [COL.hh, COL.name, COL.status, COL.branch, { header: 'Создан в HolliHop', width: 18 }, COL.groups, COL.phone, COL.parents],
      rows.filter(inBranches(ids)).map((r) => [r.hh_id, r.name, r.status, r.branches, r.created, r.groups, r.phone, r.parents]));
  }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error({ err }, 'Ошибка веб-админки');
    res.status(500).send(errorPage());
  });

  const server = app.listen(config.web.port, () => logger.info({ port: config.web.port }, 'Веб-админка запущена'));
  return server;
}
