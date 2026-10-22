import { query } from '../db.js';
import { config } from '../config.js';

/**
 * filter = { audience: 'all'|'parents'|'students', branchIds: number[], allBranches: boolean }
 * Возвращает строки «Telegram-аккаунт ↔ ученик» (у родителя с тремя детьми их три).
 */
function build({ audience, branchIds, allBranches }, select) {
  const params = [];
  let sql = `FROM tg_users u
    JOIN tg_links l ON l.tg_user_id = u.id
    JOIN students s ON s.client_id = l.student_client_id`;
  if (!allBranches) {
    sql += ' JOIN student_branches sb ON sb.student_client_id = s.client_id AND sb.branch_id IN (?)';
    params.push(branchIds);
  }
  sql += ' WHERE u.is_subscribed = 1 AND u.is_blocked = 0';
  if (audience === 'parents') sql += " AND l.relation = 'parent'";
  if (audience === 'students') sql += " AND l.relation = 'student'";
  if (config.allowedStatuses.length) {
    sql += ' AND s.status IN (?)';
    params.push(config.allowedStatuses);
  }
  return { sql: `SELECT ${select} ${sql}`, params };
}

export const ROW_COLUMNS =
  'u.chat_id AS chat_id, s.client_id AS student_client_id, l.relation AS relation, s.first_name AS first_name, s.last_name AS last_name';

export function listRecipientRows(filter) {
  const q = build(filter, `DISTINCT ${ROW_COLUMNS}`);
  return query(q.sql, q.params);
}

/**
 * Превращает строки «аккаунт ↔ ученик» в список сообщений рассылки.
 * personalize = true: отдельное сообщение на каждого ученика; родителю добавляется обращение
 *                     («Уважаемый родитель ученика …»), ученику — нет.
 * personalize = false: по одному сообщению на человека, без обращения.
 * student_name: null — без обращения; '' — «Уважаемый родитель!»; иначе — с именем ученика.
 */
export function toRecipients(rows, personalize = true) {
  const map = new Map();
  for (const r of rows) {
    if (!personalize) {
      if (!map.has(r.chat_id)) map.set(r.chat_id, { chat_id: r.chat_id, student_client_id: 0, student_name: null });
      continue;
    }
    const key = `${r.chat_id}|${r.student_client_id}`;
    const name = r.relation === 'parent' ? [r.last_name, r.first_name].filter(Boolean).join(' ') : null;
    const cur = map.get(key);
    if (!cur) map.set(key, { chat_id: r.chat_id, student_client_id: r.student_client_id, student_name: name });
    else if (cur.student_name === null && name !== null) cur.student_name = name; // родительская роль важнее
  }
  return [...map.values()];
}

/** Для подтверждения рассылки: сколько людей и сколько сообщений уйдёт. */
export async function countRecipients(filter) {
  const rows = await listRecipientRows(filter);
  return { people: new Set(rows.map((r) => r.chat_id)).size, messages: toRecipients(rows, true).length };
}
