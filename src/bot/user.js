import { Markup } from 'telegraf';
import { config } from '../config.js';
import { query } from '../db.js';
import { getUserLinks } from '../services/links.js';
import { importStudentById } from '../hollihop/sync.js';
import { logger } from '../logger.js';
import { t, LANGS, DEFAULT_LANG, normLang, userCommands } from '../i18n.js';
import { ADMIN_COMMANDS } from './admin.js';

// защита от перебора ID: не более 5 неудачных попыток в час на чат
const MAX_FAILS = 5;
const WINDOW_MS = 60 * 60 * 1000;
const fails = new Map(); // chatId -> { count, resetAt }

function isLocked(chatId) {
  const f = fails.get(chatId);
  if (!f) return false;
  if (Date.now() > f.resetAt) { fails.delete(chatId); return false; }
  return f.count >= MAX_FAILS;
}
function addFail(chatId) {
  const f = fails.get(chatId);
  if (!f || Date.now() > f.resetAt) fails.set(chatId, { count: 1, resetAt: Date.now() + WINDOW_MS });
  else f.count += 1;
}

// Обращения к HolliHop при регистрации. У API лимит 600 запросов/30 сек, а перебор ID HolliHop считает
// подозрительной активностью, поэтому: общий лимит запросов в минуту + кэш «не найдено» на 10 минут.
const HH_LOOKUPS_PER_MIN = 20;
const NOT_FOUND_TTL_MS = 10 * 60 * 1000;
let hhWindow = { start: 0, count: 0 };
const notFoundCache = new Map(); // id -> когда истекает

function hhLookupAllowed() {
  const now = Date.now();
  if (now - hhWindow.start > 60_000) hhWindow = { start: now, count: 0 };
  if (hhWindow.count >= HH_LOOKUPS_PER_MIN) return false;
  hhWindow.count += 1;
  return true;
}
function isCachedNotFound(id) {
  const exp = notFoundCache.get(id);
  if (!exp) return false;
  if (exp < Date.now()) { notFoundCache.delete(id); return false; }
  return true;
}
function cacheNotFound(id) {
  if (notFoundCache.size > 5000) notFoundCache.clear();
  notFoundCache.set(id, Date.now() + NOT_FOUND_TTL_MS);
}

/** tg_users.lang: NULL = язык ещё не выбран (тогда везде казахский по умолчанию). */
async function upsertUser(from, chatId) {
  await query(
    `INSERT INTO tg_users (chat_id, username, first_name, last_name) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE username = VALUES(username), first_name = VALUES(first_name),
       last_name = VALUES(last_name), is_blocked = 0`,
    [chatId, from.username ?? null, from.first_name ?? null, from.last_name ?? null],
  );
  const [u] = await query('SELECT * FROM tg_users WHERE chat_id = ?', [chatId]);
  u.langChosen = Object.hasOwn(LANGS, u.lang);
  u.lang = normLang(u.lang);
  return u;
}

/** Язык пользователя без создания записи (по умолчанию казахский). */
async function langOf(ctx) {
  if (ctx.state.lang) return ctx.state.lang;
  const [r] = await query('SELECT lang FROM tg_users WHERE chat_id = ?', [ctx.chat.id]);
  ctx.state.lang = normLang(r?.lang);
  return ctx.state.lang;
}

// не раскрываем полное ФИО: «Иван П.»
const shortName = (s) => [s.first_name, s.last_name ? `${s.last_name[0]}.` : ''].filter(Boolean).join(' ');

function describeLinks(lang, links) {
  return links
    .map((l) => `• ${shortName(l)} — ${t(lang, l.relation === 'parent' ? 'rel_parent' : 'rel_student')}`)
    .join('\n');
}

const langKeyboard = () =>
  Markup.inlineKeyboard([Object.entries(LANGS).map(([code, label]) => Markup.button.callback(label, `lang:${code}`))]);

