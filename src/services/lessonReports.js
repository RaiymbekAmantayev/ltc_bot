import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../utils/sleep.js';
import { fetchLessons } from '../ltc/attendance.js';

/**
 * Мини-отчёты родителям после урока.
 * Раз в LESSON_REPORTS_CRON бот забирает из кабинета записи журнала, созданные/исправленные с прошлого опроса
 * (с перекрытием), и каждому подключённому родителю ученика шлёт короткое сообщение.
 * Повторов нет: строка lesson_reports (record_id, chat_id) занимается до отправки; правка отметки в кабинете
 * сохраняет record_id, поэтому исправленная запись повторно не уходит.
 */

const STATE_KEY = 'lesson_reports_since';

/* ---------------- Текст ---------------- */

const TEXT = {
  ru: {
    hello: 'Добрый день!',
    topic: 'Тема урока',
    activity: 'Активность',
    behaviour: 'Поведение',
    homework: 'ДЗ за прошлый урок',
    assignment: 'Домашнее задание',
    absent: 'Ваш ребенок отсутствовал на уроке',
  },
  kk: {
    hello: 'Қайырлы күн!',
    topic: 'Сабақ тақырыбы',
    activity: 'Белсенділік',
    behaviour: 'Тәртіп',
    homework: 'Өткен сабақтың үй тапсырмасы',
    assignment: 'Үй тапсырмасы',
    absent: 'Балаңыздың сабаққа келмегенін хабарлаймыз.',
  },
};

const fmtDate = (iso) => (/^\d{4}-\d\d-\d\d$/.test(iso || '') ? iso.split('-').reverse().join('.') : iso || '');
const clean = (v) => (v == null ? '' : String(v).trim());

/** Дата «сейчас» в часовом поясе школы, YYYY-MM-DD. */
export const localDate = (d = new Date(), timeZone = config.sync.timezone) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

/**
 * Текст отчёта по записи журнала. Пустые поля (null) не выводятся; оценка 0 — реальная оценка, выводится.
 * lang — 'ru' | 'kk' (по умолчанию казахский, как во всём боте).
 */
export function buildReport(rec, { lang } = {}) {
  const kk = lang !== 'ru';
  const t = TEXT[kk ? 'kk' : 'ru'];
  const head = `📘 ${[clean(rec.group_name), fmtDate(rec.date)].filter(Boolean).join(', ')}`;
  const topic = clean(rec.topic) && `${t.topic}: ${clean(rec.topic)}`;
  const score = (label, v) => (v == null || v === '' || Number.isNaN(Number(v)) ? '' : `${label}: ${Number(v)}/5`);
  const assignment = clean(rec.homework_assignment) && `${t.assignment}: ${clean(rec.homework_assignment)}`;

  let blocks;
  if (rec.attendance === 'absent') {
    // ru: тема, затем строка об отсутствии, ДЗ отдельным блоком; kk: сначала сообщение об отсутствии, затем урок одним блоком
    blocks = kk ? [[t.hello], [t.absent], [head, topic, assignment]] : [[t.hello, head, topic, t.absent], [assignment]];
  } else {
    blocks = [[t.hello, head, topic], [score(t.activity, rec.activity), score(t.behaviour, rec.behaviour), score(t.homework, rec.homework)], [assignment]];
  }
  return blocks.map((b) => b.filter(Boolean).join('\n')).filter(Boolean).join('\n\n');
}

/* ---------------- Получатели ---------------- */

