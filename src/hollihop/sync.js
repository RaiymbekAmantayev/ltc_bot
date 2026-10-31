import { hh } from './client.js';
import { query, withTx } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { phoneKeys } from '../utils/phone.js';
import { coinsOf } from '../services/coins.js';

const toDt = (s) => (s ? String(s).replace('T', ' ').slice(0, 19) : null);
const toDate = (s) => (s ? String(s).slice(0, 10) : null);
const nz = (v) => (v === undefined || v === null || v === '' ? null : v);

// --- фильтр по статусам (RECIPIENT_STATUSES): в БД храним только учеников с этими статусами ---
const normStatus = (v) => String(v ?? '').trim().toLowerCase();
const allowedSet = new Set(config.allowedStatuses.map(normStatus));
/** true, если фильтр не задан или статус входит в RECIPIENT_STATUSES (без учёта регистра). */
export const isStatusAllowed = (status) => allowedSet.size === 0 || allowedSet.has(normStatus(status));

async function warnUnknownStatuses() {
  try {
    const { Statuses = [] } = await hh('GetClientStatuses');
    const known = new Set(Statuses.map((x) => normStatus(x.Name)));
    const unknown = config.allowedStatuses.filter((x) => !known.has(normStatus(x)));
    if (unknown.length) {
      logger.warn({ unknown, existing: Statuses.map((x) => x.Name) }, 'RECIPIENT_STATUSES: таких статусов нет в HolliHop — проверьте написание');
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'Не удалось проверить список статусов в HolliHop');
  }
}

let busy = false;
export const isSyncing = () => busy;

