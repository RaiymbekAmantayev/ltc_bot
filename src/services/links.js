import { query } from '../db.js';

/** Ученики, к которым привязан пользователь Telegram. */
export function getUserLinks(tgUserId) {
  return query(
    `SELECT l.relation, s.client_id, s.first_name, s.last_name, s.status
     FROM tg_links l JOIN students s ON s.client_id = l.student_client_id
     WHERE l.tg_user_id = ? ORDER BY s.last_name, s.first_name`,
    [tgUserId],
  );
}
