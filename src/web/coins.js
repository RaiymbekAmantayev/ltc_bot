import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { astanaFmt, toDbTime } from '../utils/astana.js';
import {
  CoinsError, loginCoins, getCoinUser, changePassword, listProducts, addProduct, editProduct, spendCoins,
} from '../services/coins.js';
import {
  coinsLoginPage, coinsListPage, coinsHistoryPage, coinsProductsPage, coinsPasswordPage, absencesPage, absencesBroadcastPage, msgStatusText, fmtCoins,
} from './coinsViews.js';
import { LtcError, getAbsences, sendFeedback } from '../ltc/client.js';
import { hh } from '../hollihop/client.js';
import { createBroadcast, startWorker } from '../services/broadcast.js';
import { ROW_COLUMNS, toRecipients } from '../services/recipients.js';

/** Строки «Telegram-аккаунт ↔ ученик» для рассылки по списку учеников (ClientId); audience: all | parents | students. */
async function recipientRows(clientIds, audience = 'all') {
  if (!clientIds.length) return [];
  return query(
    `SELECT DISTINCT ${ROW_COLUMNS} FROM tg_users u
     JOIN tg_links l ON l.tg_user_id = u.id JOIN students s ON s.client_id = l.student_client_id
     WHERE u.is_subscribed = 1 AND u.is_blocked = 0 AND s.client_id IN (?)${audience === 'all' ? '' : ' AND l.relation = ?'}`,
    audience === 'all' ? [clientIds] : [clientIds, audience === 'parents' ? 'parent' : 'student'],
  );
}
/** Сколько людей и сообщений уйдёт каждой аудитории. */
async function recipientCounts(clientIds) {
  const rows = await recipientRows(clientIds);
  const count = (list) => ({ people: new Set(list.map((r) => r.chat_id)).size, messages: toRecipients(list, true).length });
  return {
    connected: new Set(rows.map((r) => r.student_client_id)).size,
    all: count(rows),
    parents: count(rows.filter((r) => r.relation === 'parent')),
    students: count(rows.filter((r) => r.relation === 'student')),
  };
}

/**
 * Данные HolliHop по ClientId ученика (в LTC studentId = ClientId HolliHop, не Id): кураторы (Assignees), «Статус звонка», «День обзвона постоянное».
 * Сначала из БД бота; учеников, которых там нет (например, статус не входит в RECIPIENT_STATUSES),
 * догружаем из HolliHop по ID (GetStudents), кэш 10 минут.
 */
const HH_CACHE_TTL = 10 * 60 * 1000;
const hhCache = new Map(); // client_id -> { at, info | null }
const fieldOf = (s, name) => String((s.ExtraFields || []).find((f) => String(f.Name ?? '').trim().toLowerCase() === name.toLowerCase())?.Value ?? '').trim();

async function fetchHhInfo(id) {
  const hit = hhCache.get(id);
  if (hit && Date.now() - hit.at < HH_CACHE_TTL) return hit.info;
  let info = null;
  try {
    const data = await hh('GetStudents', { clientId: id, take: 5 }, { retries: 1, timeoutMs: 15_000 });
    const s = (data.Students || []).find((x) => x.ClientId === id);
    if (s) {
      const as = (s.Assignees || []).filter((a) => a.Id);
      info = {
        client_id: s.ClientId,
        hh_id: s.Id,
        call_status: fieldOf(s, config.mentor.callStatusField) || null,
        call_day: fieldOf(s, config.mentor.callDayField) || null,
        assigneeIds: as.map((a) => a.Id),
        assignees: as.map((a) => a.FullName).filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru')).join(', '),
      };
    }
  } catch (err) {
    logger.warn({ id, err: err.message }, 'Пропуски: не удалось загрузить ученика из HolliHop');
    return null; // ошибку не кэшируем
  }
  hhCache.set(id, { at: Date.now(), info });
  return info;
}

async function hhInfoByIds(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = await query(
    `SELECT s.hh_id, s.client_id, s.call_status, s.call_day,
            GROUP_CONCAT(sa.employee_id) AS assignee_ids, GROUP_CONCAT(sa.full_name ORDER BY sa.full_name SEPARATOR ', ') AS assignees
     FROM students s LEFT JOIN student_assignees sa ON sa.student_client_id = s.client_id
     WHERE s.client_id IN (?) GROUP BY s.client_id, s.hh_id, s.call_status, s.call_day`,
    [ids],
  );
  for (const r of rows) {
    out.set(r.client_id, {
      client_id: r.client_id, hh_id: r.hh_id, call_status: r.call_status, call_day: r.call_day, assignees: r.assignees || '',
      assigneeIds: String(r.assignee_ids || '').split(',').filter(Boolean).map(Number),
    });
  }
  const missing = ids.filter((id) => !out.has(id));
  for (let i = 0; i < missing.length; i += 10) { // по 10 параллельно — далеко от лимита HolliHop
    const part = missing.slice(i, i + 10);
    const infos = await Promise.all(part.map(fetchHhInfo));
    part.forEach((id, k) => { if (infos[k]) out.set(id, infos[k]); });
  }
  return out;
}


