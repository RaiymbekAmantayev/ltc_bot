import 'dotenv/config';

const req = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`Не задана переменная окружения ${k}`);
  return v;
};
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  botToken: req('BOT_TOKEN'),
  adminIds: list(process.env.ADMIN_IDS).map(Number).filter(Number.isFinite),
  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: req('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: req('DB_NAME'),
  },
  hh: {
    subdomain: req('HH_SUBDOMAIN'),
    authKey: req('HH_AUTH_KEY'),
    pageSize: Number(process.env.HH_PAGE_SIZE || 500),
  },
  sync: {
    incrementalCron: process.env.SYNC_INCREMENTAL_CRON || '*/10 * * * *',
    fullCron: process.env.SYNC_FULL_CRON || '30 3 * * *',
    timezone: process.env.TZ_NAME || 'Asia/Almaty',
  },
  broadcast: {
    ratePerSec: Math.max(1, Math.min(30, Number(process.env.BROADCAST_RATE || 20))),
  },
  // по какому ID регистрируются: hh_id (Id ученика) или client_id (ClientId)
  regIdField: process.env.REG_ID_FIELD === 'client_id' ? 'client_id' : 'hh_id',
  web: {
    port: Number(process.env.WEB_PORT || 3000),
    adminPassword: process.env.ADMIN_PASSWORD || '',
    sessionSecret: process.env.SESSION_SECRET || '',
  },
  web: {
    port: Number(process.env.ADMIN_WEB_PORT || 3000),
    password: process.env.ADMIN_WEB_PASSWORD || '',
    secret: process.env.ADMIN_WEB_SECRET || '',
    secureCookie: process.env.ADMIN_WEB_SECURE_COOKIE === '1',
  },
  // страница выгрузок для менторов (/mentor): свои логины, без доступа к рассылкам.
  // Ментор Алматы видит только филиалы MENTOR_ALMATY_BRANCHES, ментор Астаны — все остальные.
  mentor: {
    accounts: {
      almaty: { login: process.env.MENTOR_ALMATY_LOGIN || 'almaty', password: process.env.MENTOR_ALMATY_PASSWORD || '' },
      astana: { login: process.env.MENTOR_ASTANA_LOGIN || 'astana', password: process.env.MENTOR_ASTANA_PASSWORD || '' },
    },
    almatyBranches: list(process.env.MENTOR_ALMATY_BRANCHES || 'Сейфуллина'),
    attendanceTestCategory: process.env.MENTOR_ATTENDANCE_TEST_CATEGORY || 'old daily',
    activeStatuses: list(process.env.MENTOR_ACTIVE_STATUSES || 'Занимается,Регистрация,Заморозка'),
    scheduleField: process.env.MENTOR_SCHEDULE_FIELD || 'РАСПИСАНИЕ',
    timeField: process.env.MENTOR_TIME_FIELD || 'ВРЕМЯ ЗАНЯТИЙ',
  },
  // «Мои звонки» — для выгрузки «14+» (звонки ученикам и родителям)
  moizvonki: {
    url: process.env.MOIZVONKI_URL || '',
    user: process.env.MOIZVONKI_USER || '',
    apiKey: process.env.MOIZVONKI_API_KEY || '',
  },
  allowedStatuses: list(process.env.RECIPIENT_STATUSES),
};
