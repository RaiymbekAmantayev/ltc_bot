import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { hh } from '../hollihop/client.js';
import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Коины учеников: пользовательское поле HolliHop (COINS_FIELD, по умолчанию «Коины»).
 * Списывать можно только за товар из списка; каждое списание пишется в HolliHop и в журнал coin_log.
 * Значение перед списанием всегда берётся из HolliHop заново, а не из локальной БД.
 */
const scrypt = promisify(crypto.scrypt);
const CACHE_TTL = 10 * 60 * 1000;

export class CoinsError extends Error {}

const isCoinsField = (f) => String(f.Name ?? '').trim().toLowerCase() === config.coins.field.toLowerCase();

/** Число из текста поля («1 801,2» → 1801.2); пусто или не число — null. */
export function parseCoins(v) {
  const n = Number(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return String(v ?? '').trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 100) / 100;
}
/** Коины ученика из ответа GetStudents. */
export const coinsOf = (s) => parseCoins((s.ExtraFields || []).find(isCoinsField)?.Value);
/** 1701.2 → '1701.2', 1700 → '1700' (так же, как значение выглядит в HolliHop). */
const coinsText = (n) => String(Math.round(n * 100) / 100);
const round2 = (n) => Math.round(n * 100) / 100;

export const studentName = (s) => [s.LastName, s.FirstName, s.MiddleName].filter(Boolean).join(' ');

// ---------- сотрудники и пароли ----------
let employees = { at: 0, byId: new Map() };
/** Сотрудники HolliHop (GetEmployees), кэш на 10 минут. */
async function getEmployees() {
  if (Date.now() - employees.at < CACHE_TTL) return employees.byId;
  const { Employees = [] } = await hh('GetEmployees', {}, { retries: 1, timeoutMs: 15_000 });
  const byId = new Map(Employees.map((e) => [e.Id, { id: e.Id, name: [e.LastName, e.FirstName].filter(Boolean).join(' '), fired: Boolean(e.Fired) }]));
  employees = { at: Date.now(), byId };
  return byId;
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = await scrypt(String(password), salt, 32);
  return `${salt}:${hash.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const a = await scrypt(String(password), salt, 32);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const isHead = (id) => config.coins.headIds.includes(id);
const toUser = (row) => ({ id: row.employee_id, name: row.full_name || `ID ${row.employee_id}`, isHead: isHead(row.employee_id), pwd: row.password_hash });

/** Пользователь коинов по ID (для сессии) или null. */
export async function getCoinUser(id) {
  const [row] = await query('SELECT employee_id, full_name, password_hash FROM coin_accounts WHERE employee_id = ?', [id]);
  return row ? toUser(row) : null;
}

/**
 * Вход по ID сотрудника HolliHop. Если входит впервые — пароль по умолчанию (COINS_DEFAULT_PASSWORD),
 * и только для работающего (не уволенного) сотрудника.
 */
export async function loginCoins(login, password) {
  const id = /^\d{1,10}$/.test(String(login ?? '').trim()) ? Number(String(login).trim()) : null;
  if (!id) return null;
  const user = await getCoinUser(id);
  if (user) return (await checkPassword(password, user.pwd)) ? user : null;

  if (String(password) !== config.coins.defaultPassword) return null;
  const emp = (await getEmployees()).get(id);
  if (!emp || emp.fired) return null;
  await query('INSERT IGNORE INTO coin_accounts (employee_id, full_name, password_hash) VALUES (?, ?, ?)', [id, emp.name, await hashPassword(password)]);
  return getCoinUser(id);
}

export async function changePassword(user, current, next) {
  if (!(await checkPassword(current, user.pwd))) throw new CoinsError('Текущий пароль неверный.');
  if (String(next).length < 6) throw new CoinsError('Новый пароль — не короче 6 символов.');
  if (String(next) === config.coins.defaultPassword) throw new CoinsError('Новый пароль не должен совпадать с паролем по умолчанию.');
  await query('UPDATE coin_accounts SET password_hash = ? WHERE employee_id = ?', [await hashPassword(next), user.id]);
}

// ---------- товары ----------
/** Цена из формы: положительное число, до 2 знаков после запятой. */
export function parsePrice(v) {
  const s = String(v ?? '').replace(/\s/g, '').replace(',', '.');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
}
const cleanName = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 255);

export const listProducts = ({ all = false } = {}) =>
  query(`SELECT id, name, price, is_active FROM coin_products ${all ? '' : 'WHERE is_active = 1'} ORDER BY is_active DESC, price, name`);

export async function addProduct(user, { name, price }) {
  const n = cleanName(name);
  const p = parsePrice(price);
  if (!n) throw new CoinsError('Введите название товара.');
  if (!p) throw new CoinsError('Цена — положительное число (например 150 или 99.5).');
  const r = await query('INSERT INTO coin_products (name, price, created_by) VALUES (?, ?, ?)', [n, p, user.id]);
  await log(user, { action: 'product_add', product_id: r.insertId, product_name: n, price: p });
}

export async function editProduct(user, id, { name, price, active }) {
  const [old] = await query('SELECT * FROM coin_products WHERE id = ?', [id]);
  if (!old) throw new CoinsError('Товар не найден.');
  const n = cleanName(name);
  const p = parsePrice(price);
  if (!n) throw new CoinsError('Введите название товара.');
  if (!p) throw new CoinsError('Цена — положительное число (например 150 или 99.5).');
  const isActive = active ? 1 : 0;
  await query('UPDATE coin_products SET name = ?, price = ?, is_active = ? WHERE id = ?', [n, p, isActive, id]);
  const changes = [
    old.name !== n && `название: «${old.name}» → «${n}»`,
    Number(old.price) !== p && `цена: ${coinsText(Number(old.price))} → ${coinsText(p)}`,
    old.is_active !== isActive && (isActive ? 'снова в выборе' : 'скрыт из выбора'),
  ].filter(Boolean);
  if (changes.length) await log(user, { action: 'product_edit', product_id: id, product_name: n, price: p, note: changes.join('; ') });
}

// ---------- журнал ----------
async function log(user, row) {
  const r = await query(
    `INSERT INTO coin_log (action, employee_id, employee_name, student_client_id, student_hh_id, student_name,
       product_id, product_name, price, coins_before, coins_after, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.action, user.id, user.name, row.student_client_id ?? null, row.student_hh_id ?? null, row.student_name ?? null,
      row.product_id ?? null, row.product_name ?? null, row.price ?? null, row.coins_before ?? null, row.coins_after ?? null,
      row.note ? String(row.note).slice(0, 500) : null],
  );
  return r.insertId;
}