const SENT_STATUS = 'Рассылка ушла'; // статус пропуска, который ставится сам после сообщения в бот
const PER_PAGE = 50;
const ABSENCES_PER_PAGE = 50;
/** Сегодня (YYYY-MM-DD) в часовом поясе школы. */
const todayLocal = () => new Date().toLocaleDateString('sv-SE', { timeZone: config.sync.timezone });
const fmtFeedbackAt = (iso) => (iso && !Number.isNaN(Date.parse(iso))
  ? new Date(iso).toLocaleString('ru-RU', { timeZone: config.sync.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '');
const HISTORY_PER_PAGE = 100;
const COOKIE = 'csid';
const SESSION_TTL = 12 * 60 * 60 * 1000;

const BRANCHES_SUB = `(SELECT GROUP_CONCAT(b.name ORDER BY b.name SEPARATOR ', ')
  FROM student_branches sb JOIN branches b ON b.id = sb.branch_id WHERE sb.student_client_id = s.client_id)`;
const ASSIGNEES_SUB = `(SELECT GROUP_CONCAT(sa.full_name ORDER BY sa.full_name SEPARATOR ', ')
  FROM student_assignees sa WHERE sa.student_client_id = s.client_id)`;
const MINE = 'EXISTS (SELECT 1 FROM student_assignees sa WHERE sa.student_client_id = s.client_id AND sa.employee_id = ?)';

const toId = (v) => (/^\d{1,10}$/.test(String(v ?? '')) ? Number(v) : null);
const toDay = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) && !Number.isNaN(Date.parse(v)) ? String(v) : '');
const page = (v) => Math.max(1, parseInt(v, 10) || 1);
const like = (w) => `%${w.replace(/[\\%_]/g, '\\$&')}%`;

/** Поиск ученика: число — ID HolliHop / ClientId, иначе слова ФИО. */
function searchConds(q, cols) {
  if (!q) return { conds: [], params: [] };
  if (/^\d+$/.test(q)) return { conds: [`(${cols.ids.map((c) => `${c} = ?`).join(' OR ')})`], params: cols.ids.map(() => Number(q)) };
  const conds = [];
  const params = [];
  for (const w of q.split(/\s+/).slice(0, 4)) {
    conds.push(`(${cols.names.map((c) => `${c} LIKE ?`).join(' OR ')})`);
    params.push(...cols.names.map(() => like(w)));
  }
  return { conds, params };
}

/**
 * Раздел «Коины» (/coins): своя сессия, вход по ID сотрудника HolliHop.
 * deps — общие помощники веб-админки (подпись, cookie, лимит попыток входа, Excel).
 */
