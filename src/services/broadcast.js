import { query } from '../db.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { sleep } from '../utils/sleep.js';
import { greeting } from '../i18n.js';
import { listRecipientRows, toRecipients } from './recipients.js';

/**
 * Создаёт рассылку и фиксирует список сообщений на момент запуска.
 * Из бота: srcChatId/srcMessageId (copyMessage). Из веб-админки: text (+parseMode).
 * recipients — готовый список из toRecipients(); если не передан, считается по audience/branchIds.
 */
export async function createBroadcast({
  adminChatId = 0, srcChatId = 0, srcMessageId = 0, audience = 'all', branchIds = [], allBranches = true,
  recipients: preset = null, personalize = true, text = null, parseMode = null, title = null,
}) {
  const recipients = preset ?? toRecipients(await listRecipientRows({ audience, branchIds, allBranches }), personalize);
  const res = await query(
    `INSERT INTO broadcasts (admin_chat_id, src_chat_id, src_message_id, audience, all_branches, status, total, started_at, text, parse_mode, title)
     VALUES (?, ?, ?, ?, ?, 'running', ?, NOW(), ?, ?, ?)`,
    [adminChatId, srcChatId, srcMessageId, audience, allBranches ? 1 : 0, recipients.length, text, parseMode, title ? title.slice(0, 250) : null],
  );
  const id = res.insertId;
  if (!allBranches && branchIds.length) {
    await query('INSERT INTO broadcast_branches (broadcast_id, branch_id) VALUES ?', [branchIds.map((b) => [id, b])]);
  }
  for (let i = 0; i < recipients.length; i += 1000) {
    await query('INSERT IGNORE INTO broadcast_recipients (broadcast_id, chat_id, student_client_id, student_name) VALUES ?', [
      recipients.slice(i, i + 1000).map((r) => [id, r.chat_id, r.student_client_id, r.student_name]),
    ]);
  }
  return { id, total: recipients.length };
}

export async function cancelBroadcast(id) {
  const res = await query("UPDATE broadcasts SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'running'", [id]);
  return res.affectedRows > 0;
}

async function recount(id) {
  await query(
    `UPDATE broadcasts b SET
       sent    = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'sent'),
       failed  = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'failed'),
       blocked = (SELECT COUNT(*) FROM broadcast_recipients WHERE broadcast_id = b.id AND status = 'blocked')
     WHERE b.id = ?`,
    [id],
  );
}

const escHtml = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Обращение к родителю на языке получателя (по умолчанию казахский): null — без обращения. */
function headerFor(b, r) {
  if (r.student_name === null || r.student_name === undefined) return null;
  const name = b.parse_mode === 'HTML' ? escHtml(r.student_name) : r.student_name;
  return greeting(r.lang, name); // пустое имя -> «Құрметті ата-ана!» / «Уважаемый родитель!»
}

async function sendOne(bot, b, r) {
  const chatId = r.chat_id;
  const header = headerFor(b, r);
  let headerSent = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      if (b.text) {
        // рассылка из веб-админки: обращение и текст одним сообщением
        const text = header ? `${header}\n\n${b.text}` : b.text;
        await bot.telegram.sendMessage(chatId, text, b.parse_mode ? { parse_mode: b.parse_mode } : {});
      } else {
        // из бота: copyMessage сохраняет форматирование, фото/видео/документы и подписи; обращение — отдельным сообщением перед ним
        if (header && !headerSent) {
          await bot.telegram.sendMessage(chatId, header);
          headerSent = true;
        }
        await bot.telegram.copyMessage(chatId, b.src_chat_id, b.src_message_id);
      }
      return { status: 'sent' };
    } catch (err) {
      const code = err?.response?.error_code;
      const desc = err?.response?.description || err.message || 'unknown';
      if (code === 429) {
        const wait = (err.response.parameters?.retry_after ?? 5) + 1;
        logger.warn({ wait }, 'Telegram 429, пауза');
        await sleep(wait * 1000);
        continue;
      }
      if (code === 400 && /can't parse entities|can't find end/i.test(desc)) {
        return { status: 'failed', error: desc, fatal: true }; // битая HTML-разметка — нет смысла продолжать
      }
      if (code === 403) return { status: 'blocked', error: desc };
      if (code === 400 && /chat not found|user is deactivated|PEER_ID_INVALID/i.test(desc)) {
        return { status: 'blocked', error: desc };
      }
      if (!code || code >= 500) { // сеть / сбой Telegram
        await sleep(1000 * (attempt + 1));
        continue;
      }
      return { status: 'failed', error: desc };
    }
  }
  return { status: 'failed', error: 'превышено число попыток' };
}

