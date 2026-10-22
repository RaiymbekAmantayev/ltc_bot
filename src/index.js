import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './migrate.js';
import { pool, query } from './db.js';
import { createBot } from './bot/index.js';
import { ADMIN_COMMANDS } from './bot/admin.js';
import { userCommands } from './i18n.js';
import { runSync } from './hollihop/sync.js';
import { startWorker } from './services/broadcast.js';
import { startWebServer } from './web/server.js';
import { startWeb } from './web/server.js';

async function main() {
  await migrate();

  const bot = createBot();
  const me = await bot.telegram.getMe();
  logger.info({ bot: me.username }, 'Токен Telegram валиден');

  // первая загрузка данных в фоне: полная, если БД пустая
  const [{ n }] = await query('SELECT COUNT(*) AS n FROM students');
  runSync({ full: n === 0 }).catch((err) => logger.error({ err }, 'Первичная синхронизация не удалась'));

  const tz = { timezone: config.sync.timezone };
  cron.schedule(config.sync.incrementalCron, () =>
    runSync({ full: false }).catch((err) => logger.error({ err }, 'Инкрементальная синхронизация не удалась')), tz);
  cron.schedule(config.sync.fullCron, () =>
    runSync({ full: true }).catch((err) => logger.error({ err }, 'Полная синхронизация не удалась')), tz);

  // меню команд по умолчанию — на казахском; после выбора языка бот ставит меню для конкретного чата
  await bot.telegram.setMyCommands(userCommands('kk'));
  for (const id of config.adminIds) {
    const [row] = await query('SELECT lang FROM tg_users WHERE chat_id = ?', [id]);
    bot.telegram
      .setMyCommands([...userCommands(row?.lang), ...ADMIN_COMMANDS], { scope: { type: 'chat', chat_id: id } })
      .catch(() => {}); // у админа должен быть хотя бы один /start с ботом
  }

  startWorker(bot); // продолжить рассылки, прерванные рестартом
  const web = startWebServer(bot);

  bot.launch({ dropPendingUpdates: false }, () => logger.info('Бот запущен')).catch((err) => {
    logger.error({ err }, 'Бот остановлен с ошибкой');
    process.exit(1);
  });

  const shutdown = (sig) => {
    logger.info({ sig }, 'Остановка');
    bot.stop(sig);
    web?.close();
    pool.end().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Фатальная ошибка при запуске');
  process.exit(1);
});