// ---------- списание ----------
const locks = new Map(); // client_id -> Promise: списания одному ученику идут по очереди
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

async function fetchStudent(clientId) {
  const data = await hh('GetStudents', { clientId, take: 5 }, { retries: 1, timeoutMs: 15_000 });
  return (data.Students || []).find((x) => x.ClientId === clientId) || null;
}

/**
 * Списать цену товара с коинов ученика. Ментор — только у своего ученика (он в Assignees в HolliHop),
 * руководитель — у любого. Возвращает id записи журнала.
 */
export function spendCoins(user, clientId, productId) {
  return withLock(clientId, async () => {
    const [product] = await query('SELECT id, name, price FROM coin_products WHERE id = ? AND is_active = 1', [productId]);
    if (!product) throw new CoinsError('Товар не найден или скрыт — обновите страницу.');
    const price = Number(product.price);

    const s = await fetchStudent(clientId);
    if (!s) throw new CoinsError('Ученик не найден в HolliHop.');
    if (!user.isHead && !(s.Assignees || []).some((a) => a.Id === user.id)) {
      throw new CoinsError('Этот ученик не закреплён за вами в HolliHop.');
    }
    const before = coinsOf(s) ?? 0;
    if (before < price) {
      throw new CoinsError(`Недостаточно коинов: у ученика ${coinsText(before)}, товар «${product.name}» стоит ${coinsText(price)}.`);
    }
    const after = round2(before - price);

    // передаём все пользовательские поля, меняя только коины, — чтобы остальные поля точно не стёрлись
    const fields = (s.ExtraFields || []).map((f) => ({ Name: f.Name, Value: isCoinsField(f) ? coinsText(after) : (f.Value ?? '') }));
    if (!fields.some(isCoinsField)) fields.push({ Name: config.coins.field, Value: coinsText(after) });
    await hh('EditUserExtraFields', { StudentClientId: clientId, Fields: fields }, { retries: 1, timeoutMs: 20_000 });

    // проверяем, что HolliHop сохранил значение
    let note = null;
    try {
      const check = await fetchStudent(clientId);
      const saved = check ? coinsOf(check) : null;
      if (saved !== after) {
        note = `после записи в HolliHop значение ${saved ?? 'пусто'}, ожидалось ${coinsText(after)}`;
        logger.warn({ clientId, before, after, saved }, 'Коины: HolliHop вернул другое значение после списания');
      }
    } catch (err) {
      logger.warn({ clientId, err: err.message }, 'Коины: не удалось перепроверить значение после списания');
    }

    await query('UPDATE students SET coins = ? WHERE client_id = ?', [after, clientId]);
    const id = await log(user, {
      action: 'spend', student_client_id: clientId, student_hh_id: s.Id, student_name: studentName(s),
      product_id: product.id, product_name: product.name, price, coins_before: before, coins_after: after, note,
    });
    logger.info({ employee: user.id, clientId, product: product.id, before, after }, 'Коины списаны');
    return id;
  });
}