/** Подключённые родители по ученикам: Map<ClientId, [{ chat_id, lang }]>. */
async function parentsOf(clientIds) {
  const map = new Map();
  for (let i = 0; i < clientIds.length; i += 1000) {
    const rows = await query(
      `SELECT DISTINCT l.student_client_id AS client_id, u.chat_id, COALESCE(u.lang, 'kk') AS lang
       FROM tg_links l
       JOIN tg_users u ON u.id = l.tg_user_id
       WHERE l.relation = 'parent' AND u.is_subscribed = 1 AND u.is_blocked = 0 AND l.student_client_id IN (?)`,
      [clientIds.slice(i, i + 1000)],
    );
    for (const r of rows) {
      const k = String(r.client_id);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
  }
  return map;
}

/* ---------------- Отправка ---------------- */

/** Занять пару (запись, чат) до отправки. false — уже отправлено/отправляется. Неудачную попытку можно повторить. */
async function claim(rec, p, text) {
  const ins = await query(
    `INSERT IGNORE INTO lesson_reports (record_id, chat_id, student_client_id, lesson_date, group_name, attendance, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [rec.record_id, p.chat_id, Number(rec.hollyhop_client_id), rec.date, rec.group_name?.slice(0, 255) ?? null,
      rec.attendance === 'absent' ? 'absent' : 'present', text],
  );
  if (ins.affectedRows === 1) return true;
  const upd = await query(
    "UPDATE lesson_reports SET status = 'sending', error = NULL, text = ? WHERE record_id = ? AND chat_id = ? AND status = 'failed'",
    [text, rec.record_id, p.chat_id],
  );
  return upd.affectedRows === 1;
}

async function sendText(bot, chatId, text) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await bot.telegram.sendMessage(chatId, text);
      return { status: 'sent' };
    } catch (err) {
      const code = err?.response?.error_code;
      const desc = err?.response?.description || err.message || 'unknown';
      if (code === 429) {
        await sleep(((err.response.parameters?.retry_after ?? 5) + 1) * 1000);
        continue;
      }
      if (code === 403 || (code === 400 && /chat not found|user is deactivated|PEER_ID_INVALID/i.test(desc))) {
        return { status: 'blocked', error: desc };
      }
      if (!code || code >= 500) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { status: 'failed', error: desc };
    }
  }
  return { status: 'failed', error: 'превышено число попыток' };
}

/* ---------------- Опрос ---------------- */

async function readSince(now) {
  const [row] = await query('SELECT v FROM sync_state WHERE k = ?', [STATE_KEY]);
  const last = row ? new Date(row.v) : null;
  // первый запуск — без истории: только последние overlapMin минут
  const base = last && !Number.isNaN(last.getTime()) ? last : now;
  return new Date(base.getTime() - config.lessonReports.overlapMin * 60_000);
}

const writeSince = (d) => query(
  'INSERT INTO sync_state (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [STATE_KEY, d.toISOString()]);

let running = false;

/** Один опрос кабинета и рассылка новых отчётов. Возвращает счётчики (для логов и тестов). */
export async function pollLessonReports(bot) {
  if (running) return { skipped: 'running' };
  running = true;
  const cfg = config.lessonReports;
  const stats = { records: 0, excludedBranch: 0, invalid: 0, noParents: 0, sent: 0, failed: 0, blocked: 0, duplicate: 0 };
  try {
    const startedAt = new Date();
    const today = localDate(startedAt);
    const since = await readSince(startedAt);
    const records = await fetchLessons({ updatedSince: since, dateFrom: addDays(today, -cfg.maxAgeDays) });
    stats.records = records.length;

    const excluded = new Set(cfg.excludeBranches.map((b) => b.toLowerCase()));
    const todo = records.filter((r) => {
      if (excluded.has(clean(r.branch).toLowerCase())) { stats.excludedBranch++; return false; }
      if (!/^\d+$/.test(String(r.hollyhop_client_id || '')) || !r.record_id) { stats.invalid++; return false; }
      return true;
    });
    if (stats.excludedBranch) logger.info({ branches: cfg.excludeBranches, count: stats.excludedBranch }, 'Мини-отчёты: пропущены исключённые филиалы');
    const parents = await parentsOf([...new Set(todo.map((r) => Number(r.hollyhop_client_id)))]);
    const delay = Math.ceil(1000 / cfg.ratePerSec);

    for (const rec of todo) {
      const list = parents.get(String(rec.hollyhop_client_id)) || [];
      if (!list.length) { stats.noParents++; continue; }   // нет подключённых родителей — это не ошибка
      for (const p of list) {
        const text = buildReport(rec, { lang: p.lang });
        if (cfg.dryRun) {
          logger.info({ record: rec.record_id, chat: p.chat_id, text }, 'Мини-отчёт (dry run)');
          continue;
        }
        if (!(await claim(rec, p, text))) { stats.duplicate++; continue; }
        const res = await sendText(bot, p.chat_id, text);
        await query(
          'UPDATE lesson_reports SET status = ?, error = ?, sent_at = IF(? = \'sent\', NOW(), sent_at) WHERE record_id = ? AND chat_id = ?',
          [res.status, res.error ? res.error.slice(0, 250) : null, res.status, rec.record_id, p.chat_id],
        );
        if (res.status === 'blocked') await query('UPDATE tg_users SET is_blocked = 1 WHERE chat_id = ?', [p.chat_id]);
        stats[res.status]++;
        await sleep(delay);
      }
    }

    // окно сдвигаем только после успешного прохода; следующий опрос возьмёт его с перекрытием overlapMin
    if (!cfg.dryRun) await writeSince(startedAt);
    if (stats.records) logger.info(stats, 'Мини-отчёты: опрос');
    return stats;
  } finally {
    running = false;
  }
}