async function getState(k) {
  const r = await query('SELECT v FROM sync_state WHERE k = ?', [k]);
  return r[0]?.v ?? null;
}
async function setState(k, v) {
  await query('INSERT INTO sync_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]);
}

/** GetOffices -> branches */
export async function syncOffices() {
  const { Offices = [] } = await hh('GetOffices');
  if (!Offices.length) return 0;
  const now = new Date();
  const rows = Offices.map((o) => [o.Id, o.Name, nz(o.Location), nz(o.Address), nz(o.EMail), nz(o.Phone), 1, now]);
  await query(
    `INSERT INTO branches (id, name, location, address, email, phone, is_active, synced_at) VALUES ?
     ON DUPLICATE KEY UPDATE name = VALUES(name), location = VALUES(location), address = VALUES(address),
       email = VALUES(email), phone = VALUES(phone), is_active = 1, synced_at = VALUES(synced_at)`,
    [rows],
  );
  await query('UPDATE branches SET is_active = 0 WHERE id NOT IN (?)', [Offices.map((o) => o.Id)]);
  return Offices.length;
}

async function upsertStudents(list, runId) {
  const now = new Date();
  const ids = list.map((s) => s.ClientId);

  const studentRows = list.map((s) => [
    s.ClientId, s.Id, nz(s.FirstName), nz(s.LastName), nz(s.MiddleName), toDate(s.Birthday), nz(s.Status),
    nz(s.Mobile), nz(s.Phone), nz(s.EMail), coinsOf(s), toDt(s.Created), toDt(s.Updated), runId, now,
  ]);

  const branchRows = [];
  const agentRows = [];
  const assigneeRows = [];
  const contactSet = new Map();
  const addContacts = (clientId, owner, ...raws) => {
    for (const raw of raws) {
      for (const key of phoneKeys(raw)) contactSet.set(`${clientId}|${owner}|${key}`, [clientId, owner, key]);
    }
  };

  for (const s of list) {
    for (const b of s.OfficesAndCompanies || []) branchRows.push([s.ClientId, b.Id]);
    for (const a of s.Assignees || []) if (a.Id) assigneeRows.push([s.ClientId, a.Id, nz(a.FullName)]);
    addContacts(s.ClientId, 'student', s.Mobile, s.Phone);
    for (const a of s.Agents || []) {
      agentRows.push([
        s.ClientId, nz(a.FirstName), nz(a.LastName), nz(a.MiddleName), nz(a.WhoIs),
        nz(a.Mobile), nz(a.Phone), nz(a.EMail), a.IsCustomer ? 1 : 0,
      ]);
      addContacts(s.ClientId, 'agent', a.Mobile, a.Phone);
    }
  }

  await withTx(async (c) => {
    await c.query(
      `INSERT INTO students (client_id, hh_id, first_name, last_name, middle_name, birthday, status,
         mobile, phone, email, coins, hh_created, hh_updated, sync_run, synced_at) VALUES ?
       ON DUPLICATE KEY UPDATE hh_id = VALUES(hh_id), first_name = VALUES(first_name), last_name = VALUES(last_name),
         middle_name = VALUES(middle_name), birthday = VALUES(birthday), status = VALUES(status),
         mobile = VALUES(mobile), phone = VALUES(phone), email = VALUES(email), coins = VALUES(coins),
         hh_created = VALUES(hh_created), hh_updated = VALUES(hh_updated),
         sync_run = VALUES(sync_run), synced_at = VALUES(synced_at)`,
      [studentRows],
    );
    await c.query('DELETE FROM student_branches WHERE student_client_id IN (?)', [ids]);
    await c.query('DELETE FROM agents WHERE student_client_id IN (?)', [ids]);
    await c.query('DELETE FROM contacts WHERE student_client_id IN (?)', [ids]);
    await c.query('DELETE FROM student_assignees WHERE student_client_id IN (?)', [ids]);
    if (branchRows.length) {
      await c.query('INSERT IGNORE INTO student_branches (student_client_id, branch_id) VALUES ?', [branchRows]);
    }
    if (assigneeRows.length) {
      await c.query('INSERT IGNORE INTO student_assignees (student_client_id, employee_id, full_name) VALUES ?', [assigneeRows]);
    }
    if (agentRows.length) {
      await c.query(
        `INSERT INTO agents (student_client_id, first_name, last_name, middle_name, who_is, mobile, phone, email, is_customer)
         VALUES ?`,
        [agentRows],
      );
    }
    if (contactSet.size) {
      await c.query('INSERT IGNORE INTO contacts (student_client_id, owner, phone_key) VALUES ?', [[...contactSet.values()]]);
    }
  });
}

/**
 * Точечная загрузка одного ученика из HolliHop по ID (для регистрации в боте:
 * ученик мог появиться в CRM после последней синхронизации).
 * Возвращает { client_id, first_name, last_name } или null, если в HolliHop такого ученика нет.
 */
export async function importStudentById(id, field = config.regIdField) {
  const param = field === 'client_id' ? 'clientId' : 'id';
  const data = await hh('GetStudents', { [param]: id, take: 5 }, { retries: 1, timeoutMs: 15_000 });
  const s = (data.Students || []).find((x) => (field === 'client_id' ? x.ClientId : x.Id) === id);
  if (!s || !isStatusAllowed(s.Status)) return null; // нет такого или статус не входит в RECIPIENT_STATUSES
  await upsertStudents([s], Math.floor(Date.now() / 1000));
  logger.info({ id, clientId: s.ClientId }, 'Ученик загружен из HolliHop при регистрации');
  return { client_id: s.ClientId, first_name: s.FirstName ?? null, last_name: s.LastName ?? null };
}

/**
 * GetStudents -> students/agents/contacts.
 * full=true: полная выгрузка + удаление исчезнувших из HolliHop.
 * Если задан RECIPIENT_STATUSES, в БД попадают только ученики с этими статусами:
 *  - полная выгрузка просит у HolliHop только такие статусы (параметр statuses);
 *  - инкрементальная получает всех изменившихся, ненужных (например, перешёл в «Закончил») удаляет из БД.
 */
export async function syncStudents({ full = false } = {}) {
  const runId = Math.floor(Date.now() / 1000);
  const since = full ? null : await getState('students_last_now');
  const isFull = full || !since;
  const take = config.hh.pageSize;
  const filterOn = config.allowedStatuses.length > 0;

  if (isFull && filterOn) await warnUnknownStatuses();

  let skip = 0;
  let total = 0;
  let removedByStatus = 0;
  let serverNow = null;

  for (;;) {
    const data = await hh('GetStudents', {
      skip,
      take,
      lastUpdatedFrom: isFull ? undefined : since,
      statuses: isFull && filterOn ? config.allowedStatuses.join(',') : undefined,
    });
    serverNow = serverNow || data.Now;
    const list = data.Students || [];

    const keep = list.filter((x) => isStatusAllowed(x.Status));
    const drop = list.filter((x) => !isStatusAllowed(x.Status));
    if (keep.length) {
      await upsertStudents(keep, runId);
      total += keep.length;
    }
    if (drop.length) {
      const res = await query('DELETE FROM students WHERE client_id IN (?)', [drop.map((x) => x.ClientId)]);
      removedByStatus += res.affectedRows;
    }

    if (list.length < take) break; // длину страницы считаем до фильтрации
    skip += take;
  }

  if (isFull) {
    if (total === 0 && filterOn) {
      logger.warn('Полная синхронизация: не найдено ни одного ученика с нужными статусами — БД не очищаю, проверьте RECIPIENT_STATUSES');
    } else if (total > 0) {
      const res = await query('DELETE FROM students WHERE sync_run < ?', [runId]);
      if (res.affectedRows) logger.info({ removed: res.affectedRows }, 'Удалены ученики, которых больше нет в HolliHop или статус которых не подходит');
    }
  }
  if (removedByStatus) logger.info({ removed: removedByStatus }, 'Удалены ученики, перешедшие в неподходящий статус');

  if (serverNow) await setState('students_last_now', serverNow);
  return total;
}

export async function runSync({ full = false } = {}) {
  if (busy) return { skipped: true };
  busy = true;
  const t0 = Date.now();
  try {
    const offices = await syncOffices();
    const students = await syncStudents({ full });
    const result = { offices, students, ms: Date.now() - t0 };
    logger.info({ ...result, full }, 'Синхронизация с HolliHop завершена');
    return result;
  } finally {
    busy = false;
  }
}
