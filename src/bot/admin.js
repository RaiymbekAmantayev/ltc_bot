import { Markup } from 'telegraf';
import { config } from '../config.js';
import { query } from '../db.js';
import { runSync, isSyncing } from '../hollihop/sync.js';
import { countRecipients } from '../services/recipients.js';
import { createBroadcast, startWorker, cancelBroadcast } from '../services/broadcast.js';

// состояние мастера рассылки: adminId -> { step, branches, branchIds:Set, all, audience, src }
const sessions = new Map();

const AUD = { all: 'родители и ученики', parents: 'только родители', students: 'только ученики' };
const STATUS = { running: '⏳ идёт', done: '✅ завершена', cancelled: '⛔ отменена', failed: '❌ ошибка' };

const isAdmin = (ctx) => ctx.chat?.type === 'private' && config.adminIds.includes(ctx.from?.id);

const adminOnly = async (ctx, next) => {
  if (isAdmin(ctx)) return next();
  if (ctx.callbackQuery) return ctx.answerCbQuery('Нет доступа', { show_alert: true });
  return ctx.reply('Команда доступна только администраторам.');
};

const fmt = (d) => (d ? new Date(d).toLocaleString('ru-RU', { timeZone: config.sync.timezone }) : '—');

async function safeEdit(ctx, text, kb) {
  try {
    await ctx.editMessageText(text, kb);
  } catch (e) {
    if (!/not modified/i.test(e.message)) throw e;
  }
}

function branchKeyboard(st) {
  const rows = st.branches.map((b) => [
    Markup.button.callback(`${st.branchIds.has(b.id) ? '✅' : '⬜'} ${b.name}`.slice(0, 60), `bc:b:${b.id}`),
  ]);
  rows.unshift([Markup.button.callback(`${st.all ? '✅' : '⬜'} Все филиалы`, 'bc:all')]);
  rows.push([Markup.button.callback('Далее ▶️', 'bc:next'), Markup.button.callback('✖ Отмена', 'bc:cancel')]);
  return Markup.inlineKeyboard(rows);
}