async function processBroadcast(bot, b) {
  const delay = Math.ceil(1000 / config.broadcast.ratePerSec);
  const blockedChats = new Set();
  for (;;) {
    const [cur] = await query('SELECT status FROM broadcasts WHERE id = ?', [b.id]);
    if (!cur || cur.status !== 'running') return; // отменена

    const batch = await query(
      "SELECT r.id, r.chat_id, r.student_client_id, r.student_name, COALESCE(u.lang, 'kk') AS lang FROM broadcast_recipients r LEFT JOIN tg_users u ON u.chat_id = r.chat_id WHERE r.broadcast_id = ? AND r.status = 'pending' ORDER BY r.id LIMIT 50",
      [b.id],
    );
    if (!batch.length) break;

    for (const r of batch) {
      // если этот чат уже оказался заблокированным, не дёргаем Telegram ради его остальных сообщений
      const result = blockedChats.has(r.chat_id) ? { status: 'blocked', error: 'бот заблокирован' } : await sendOne(bot, b, r);
      await query('UPDATE broadcast_recipients SET status = ?, error = ?, sent_at = NOW() WHERE id = ?', [
        result.status, result.error ? result.error.slice(0, 250) : null, r.id,
      ]);
      if (result.status === 'blocked') {
        blockedChats.add(r.chat_id);
        await query('UPDATE tg_users SET is_blocked = 1 WHERE chat_id = ?', [r.chat_id]);
      }
      if (result.fatal) {
        await recount(b.id);
        await query("UPDATE broadcasts SET status = 'failed', finished_at = NOW() WHERE id = ? AND status = 'running'", [b.id]);
        if (b.admin_chat_id) {
          bot.telegram
            .sendMessage(b.admin_chat_id, `❌ Рассылка #${b.id} остановлена: Telegram не принял разметку (${result.error}). Проверьте HTML-теги.`)
            .catch(() => {});
        }
        return;
      }
      await sleep(delay);
      if (!b.text && r.student_name !== null) await sleep(delay); // обращение + copyMessage = два запроса к Telegram
    }
    await recount(b.id);
  }

  await recount(b.id);
  await query("UPDATE broadcasts SET status = 'done', finished_at = NOW() WHERE id = ? AND status = 'running'", [b.id]);
  const [fin] = await query('SELECT * FROM broadcasts WHERE id = ?', [b.id]);
  if (fin?.status === 'done' && fin.admin_chat_id) {
    bot.telegram
      .sendMessage(
        fin.admin_chat_id,
        `✅ Рассылка #${fin.id} завершена\nВсего: ${fin.total}\nДоставлено: ${fin.sent}\nЗаблокировали бота: ${fin.blocked}\nОшибки: ${fin.failed}`,
      )
      .catch(() => {});
  }
}

let active = false;

/** Запускает (или продолжает после рестарта) обработку всех рассылок со статусом running. */
export function startWorker(bot) {
  if (active) return;
  active = true;
  (async () => {
    for (;;) {
      const [b] = await query("SELECT * FROM broadcasts WHERE status = 'running' ORDER BY id LIMIT 1");
      if (!b) return;
      try {
        await processBroadcast(bot, b);
      } catch (err) {
        logger.error({ err, id: b.id }, 'Ошибка обработки рассылки');
        await query("UPDATE broadcasts SET status = 'failed', finished_at = NOW() WHERE id = ?", [b.id]);
      }
    }
  })()
    .catch((err) => logger.error({ err }, 'Воркер рассылок упал'))
    .finally(async () => {
      active = false;
      const [{ n }] = await query("SELECT COUNT(*) AS n FROM broadcasts WHERE status = 'running'");
      if (n > 0) startWorker(bot); // создали рассылку, пока воркер завершался
    });
}