export function registerCoins(app, { sign, readCookie, tooManyAttempts, addAttempt, wrap, sendXlsx, bot = null }) {
  const makeToken = (id) => {
    const payload = `${id}.${Date.now() + SESSION_TTL}`;
    return `${payload}.${sign(`coins:${payload}`)}`;
  };
  function tokenId(tok) {
    const [id, exp, sig] = String(tok ?? '').split('.');
    if (!/^\d+$/.test(id ?? '') || !exp || !sig || Number(exp) < Date.now()) return null;
    const a = Buffer.from(sig);
    const b = Buffer.from(sign(`coins:${id}.${exp}`));
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? Number(id) : null;
  }
  const csrfOf = (req) => sign(`coins-csrf:${readCookie(req, COOKIE)}`);
  const csrfOk = (req) => {
    const a = Buffer.from(String(req.body?.csrf ?? ''));
    const b = Buffer.from(csrfOf(req));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const requireCoins = wrap(async (req, res, next) => {
    const id = tokenId(readCookie(req, COOKIE));
    const user = id && (await getCoinUser(id));
    if (!user) return res.redirect('/coins/login');
    req.coinUser = user;
    return next();
  });
  const requireHead = (req, res, next) => (req.coinUser.isHead ? next() : res.status(403).send(coinsLoginPage('Раздел доступен только руководителям менторов.')));

  /** Ученики, за которых кто-то отвечает: для фильтра «Ментор». */
  const mentorsList = async () => (await query(
    `SELECT employee_id AS id, MAX(full_name) AS name, COUNT(*) AS n FROM student_assignees GROUP BY employee_id ORDER BY name`,
  )).map((m) => ({ ...m, name: m.name || `ID ${m.id}` }));

  // ---------- вход ----------
  app.get('/coins/login', (req, res) => res.send(coinsLoginPage(null, true)));

  app.post('/coins/login', wrap(async (req, res) => {
    if (tooManyAttempts(req.ip)) return res.status(429).send(coinsLoginPage('Слишком много попыток. Попробуйте позже.', true));
    const user = await loginCoins(req.body.login, req.body.password ?? '');
    if (!user) {
      addAttempt(req.ip);
      return res.status(401).send(coinsLoginPage('Неверный ID или пароль', true));
    }
    res.cookie(COOKIE, makeToken(user.id), { httpOnly: true, sameSite: 'strict', secure: config.web.secureCookie, maxAge: SESSION_TTL });
    logger.info({ employee: user.id }, 'Коины: вход');
    return res.redirect('/coins');
  }));

  app.get('/coins/logout', (req, res) => {
    res.clearCookie(COOKIE);
    res.redirect('/coins/login');
  });

  // ---------- ученики и списание ----------
  const listFilters = (q, user) => ({ q: String(q.q || '').trim().slice(0, 100), mentor: user.isHead ? toId(q.mentor) : null });

  async function renderList(req, res, { ok = null, error = null, status = 200 } = {}) {
    const user = req.coinUser;
    const f = listFilters(req.query, user);
    const p = page(req.query.page);
    const conds = [];
    const params = [];
    const owner = user.isHead ? f.mentor : user.id;
    if (owner) { conds.push(MINE); params.push(owner); }
    const s = searchConds(f.q, { ids: ['s.hh_id', 's.client_id'], names: ['s.last_name', 's.first_name', 's.middle_name'] });
    conds.push(...s.conds);
    params.push(...s.params);
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const [{ n, sum }] = await query(`SELECT COUNT(*) AS n, SUM(s.coins) AS sum FROM students s ${where}`, params);
    const rows = await query(
      `SELECT s.client_id, s.hh_id, s.last_name, s.first_name, s.middle_name, s.status, s.coins,
              ${BRANCHES_SUB} AS branches${user.isHead ? `, ${ASSIGNEES_SUB} AS assignees` : ''}
       FROM students s ${where} ORDER BY s.last_name, s.first_name, s.client_id LIMIT ? OFFSET ?`,
      [...params, PER_PAGE, (p - 1) * PER_PAGE],
    );
    res.status(status).send(coinsListPage({
      user, rows, total: Number(n), sumCoins: sum ?? 0, page: p, pages: Math.max(1, Math.ceil(Number(n) / PER_PAGE)), f,
      mentors: user.isHead ? await mentorsList() : [], products: await listProducts(), csrf: csrfOf(req), ok, error,
    }));
  }

  app.get('/coins', requireCoins, wrap(async (req, res) => {
    let ok = null;
    const logId = toId(req.query.ok);
    if (logId) {
      const [r] = await query("SELECT * FROM coin_log WHERE id = ? AND action = 'spend' AND employee_id = ?", [logId, req.coinUser.id]);
      if (r) ok = `Списано ${fmtCoins(r.price)} за «${r.product_name}» у ${r.student_name}: было ${fmtCoins(r.coins_before)}, стало ${fmtCoins(r.coins_after)}.`;
    }
    await renderList(req, res, { ok });
  }));

  app.post('/coins/spend', requireCoins, wrap(async (req, res) => {
    // после ошибки показываем тот же список, с которого отправили форму
    const back = String(req.body.back ?? '');
    const backUrl = back.startsWith('/coins') && !back.startsWith('//') ? back : '/coins';
    req.query = Object.fromEntries(new URLSearchParams(backUrl.split('?')[1] || ''));
    if (!csrfOk(req)) return renderList(req, res, { error: 'Сессия устарела — обновите страницу и повторите.', status: 403 });
    const clientId = toId(req.body.client_id);
    const productId = toId(req.body.product_id);
    if (!clientId || !productId) return renderList(req, res, { error: 'Выберите товар.', status: 400 });
    try {
      const id = await spendCoins(req.coinUser, clientId, productId);
      const sep = backUrl.includes('?') ? '&' : '?';
      return res.redirect(`${backUrl}${sep}ok=${id}`);
    } catch (err) {
      if (!(err instanceof CoinsError)) logger.error({ err, clientId, productId }, 'Коины: ошибка списания');
      const error = err instanceof CoinsError ? err.message : 'Не удалось записать коины в HolliHop — ничего не списано. Попробуйте ещё раз.';
      return renderList(req, res, { error, status: 400 });
    }
  }));

  // ---------- история ----------
  function historyWhere(req) {
    const user = req.coinUser;
    const f = {
      q: String(req.query.q || '').trim().slice(0, 100),
      mentor: user.isHead ? toId(req.query.mentor) : null,
      action: ['spend', 'product_add', 'product_edit'].includes(req.query.action) ? req.query.action : '',
      from: toDay(req.query.from),
      to: toDay(req.query.to),
    };
    const conds = [];
    const params = [];
    const who = user.isHead ? f.mentor : user.id; // ментор видит только свои действия
    if (who) { conds.push('c.employee_id = ?'); params.push(who); }
    if (f.action) { conds.push('c.action = ?'); params.push(f.action); }
    if (f.from) { conds.push(`c.created_at >= ${toDbTime('?')}`); params.push(`${f.from} 00:00:00`); }
    if (f.to) { conds.push(`c.created_at < ${toDbTime('DATE_ADD(?, INTERVAL 1 DAY)')}`); params.push(`${f.to} 00:00:00`); }
    const s = searchConds(f.q, { ids: ['c.student_hh_id', 'c.student_client_id'], names: ['c.student_name'] });
    conds.push(...s.conds);
    params.push(...s.params);
    return { f, sql: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params };
  }

  app.get('/coins/history', requireCoins, wrap(async (req, res) => {
    const w = historyWhere(req);
    const p = page(req.query.page);
    const [{ n }] = await query(`SELECT COUNT(*) AS n FROM coin_log c ${w.sql}`, w.params);
    const rows = await query(
      `SELECT c.*, ${astanaFmt('c.created_at')} AS at FROM coin_log c ${w.sql} ORDER BY c.id DESC LIMIT ? OFFSET ?`,
      [...w.params, HISTORY_PER_PAGE, (p - 1) * HISTORY_PER_PAGE],
    );
    res.send(coinsHistoryPage({
      user: req.coinUser, rows, total: Number(n), page: p, pages: Math.max(1, Math.ceil(Number(n) / HISTORY_PER_PAGE)), f: w.f,
      mentors: req.coinUser.isHead ? (await query('SELECT employee_id AS id, MAX(employee_name) AS name, COUNT(*) AS n FROM coin_log GROUP BY employee_id ORDER BY name')) : [],
    }));
  }));

  app.get('/coins/history.xlsx', requireCoins, wrap(async (req, res) => {
    const w = historyWhere(req);
    const rows = await query(`SELECT c.*, ${astanaFmt('c.created_at')} AS at FROM coin_log c ${w.sql} ORDER BY c.id DESC LIMIT 100000`, w.params);
    const action = { spend: 'Списание', product_add: 'Новый товар', product_edit: 'Изменение товара' };
    const num = (v) => (v === null ? '' : Number(v));
    await sendXlsx(res, 'koiny-istoriya.xlsx', 'История',
      [{ header: 'Когда (Астана)', width: 17 }, { header: 'Действие', width: 16 }, { header: 'Кто', width: 26 }, { header: 'ID сотрудника', width: 10 },
        { header: 'ID HolliHop', width: 12 }, { header: 'Ученик', width: 30 }, { header: 'Товар', width: 26 }, { header: 'Цена', width: 10 },
        { header: 'Было', width: 10 }, { header: 'Стало', width: 10 }, { header: 'Примечание', width: 40 }],
      rows.map((r) => [r.at, action[r.action] || r.action, r.employee_name, r.employee_id, r.student_hh_id, r.student_name,
        r.product_name, num(r.price), num(r.coins_before), num(r.coins_after), r.note]));
  }));

  // ---------- товары (руководители) ----------
  async function renderProducts(req, res, { ok = null, error = null, status = 200 } = {}) {
    res.status(status).send(coinsProductsPage({ user: req.coinUser, products: await listProducts({ all: true }), csrf: csrfOf(req), ok, error }));
  }
  app.get('/coins/products', requireCoins, requireHead, wrap((req, res) => renderProducts(req, res)));

  app.post('/coins/products', requireCoins, requireHead, wrap(async (req, res) => {
    if (!csrfOk(req)) return renderProducts(req, res, { error: 'Сессия устарела — обновите страницу.', status: 403 });
    try {
      await addProduct(req.coinUser, req.body);
      return renderProducts(req, res, { ok: 'Товар добавлен.' });
    } catch (err) {
      if (err instanceof CoinsError) return renderProducts(req, res, { error: err.message, status: 400 });
      throw err;
    }
  }));

  app.post('/coins/products/:id', requireCoins, requireHead, wrap(async (req, res) => {
    if (!csrfOk(req)) return renderProducts(req, res, { error: 'Сессия устарела — обновите страницу.', status: 403 });
    const id = toId(req.params.id);
    try {
      if (!id) throw new CoinsError('Товар не найден.');
      await editProduct(req.coinUser, id, { ...req.body, active: req.body.active === '1' });
      return renderProducts(req, res, { ok: 'Сохранено.' });
    } catch (err) {
      if (err instanceof CoinsError) return renderProducts(req, res, { error: err.message, status: 400 });
      throw err;
    }
  }));

  // ---------- пропуски учеников (LTC API) ----------
  /**
   * Фильтры: период (по умолчанию с 1-го числа месяца по сегодня), поиск, куратор (руководителям),
   * обратная связь (none — нет, done — есть, или конкретный статус), день обзвона.
   */
  function absenceFilters(q, user) {
    const today = todayLocal();
    let from = toDay(q.from) || `${today.slice(0, 8)}01`;
    let to = toDay(q.to) || today;
    if (from > to) [from, to] = [to, from];
    return {
      from,
      to,
      q: String(q.q || '').trim().slice(0, 100),
      mentor: user.isHead ? toId(q.mentor) : null,
      fb: String(q.fb || '').slice(0, 64),
      day: String(q.day || '').slice(0, 64),
      msg: ['sent', 'none'].includes(q.msg) ? q.msg : '',
    };
  }

  /**
   * Последнее сообщение в бот по каждому ученику за период, пересекающийся с выбранным,
   * и как прошла доставка: { at, by, audience, total, sent, failed, blocked, status }.
   */
  async function lastMessages(ids, f) {
    const out = new Map();
    if (!ids.length) return out;
    const rows = await query(
      `SELECT m.student_client_id, m.audience, m.employee_name, ${astanaFmt('m.created_at')} AS at,
              b.status, b.total, b.sent, b.failed, b.blocked
       FROM absence_messages m JOIN broadcasts b ON b.id = m.broadcast_id
       WHERE m.student_client_id IN (?) AND m.period_from <= ? AND m.period_to >= ?
       ORDER BY m.id`,
      [ids, f.to, f.from],
    );
    for (const r of rows) {
      out.set(r.student_client_id, {
        at: r.at, by: r.employee_name || '', audience: r.audience, status: r.status,
        total: Number(r.total), sent: Number(r.sent), failed: Number(r.failed), blocked: Number(r.blocked),
      });
    }
    return out;
  }

  /** Список LTC + данные HolliHop из БД по HollyHop ID: кураторы, статус звонка, день обзвона. */
  async function absenceRows(user, f, { refresh = false } = {}) {
    const data = await getAbsences(f.from, f.to, { refresh });
    const students = data.students || [];
    const ids = [...new Set(students.map((x) => Number(x.studentId)).filter(Number.isSafeInteger))];
    const byId = await hhInfoByIds(ids);
    const hhBy = new Map([...byId].map(([id, v]) => [String(id), v]));
    const msgBy = await lastMessages(ids, f);
    const owner = user.isHead ? f.mentor : user.id;
    const isNum = /^\d+$/.test(f.q);
    const words = isNum ? [] : f.q.toLowerCase().split(/\s+/).filter(Boolean);
    const mine = students
      .map((x) => {
        const h = hhBy.get(String(x.studentId)) || null;
        return {
          ...x,
          hh: h,
          groupsText: x.group || (x.groups || []).map((g) => g.name).join(', '),
          callStatus: h?.call_status || '',
          callDay: h?.call_day || '',
          feedbackAtText: fmtFeedbackAt(x.feedback?.feedbackAt),
          msg: msgBy.get(Number(x.studentId)) || null,
        };
      })
      .filter((x) => !owner || x.hh?.assigneeIds.includes(owner));
    const rows = mine.filter((x) => {
      if (isNum && String(x.studentId) !== f.q && String(x.hh?.hh_id ?? '') !== f.q) return false;
      if (words.length && !words.every((w) => String(x.student || '').toLowerCase().includes(w))) return false;
      if (f.msg === 'sent' && !x.msg) return false;
      if (f.msg === 'none' && x.msg) return false;
      if (f.fb === 'none') return !x.feedback && (!f.day || x.callDay === f.day);
      if (f.fb === 'done' && !x.feedback) return false;
      if (f.fb && f.fb !== 'done' && x.feedback?.status !== f.fb) return false;
      return !f.day || x.callDay === f.day;
    });
    const days = [...new Set(mine.map((x) => x.callDay).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    return { rows, total: mine.length, days };
  }

  async function renderAbsences(req, res, { ok = null, error = null, status = 200 } = {}) {
    const user = req.coinUser;
    const f = absenceFilters(req.query, user);
    let data = { rows: [], total: 0, days: [] };
    let loadError = null;
    try {
      data = await absenceRows(user, f, { refresh: req.query.refresh === '1' });
    } catch (err) {
      if (!(err instanceof LtcError)) throw err;
      loadError = err.message;
    }
    const pages = Math.max(1, Math.ceil(data.rows.length / ABSENCES_PER_PAGE));
    const p = Math.min(page(req.query.page), pages);
    const pageRows = data.rows.slice((p - 1) * ABSENCES_PER_PAGE, p * ABSENCES_PER_PAGE);
    // сколько Telegram-аккаунтов (родители / сам ученик) подключено к боту у каждого ученика на странице
    const tg = new Map();
    for (const r of await recipientRows(pageRows.map((x) => Number(x.studentId)).filter(Number.isSafeInteger))) {
      const c = tg.get(r.student_client_id) || { parents: 0, students: 0 };
      c[r.relation === 'parent' ? 'parents' : 'students'] += 1;
      tg.set(r.student_client_id, c);
    }
    res.status(status).send(absencesPage({
      user, f, page: p, pages, shown: data.rows.length, total: data.total, days: data.days,
      rows: pageRows.map((x) => ({ ...x, tg: tg.get(Number(x.studentId)) || { parents: 0, students: 0 } })),
      mentors: user.isHead ? await mentorsList() : [], statuses: config.ltc.absenceStatuses, reasons: config.ltc.absenceReasons,
      csrf: csrfOf(req), ok, error: error || loadError,
    }));
  }

  app.get('/coins/absences', requireCoins, wrap(async (req, res) => {
    let ok = /^\d+$/.test(String(req.query.ok ?? '')) ? `Сохранено: статус пропуска ученика (ClientId ${req.query.ok}) отправлен в LTC.` : null;
    const sent = toId(req.query.sent);
    if (sent) {
      const [b] = await query('SELECT id, total, title FROM broadcasts WHERE id = ?', [sent]);
      if (b) ok = `Сообщение отправляется (${b.total} сообщ.): ${b.title}.`;
    }
    await renderAbsences(req, res, { ok });
  }));

  // ---------- сообщение в бот по одному ученику ----------
  const AUDIENCE_LABEL = { all: 'родители и ученик', parents: 'родители', students: 'ученик' };
  const backParams = (f) => Object.fromEntries(Object.entries({ from: f.from, to: f.to, q: f.q, mentor: f.mentor ?? '', fb: f.fb, day: f.day, msg: f.msg })
    .filter(([, v]) => v !== '' && v !== null));
  const studentParam = (v) => (/^\d{1,12}$/.test(String(v ?? '')) ? String(v) : null);

  /** Ученик из списка пропусков (куратор — только свой) или null. */
  async function absenceStudent(user, f, studentId) {
    if (!studentId) return null;
    const { rows } = await absenceRows(user, { ...f, q: '', fb: '', day: '' });
    return rows.find((r) => String(r.studentId) === studentId) || null;
  }

  async function renderMessage(req, res, f, studentId, { error = null, status = 200, text = '', audience = 'parents' } = {}) {
    let st = null;
    let loadError = null;
    try {
      st = await absenceStudent(req.coinUser, f, studentId);
      if (!st) loadError = 'Ученик не найден в вашем списке пропусков за этот период.';
    } catch (err) {
      if (!(err instanceof LtcError)) throw err;
      loadError = err.message;
    }
    res.status(status).send(absencesBroadcastPage({
      user: req.coinUser, f: backParams(f), student: st,
      counts: st ? await recipientCounts([Number(st.studentId)]) : { connected: 0, all: { people: 0, messages: 0 }, parents: { people: 0, messages: 0 }, students: { people: 0, messages: 0 } },
      csrf: csrfOf(req), error: error || loadError, text, audience, botReady: Boolean(bot),
    }));
  }

  app.get('/coins/absences/message', requireCoins, wrap((req, res) =>
    renderMessage(req, res, absenceFilters(req.query, req.coinUser), studentParam(req.query.student))));

  app.post('/coins/absences/message', requireCoins, wrap(async (req, res) => {
    const user = req.coinUser;
    const f = absenceFilters(req.body, user);
    const studentId = studentParam(req.body.student);
    const text = String(req.body.text ?? '').trim();
    const audience = ['all', 'parents', 'students'].includes(req.body.audience) ? req.body.audience : 'parents';
    const fail = (error, status = 400) => renderMessage(req, res, f, studentId, { error, status, text, audience });
    if (!csrfOk(req)) return fail('Сессия устарела — обновите страницу и повторите.', 403);
    if (!bot) return fail('Бот недоступен — сообщение отправить нельзя.', 500);
    if (!text) return fail('Введите текст сообщения.');
    if (text.length > 3800) return fail('Текст длиннее 3800 символов (с учётом обращения к родителю).');

    let st;
    try {
      st = await absenceStudent(user, f, studentId);
    } catch (err) {
      if (err instanceof LtcError) return fail(err.message, 502);
      throw err;
    }
    if (!st) return fail('Ученик не найден в вашем списке пропусков за этот период.', 404);
    const title = `Пропуски ${f.from} — ${f.to} · ${st.student} (ClientId ${st.studentId}) · ${AUDIENCE_LABEL[audience]} · отправил(а): ${user.name}`;

    // защита от двойной отправки одному и тому же ученику (двойной клик)
    const [dup] = await query('SELECT id FROM broadcasts WHERE text = ? AND title = ? AND created_at > (NOW() - INTERVAL 1 MINUTE) LIMIT 1', [text, title.slice(0, 250)]);
    if (dup) return fail('Это сообщение этому ученику уже отправлено минуту назад.');

    const recipients = toRecipients(await recipientRows([Number(st.studentId)], audience), true); // родителю — с обращением по имени ученика
    if (!recipients.length) return fail('Получатели не подключены к боту — отправить некому.');
    const { id, total } = await createBroadcast({ adminChatId: config.adminIds[0] ?? 0, audience, recipients, text, parseMode: null, title });
    await query(
      'INSERT INTO absence_messages (broadcast_id, student_client_id, period_from, period_to, audience, employee_id, employee_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, Number(st.studentId), f.from, f.to, audience, user.id, user.name],
    );
    startWorker(bot);
    logger.info({ employee: user.id, broadcast: id, total, studentId: st.studentId }, 'Пропуски: сообщение ученику отправлено');
    // статуса пропуска ещё нет — ставим «Рассылка ушла» в LTC (уже выставленный статус не трогаем)
    if (!st.feedback && config.ltc.absenceStatuses.includes(SENT_STATUS)) {
      try {
        await sendFeedback({
          studentId: String(st.studentId),
          student: String(st.student || '').slice(0, 255),
          groups: st.groupsText,
          ...(Number.isInteger(st.lessons) && st.lessons >= 0 ? { lessons: st.lessons } : {}),
          period: { from: f.from, to: f.to },
          status: SENT_STATUS,
          reason: '',
          mentor: user.name.slice(0, 255),
          feedbackAt: new Date().toISOString(),
        });
      } catch (err) {
        logger.warn({ studentId: st.studentId, err: err.message }, 'Пропуски: не удалось поставить статус «Рассылка ушла» в LTC');
      }
    }
    const back = new URLSearchParams(backParams(f));
    back.set('sent', String(id));
    return res.redirect(`/coins/absences?${back}#s${st.studentId}`);
  }));

  app.post('/coins/absences/feedback', requireCoins, wrap(async (req, res) => {
    // после ошибки показываем тот же список, с которого отправили форму
    const back = String(req.body.back ?? '');
    const backUrl = back.startsWith('/coins/absences') && !back.startsWith('//') ? back : '/coins/absences';
    req.query = Object.fromEntries(new URLSearchParams(backUrl.split('?')[1] || ''));
    delete req.query.ok;
    const fail = (error, status = 400) => renderAbsences(req, res, { error, status });
    if (!csrfOk(req)) return fail('Сессия устарела — обновите страницу и повторите.', 403);

    const user = req.coinUser;
    const studentId = /^\d{1,12}$/.test(String(req.body.student_id ?? '')) ? String(req.body.student_id) : null;
    const from = toDay(req.body.from);
    const to = toDay(req.body.to);
    const st = String(req.body.status ?? '').trim();
    const reason = String(req.body.reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!studentId || !from || !to || from > to) return fail('Не удалось определить ученика или период — обновите страницу.');
    if (!config.ltc.absenceStatuses.includes(st)) return fail('Выберите статус пропуска из списка.');

    try {
      // данные ученика берём из выгрузки LTC за тот же период, а не из формы
      const data = await getAbsences(from, to);
      const x = (data.students || []).find((s) => String(s.studentId) === studentId);
      if (!x) return fail('Ученика нет в списке пропусков за этот период — обновите страницу.');
      if (!user.isHead) {
        const info = (await hhInfoByIds([Number(studentId)])).get(Number(studentId));
        if (!info?.assigneeIds.includes(user.id)) return fail('Этот ученик не закреплён за вами в HolliHop.', 403);
      }
      await sendFeedback({
        studentId,
        student: String(x.student || '').slice(0, 255),
        groups: x.group || (x.groups || []).map((g) => g.name).join(', '),
        ...(Number.isInteger(x.lessons) && x.lessons >= 0 ? { lessons: x.lessons } : {}),
        period: { from, to },
        status: st.slice(0, 64),
        reason,
        mentor: user.name.slice(0, 255),
        feedbackAt: new Date().toISOString(),
      });
      logger.info({ employee: user.id, studentId, from, to, status: st }, 'Пропуски: обратная связь отправлена в LTC');
      const clean = backUrl.replace(/([?&])ok=\d+&?/, '$1').replace(/[?&]$/, '');
      return res.redirect(`${clean}${clean.includes('?') ? '&' : '?'}ok=${studentId}#s${studentId}`);
    } catch (err) {
      if (err instanceof LtcError) return fail(`Не сохранено: ${err.message}`);
      throw err;
    }
  }));

  app.get('/coins/absences.xlsx', requireCoins, wrap(async (req, res) => {
    const f = absenceFilters(req.query, req.coinUser);
    let rows;
    try {
      ({ rows } = await absenceRows(req.coinUser, f));
    } catch (err) {
      if (err instanceof LtcError) return res.status(502).send(err.message);
      throw err;
    }
    return sendXlsx(res, `propuski-${f.from}-${f.to}.xlsx`, 'Пропуски',
      [{ header: 'ID HolliHop', width: 12 }, { header: 'ClientId', width: 10 }, { header: 'Ученик', width: 32 }, { header: 'Группы', width: 34 }, { header: 'Куратор', width: 26 },
        { header: 'Уроков', width: 8 }, { header: 'Пропусков', width: 10 }, { header: '% пропусков', width: 11 },
        { header: 'Статус звонка', width: 16 }, { header: 'День обзвона постоянное', width: 14 },
        { header: 'Статус пропуска', width: 22 }, { header: 'Причина', width: 34 }, { header: 'Кто дал ОС', width: 22 }, { header: 'Дата ОС (Астана)', width: 17 },
        { header: 'Сообщение в бот', width: 22 }, { header: 'Когда (Астана)', width: 17 }, { header: 'Кто отправил', width: 22 }],
      rows.map((r) => [r.hh?.hh_id ?? '', Number(r.studentId), r.student, r.groupsText, r.hh?.assignees || '', r.lessons, r.absent, Math.round((r.rate || 0) * 100),
        r.callStatus, r.callDay, r.feedback?.status || '', r.feedback?.reason || '', r.feedback?.mentor || '', r.feedbackAtText,
        msgStatusText(r.msg), r.msg?.at || '', r.msg?.by || '']));
  }));

  // ---------- смена пароля ----------
  app.get('/coins/password', requireCoins, (req, res) => res.send(coinsPasswordPage({ user: req.coinUser, csrf: csrfOf(req) })));

  app.post('/coins/password', requireCoins, wrap(async (req, res) => {
    const render = (o, status = 200) => res.status(status).send(coinsPasswordPage({ user: req.coinUser, csrf: csrfOf(req), ...o }));
    if (!csrfOk(req)) return render({ error: 'Сессия устарела — обновите страницу.' }, 403);
    if (String(req.body.next ?? '') !== String(req.body.repeat ?? '')) return render({ error: 'Новые пароли не совпадают.' }, 400);
    try {
      await changePassword(req.coinUser, req.body.current ?? '', req.body.next ?? '');
      return render({ ok: 'Пароль изменён.' });
    } catch (err) {
      if (err instanceof CoinsError) return render({ error: err.message }, 400);
      throw err;
    }
  }));
}
