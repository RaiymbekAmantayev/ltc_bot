import { Telegraf } from 'telegraf';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { registerAdmin } from './admin.js';
import { registerUser } from './user.js';

export function createBot() {
  const bot = new Telegraf(config.botToken);
  registerAdmin(bot); // раньше пользовательских: перехватывает сообщения мастера рассылки
  registerUser(bot);
  bot.catch((err, ctx) => logger.error({ err, update: ctx.update?.update_id }, 'Ошибка обработки апдейта'));
  return bot;
}