/** Меню команд конкретного чата на выбранном языке (у администраторов — плюс админские команды). */
async function setChatCommands(telegram, chatId, lang) {
  const list = userCommands(lang);
  try {
    await telegram.setMyCommands(config.adminIds.includes(chatId) ? [...list, ...ADMIN_COMMANDS] : list, {
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch { /* не критично */ }
}

/** Приветствие после /start или выбора языка. */
async function sendWelcome(ctx, u) {
  const lang = u.lang;
  const links = await getUserLinks(u.id);
  if (links.length) {
    await query('UPDATE tg_users SET is_subscribed = 1 WHERE id = ?', [u.id]);
    return ctx.reply(t(lang, 'welcome_back', { list: describeLinks(lang, links) }));
  }
  return ctx.reply(t(lang, 'welcome_new', { prompt: t(lang, 'prompt') }));
}

export function registerUser(bot) {
  bot.start(async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const u = await upsertUser(ctx.from, ctx.chat.id);
    // язык ещё не выбран — предлагаем выбрать (подсказка двуязычная)
    if (!u.langChosen) return ctx.reply(t(DEFAULT_LANG, 'lang_prompt'), langKeyboard());
    return sendWelcome(ctx, u);
  });

  bot.command('lang', (ctx) => {
    if (ctx.chat.type !== 'private') return;
    return ctx.reply(t(DEFAULT_LANG, 'lang_prompt'), langKeyboard());
  });

  bot.action(/^lang:(kk|ru)$/, async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const lang = ctx.match[1];
    const u = await upsertUser(ctx.from, ctx.chat.id);
    await query('UPDATE tg_users SET lang = ? WHERE id = ?', [lang, u.id]);
    ctx.state.lang = lang;
    await ctx.answerCbQuery();
    try { await ctx.editMessageText(t(lang, 'lang_set')); } catch { /* уже отредактировано */ }
    await setChatCommands(ctx.telegram, ctx.chat.id, lang);
    return sendWelcome(ctx, { ...u, lang, langChosen: true });
  });

  // ввод ID ученика
  bot.hears(/^\s*(\d{1,10})\s*$/, async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const u = await upsertUser(ctx.from, ctx.chat.id);
    const lang = u.lang;
    if (isLocked(ctx.chat.id)) return ctx.reply(t(lang, 'locked'));

    const id = Number(ctx.match[1]);
    const field = config.regIdField; // из белого списка в config.js
    const byStatus = config.allowedStatuses.length > 0; // ученики только с нужными статусами (RECIPIENT_STATUSES)
    let [s] = await query(
      `SELECT client_id, first_name, last_name FROM students WHERE ${field} = ?${byStatus ? ' AND status IN (?)' : ''} LIMIT 1`,
      byStatus ? [id, config.allowedStatuses] : [id],
    );

    // нет в нашей базе — возможно, ученик создан в HolliHop после последней синхронизации
    if (!s) {
      if (isCachedNotFound(id)) {
        addFail(ctx.chat.id);
        return ctx.reply(t(lang, 'not_found'));
      }
      if (!hhLookupAllowed()) return ctx.reply(t(lang, 'busy'));
      await ctx.sendChatAction('typing').catch(() => {});
      try {
        s = await importStudentById(id);
      } catch (err) {
        logger.error({ err, id }, 'Не удалось проверить ученика в HolliHop');
        return ctx.reply(t(lang, 'hh_error'));
      }
      if (!s) {
        cacheNotFound(id);
        addFail(ctx.chat.id);
        return ctx.reply(t(lang, 'not_found'));
      }
    }
    return ctx.reply(
      t(lang, 'found', { name: shortName(s) }),
      Markup.inlineKeyboard([
        [Markup.button.callback(t(lang, 'btn_parent'), `reg:parent:${s.client_id}`)],
        [Markup.button.callback(t(lang, 'btn_student'), `reg:student:${s.client_id}`)],
        [Markup.button.callback(t(lang, 'btn_wrong'), 'reg:no')],
      ]),
    );
  });

  bot.action(/^reg:(parent|student):(\d+)$/, async (ctx) => {
    const relation = ctx.match[1];
    const clientId = Number(ctx.match[2]);
    const u = await upsertUser(ctx.from, ctx.chat.id);
    const lang = u.lang;
    const [s] = await query('SELECT client_id FROM students WHERE client_id = ?', [clientId]);
    if (!s) {
      await ctx.answerCbQuery(t(lang, 'alert_no_student'), { show_alert: true });
      return;
    }
    await query('INSERT IGNORE INTO tg_links (tg_user_id, student_client_id, relation) VALUES (?, ?, ?)', [u.id, clientId, relation]);
    await query('UPDATE tg_users SET is_subscribed = 1 WHERE id = ?', [u.id]);
    await ctx.answerCbQuery(t(lang, 'ok'));
    const links = await getUserLinks(u.id);
    try {
      await ctx.editMessageText(t(lang, 'connected', { list: describeLinks(lang, links) }));
    } catch { /* уже отредактировано */ }
  });

  bot.action('reg:no', async (ctx) => {
    const lang = await langOf(ctx);
    await ctx.answerCbQuery();
    try { await ctx.editMessageText(t(lang, 'wrong_retry')); } catch { /* noop */ }
  });

  bot.command('me', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const u = await upsertUser(ctx.from, ctx.chat.id);
    const lang = u.lang;
    const links = await getUserLinks(u.id);
    if (!links.length) return ctx.reply(t(lang, 'not_connected', { prompt: t(lang, 'prompt') }));
    const state = t(lang, u.is_subscribed ? 'subs_on' : 'subs_off');
    return ctx.reply(`${describeLinks(lang, links)}\n\n${t(lang, 'me_footer', { state })}`);
  });

  // отвязать все привязки к ученикам
  bot.command('unlink', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const u = await upsertUser(ctx.from, ctx.chat.id);
    await query('DELETE FROM tg_links WHERE tg_user_id = ?', [u.id]);
    return ctx.reply(t(u.lang, 'unlink_done', { prompt: t(u.lang, 'prompt') }));
  });

  bot.command('stop', async (ctx) => {
    await query('UPDATE tg_users SET is_subscribed = 0 WHERE chat_id = ?', [ctx.chat.id]);
    return ctx.reply(t(await langOf(ctx), 'stop_done'));
  });

  bot.command('resume', async (ctx) => {
    await query('UPDATE tg_users SET is_subscribed = 1 WHERE chat_id = ?', [ctx.chat.id]);
    return ctx.reply(t(await langOf(ctx), 'resume_done'));
  });

  // пользователь заблокировал / разблокировал бота
  bot.on('my_chat_member', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const status = ctx.myChatMember.new_chat_member.status;
    await query('UPDATE tg_users SET is_blocked = ? WHERE chat_id = ?', [status === 'kicked' ? 1 : 0, ctx.chat.id]);
  });

  bot.command('help', async (ctx) => ctx.reply(t(await langOf(ctx), 'help')));

  bot.on('text', async (ctx) => {
    if (ctx.chat.type !== 'private') return;
    const lang = await langOf(ctx);
    return ctx.reply(t(lang, 'fallback', { prompt: t(lang, 'prompt') }));
  });
}
