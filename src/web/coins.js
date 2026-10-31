import crypto from 'node:crypto';
import { config } from '../config.js';
import { query } from '../db.js';
import { logger } from '../logger.js';
import { astanaFmt, toDbTime } from '../utils/astana.js';
import {
  CoinsError, loginCoins, getCoinUser, changePassword, listProducts, addProduct, editProduct, spendCoins,
} from '../services/coins.js';
import { coinsLoginPage, coinsListPage, coinsHistoryPage, coinsProductsPage, coinsPasswordPage, fmtCoins } from './coinsViews.js';

const PER_PAGE = 50;
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
export function registerCoins(app, { sign, readCookie, tooManyAttempts, addAttempt, wrap, sendXlsx }) {
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