export function registerAdmin(bot) {
  const filterOf = (st) => ({ audience: st.audience, branchIds: [...st.branchIds], allBranches: st.all });

  // ---------- мастер рассылки ----------
  const startWizard = async (ctx) => {
    const branches = await query('SELECT id, name FROM branches WHERE is_active = 1 ORDER BY name');
    if (!branches.length) return ctx.reply('Филиалы ещё не загружены. Выполните /sync');
    const st = { step: 'branches', branches, branchIds: new Set(), all: false, audience: 'all', src: null };
    sessions.set(ctx.from.id, st);
    return ctx.reply('Шаг 1/3. Выберите филиалы:', branchKeyboard(st));
  };
  bot.command('broadcast', adminOnly, startWizard);

  bot.command('cancel', adminOnly, (ctx) => {
    sessions.delete(ctx.from.id);
    return ctx.reply('Создание рассылки отменено.');
  });

  bot.action(/^bc:b:(\d+)$/, adminOnly, async (ctx) => {
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'branches') return ctx.answerCbQuery('Сессия устарела, начните /broadcast');
    const id = Number(ctx.match[1]);
    st.all = false;
    if (st.branchIds.has(id)) st.branchIds.delete(id);
    else st.branchIds.add(id);
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(branchKeyboard(st).reply_markup); } catch { /* not modified */ }
  });

  bot.action('bc:all', adminOnly, async (ctx) => {
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'branches') return ctx.answerCbQuery('Сессия устарела, начните /broadcast');
    st.all = !st.all;
    if (st.all) st.branchIds.clear();
    await ctx.answerCbQuery();
    try { await ctx.editMessageReplyMarkup(branchKeyboard(st).reply_markup); } catch { /* not modified */ }
  });

  bot.action('bc:next', adminOnly, async (ctx) => {
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'branches') return ctx.answerCbQuery('Сессия устарела, начните /broadcast');
    if (!st.all && st.branchIds.size === 0) return ctx.answerCbQuery('Выберите хотя бы один филиал', { show_alert: true });
    st.step = 'audience';
    await ctx.answerCbQuery();
    await safeEdit(
      ctx,
      'Шаг 2/3. Кому отправить?',
      Markup.inlineKeyboard([
        [Markup.button.callback('👨‍👩‍👧 Родители и ученики', 'bc:a:all')],
        [Markup.button.callback('👨‍👩‍👧 Только родители', 'bc:a:parents')],
        [Markup.button.callback('🎓 Только ученики', 'bc:a:students')],
        [Markup.button.callback('✖ Отмена', 'bc:cancel')],
      ]),
    );
  });

  bot.action(/^bc:a:(all|parents|students)$/, adminOnly, async (ctx) => {
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'audience') return ctx.answerCbQuery('Сессия устарела, начните /broadcast');
    st.audience = ctx.match[1];
    st.step = 'message';
    await ctx.answerCbQuery();
    await safeEdit(
      ctx,
      'Шаг 3/3. Отправьте сообщение для рассылки — текст, фото, видео или документ (с подписью и форматированием). ' +
        'Оно будет разослано в точности как вы его пришлёте.\n\nОтмена: /cancel',
    );
  });

  bot.action('bc:cancel', adminOnly, async (ctx) => {
    sessions.delete(ctx.from.id);
    await ctx.answerCbQuery();
    await safeEdit(ctx, 'Создание рассылки отменено.');
  });

  // сообщение админа с контентом рассылки (регистрируется до пользовательских обработчиков)
  bot.on('message', async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'message') return next();
    if (ctx.message.text?.startsWith('/')) return next();

    const cnt = await countRecipients(filterOf(st));
    if (cnt.people === 0) {
      sessions.delete(ctx.from.id);
      return ctx.reply('По выбранным условиям нет ни одного получателя (никто не зарегистрировался в боте). Рассылка не создана.');
    }
    st.src = { chatId: ctx.chat.id, messageId: ctx.message.message_id };
    st.step = 'confirm';
    const branchNames = st.all ? 'все филиалы' : st.branches.filter((b) => st.branchIds.has(b.id)).map((b) => b.name).join(', ');
    return ctx.reply(
      `Проверьте рассылку:\n• Филиалы: ${branchNames}\n• Аудитория: ${AUD[st.audience]}\n• Получателей: ${cnt.people}, сообщений: ${cnt.messages}\n(родитель с несколькими детьми получит отдельное сообщение с обращением «Уважаемый родитель ученика …» на каждого ученика)\n\nСообщение — то, что вы только что прислали.`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`🚀 Отправить (${cnt.messages})`, 'bc:go')],
        [Markup.button.callback('✖ Отмена', 'bc:cancel')],
      ]),
      { reply_parameters: { message_id: ctx.message.message_id } },
    );
  });

  bot.action('bc:go', adminOnly, async (ctx) => {
    const st = sessions.get(ctx.from.id);
    if (!st || st.step !== 'confirm') return ctx.answerCbQuery('Сессия устарела, начните /broadcast');
    sessions.delete(ctx.from.id); // защита от двойного нажатия
    await ctx.answerCbQuery('Запускаю…');
    const { id, total } = await createBroadcast({
      adminChatId: ctx.chat.id,
      srcChatId: st.src.chatId,
      srcMessageId: st.src.messageId,
      ...filterOf(st),
    });
    await safeEdit(ctx, `🚀 Рассылка #${id} запущена. Получателей: ${total}.\nПрогресс: /broadcasts\nОстановить: /stopbroadcast ${id}`);
    startWorker(bot);
  });

  // ---------- управление ----------
  bot.command('broadcasts', adminOnly, async (ctx) => {
    const rows = await query('SELECT * FROM broadcasts ORDER BY id DESC LIMIT 10');
    if (!rows.length) return ctx.reply('Рассылок ещё не было.');
    return ctx.reply(
      rows
        .map((b) => `#${b.id} ${STATUS[b.status] || b.status} — ${b.sent}/${b.total} (блок: ${b.blocked}, ошибки: ${b.failed}) — ${fmt(b.created_at)}`)
        .join('\n'),
    );
  });

  bot.command('stopbroadcast', adminOnly, async (ctx) => {
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!id) return ctx.reply('Использование: /stopbroadcast <номер>');
    return ctx.reply((await cancelBroadcast(id)) ? `Рассылка #${id} остановлена.` : 'Нет активной рассылки с таким номером.');
  });

  bot.command('stats', adminOnly, async (ctx) => {
    const [t] = await query(
      `SELECT (SELECT COUNT(*) FROM students) AS students,
              (SELECT COUNT(*) FROM tg_users) AS tg_users,
              (SELECT COUNT(DISTINCT tg_user_id) FROM tg_links) AS linked,
              (SELECT COUNT(*) FROM tg_users WHERE is_blocked = 1) AS blocked`,
    );
    const rows = await query(
      `SELECT b.name,
              COUNT(DISTINCT s.client_id) AS students,
              COUNT(DISTINCT u.chat_id) AS reachable
       FROM branches b
       LEFT JOIN student_branches sb ON sb.branch_id = b.id
       LEFT JOIN students s ON s.client_id = sb.student_client_id
       LEFT JOIN tg_links l ON l.student_client_id = s.client_id
       LEFT JOIN tg_users u ON u.id = l.tg_user_id AND u.is_blocked = 0 AND u.is_subscribed = 1
       WHERE b.is_active = 1
       GROUP BY b.id, b.name ORDER BY b.name`,
    );
    const lines = rows.map((r) => `• ${r.name}: учеников ${r.students}, доступно в боте ${r.reachable}`);
    return ctx.reply(
      `Учеников в базе: ${t.students}\nПользователей бота: ${t.tg_users} (привязаны к ученикам: ${t.linked}, заблокировали: ${t.blocked})\n\nПо филиалам:\n${lines.join('\n') || '—'}`,
    );
  });

  bot.command('sync', adminOnly, async (ctx) => {
    if (isSyncing()) return ctx.reply('Синхронизация уже идёт.');
    const full = /full/i.test(ctx.message.text);
    await ctx.reply(`Запускаю ${full ? 'полную' : 'инкрементальную'} синхронизацию с HolliHop…`);
    try {
      const r = await runSync({ full });
      await ctx.reply(`Готово: филиалов ${r.offices}, учеников обработано ${r.students}, ${(r.ms / 1000).toFixed(1)} с`);
    } catch (e) {
      await ctx.reply(`Ошибка синхронизации: ${e.message}`);
    }
  });

  bot.command('adminhelp', adminOnly, (ctx) =>
    ctx.reply(
      '/broadcast — новая рассылка\n/broadcasts — последние рассылки\n/stopbroadcast <id> — остановить\n' +
        '/stats — статистика по филиалам\n/sync [full] — синхронизация с HolliHop\n/cancel — отменить создание рассылки',
    ),
  );
}

export const ADMIN_COMMANDS = [
  { command: 'broadcast', description: 'Новая рассылка' },
  { command: 'broadcasts', description: 'Последние рассылки' },
  { command: 'stats', description: 'Статистика по филиалам' },
  { command: 'sync', description: 'Синхронизация с HolliHop' },
  { command: 'adminhelp', description: 'Команды администратора' },
];
