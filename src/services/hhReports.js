import { hh } from '../hollihop/client.js';
import { config } from '../config.js';
import { listCalls } from '../moizvonki/client.js';
import { phoneKeys } from '../utils/phone.js';

/**
 * Отчёты для менторов прямо из HolliHop (активные ученики = MENTOR_ACTIVE_STATUSES):
 *  - проверка данных: нет фото, не заполнены пользовательские поля «расписание» / «время занятий»,
 *    расписание в поле не совпадает с расписанием групп ученика, ученик не в группе;
 *  - не посещает: за неделю нет ни одного результата теста категории «old daily» (групповые и персональные);
 *  - адаптация: ученики, созданные за последнюю неделю.
 * Данные кэшируются на 10 минут, чтобы менторы не упирались в лимиты HolliHop API.
 */
export const PROBLEMS = {
  photo: 'Нет фото',
  schedule: 'Не заполнено расписание',
  time: 'Не заполнено время занятий',
  mismatch: 'Некорректное расписание',
  nogroup: 'Не состоит в группе',
};

const DAYS = [['ПН', 1], ['ВТ', 2], ['СР', 4], ['ЧТ', 8], ['ПТ', 16], ['СБ', 32], ['ВС', 64]];
const TIME_TOLERANCE_MIN = 10; // «15:00» в поле и 14:55 в группе считаем одним временем
const CACHE_TTL = 10 * 60 * 1000;
const WEEK_DAYS = 7;
const LAST_RESULT_LOOKBACK_DAYS = 30; // насколько далеко искать дату последнего результата для «не посещает»

const daysMask = (text) =>
  (String(text).toUpperCase().match(/ПН|ВТ|СР|ЧТ|ПТ|СБ|ВС/g) || []).reduce((m, d) => m | DAYS.find((x) => x[0] === d)[1], 0);
const daysText = (mask) => DAYS.filter(([, b]) => mask & b).map(([d]) => d).join(' ');
const toMin = (t) => {
  const m = String(t ?? '').match(/(\d{1,2})[:.](\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
const day = (s) => (s ? String(s).trim().slice(0, 10) : '');
/** Дата (YYYY-MM-DD) в часовом поясе школы, со сдвигом на shift дней. */
const localDate = (shift = 0) =>
  new Date(Date.now() + shift * 86_400_000).toLocaleDateString('sv-SE', { timeZone: config.sync.timezone });

async function paged(fn, params, key, take) {
  const out = [];
  for (let skip = 0; ; skip += take) {
    const data = await hh(fn, { ...params, skip, take });
    const list = data[key] || [];
    out.push(...list);
    if (list.length < take) return out;
  }
}

/** Кэш с защитой от параллельных одинаковых запросов. */
function cached(load) {
  let value = null;
  let at = 0;
  let pending = null;
  return ({ refresh = false } = {}) => {
    if (!refresh && value && Date.now() - at < CACHE_TTL) return Promise.resolve(value);
    pending ??= load()
      .then((v) => { value = v; at = Date.now(); return v; })
      .finally(() => { pending = null; });
    return pending;
  };
}

/** Расписание группы на дату ref: пункты ScheduleItems, действующие в этот день (или ближайшие будущие). */
function scheduleAt(unit, ref) {
  const items = unit.ScheduleItems || [];
  let cur = items.filter((i) => day(i.BeginDate) <= ref && (!day(i.EndDate) || day(i.EndDate) >= ref));
  if (!cur.length) cur = items.filter((i) => !day(i.EndDate) || day(i.EndDate) >= ref);
  return {
    mask: cur.reduce((m, i) => m | (i.Weekdays || 0), 0),
    starts: [...new Set(cur.map((i) => i.BeginTime).filter(Boolean))],
    text: cur.length
      ? [...new Set(cur.map((i) => `${daysText(i.Weekdays || 0)} ${i.BeginTime || ''}-${i.EndTime || ''}`.trim()))].join(', ')
      : 'нет расписания',
  };
}

/** Активные ученики и их текущие группы. */
const getActive = cached(async () => {
  const ref = localDate();
  const [students, memberships, units] = await Promise.all([
    paged('GetStudents', { statuses: config.mentor.activeStatuses.join(',') }, 'Students', 1000),
    paged('GetEdUnitStudents', { statuses: 'Normal', edUnitTypes: 'Group,MiniGroup' }, 'EdUnitStudents', 10000),
    hh('GetEdUnits', { types: 'Group,MiniGroup', statuses: 'Forming,Working' }).then((d) => d.EdUnits || []),
  ]);
  const unitById = new Map(units.map((u) => [u.Id, u]));

  // текущие группы ученика: не отчислен (EndDate не прошла) и группа набирается/работает
  const groupsOf = new Map();
  for (const m of memberships) {
    const unit = unitById.get(m.EdUnitId);
    if (!unit || (day(m.EndDate) && day(m.EndDate) < ref)) continue;
    const sch = scheduleAt(unit, day(m.BeginDate) > ref ? day(m.BeginDate) : ref);
    if (!groupsOf.has(m.StudentClientId)) groupsOf.set(m.StudentClientId, []);
    groupsOf.get(m.StudentClientId).push({ name: String(m.EdUnitName || unit.Name || '').replace(/\s+/g, ' ').trim(), ...sch });
  }
  return { students, groupsOf };
});

/** Общие колонки строки отчёта. */
function baseRow(s, groups) {
  return {
    hh_id: s.Id,
    client_id: s.ClientId,
    name: [s.LastName, s.FirstName, s.MiddleName].filter(Boolean).join(' '),
    status: s.Status || '',
    branchIds: (s.OfficesAndCompanies || []).map((b) => b.Id),
    branches: (s.OfficesAndCompanies || []).map((b) => b.Name).join(', '),
    phone: s.Mobile || s.Phone || '',
    parents: (s.Agents || [])
      .map((a) => [a.LastName, a.FirstName, a.Mobile || a.Phone].filter(Boolean).join(' '))
      .filter(Boolean)
      .join('; '),
    groups: groups.map((g) => `${g.name}: ${g.text}`).join('; '),
  };
}

const byBranchAndName = (a, b) => a.branches.localeCompare(b.branches, 'ru') || a.name.localeCompare(b.name, 'ru');

// ---------- проверка данных ----------
export async function getDataCheck({ refresh = false } = {}) {
  const { students, groupsOf } = await getActive({ refresh });
  const { scheduleField, timeField } = config.mentor;
  const rows = [];
  for (const s of students) {
    const ef = new Map((s.ExtraFields || []).map((f) => [String(f.Name).trim().toUpperCase(), String(f.Value ?? '').trim()]));
    const schedule = ef.get(scheduleField.toUpperCase()) || '';
    const time = ef.get(timeField.toUpperCase()) || '';
    const groups = groupsOf.get(s.ClientId) || [];

    const problems = [];
    if (!s.PhotoUrls?.length) problems.push('photo');
    if (!schedule) problems.push('schedule');
    if (!time) problems.push('time');
    if (!groups.length) problems.push('nogroup');

    const mismatch = [];
    if (groups.length && (schedule || time)) {
      const mask = daysMask(schedule);
      const unionMask = groups.reduce((m, g) => m | g.mask, 0);
      if (schedule && !(mask && (mask === unionMask || groups.some((g) => g.mask === mask)))) {
        mismatch.push(mask ? `дни: в поле ${daysText(mask)}, в группе ${daysText(unionMask) || '—'}` : `дни не распознаны: «${schedule}»`);
      }
      const start = toMin(time);
      if (time && start === null) mismatch.push(`время не распознано: «${time}»`);
      else if (time && !groups.some((g) => g.starts.some((t) => Math.abs(toMin(t) - start) <= TIME_TOLERANCE_MIN))) {
        mismatch.push(`время: в поле ${time}, в группе ${[...new Set(groups.flatMap((g) => g.starts))].join(', ') || '—'}`);
      }
      if (mismatch.length) problems.push('mismatch');
    }
    if (!problems.length) continue;
    rows.push({ ...baseRow(s, groups), schedule, time, mismatch: mismatch.join('; '), problems });
  }
  return { rows: rows.sort(byBranchAndName), total: students.length };
}

// ---------- не посещает ----------
/** Дата последнего результата «old daily» (групповой или персональный) по ученику за LAST_RESULT_LOOKBACK_DAYS дней. */
const getOldDailyLast = cached(async () => {
  const category = config.mentor.attendanceTestCategory;
  const from = localDate(-LAST_RESULT_LOOKBACK_DAYS);
  const to = localDate();
  const [group, personal] = await Promise.all([
    paged('GetEdUnitTestResults', { dateFrom: from, dateTo: to, testTypeCategoryName: category }, 'EdUnitTestResults', 1000),
    paged('GetPersonalTestResults', { from: `${from}T00:00`, to: `${to}T23:59` }, 'PersonalTestResults', 1000),
  ]);
  const last = new Map();
  const add = (id, d) => { if (d && (!last.has(id) || last.get(id) < d)) last.set(id, d); };
  const isCategory = (x) => String(x.TestTypeCategoryName || '').trim().toLowerCase() === category.toLowerCase();
  for (const r of group) if (isCategory(r)) add(r.StudentClientId, day(r.Date));
  for (const r of personal) if (isCategory(r)) add(r.StudentClientId, day(r.DateTime));
  return last;
});

export async function getNotAttending({ refresh = false } = {}) {
  const [{ students, groupsOf }, last] = await Promise.all([getActive({ refresh }), getOldDailyLast({ refresh })]);
  const weekFrom = localDate(-WEEK_DAYS);
  const rows = students
    .filter((s) => !(last.get(s.ClientId) >= weekFrom))
    .map((s) => ({ ...baseRow(s, groupsOf.get(s.ClientId) || []), lastResult: last.get(s.ClientId) || `нет за ${LAST_RESULT_LOOKBACK_DAYS} дн.` }));
  return { rows: rows.sort(byBranchAndName), weekFrom };
}

// ---------- адаптация ----------
export async function getAdaptation({ refresh = false } = {}) {
  const { students, groupsOf } = await getActive({ refresh });
  const since = Date.now() - WEEK_DAYS * 86_400_000;
  const createdAt = (s) => (s.Created ? Date.parse(`${String(s.Created).slice(0, 19)}Z`) : NaN); // Created — UTC
  const fmt = (t) => new Date(t).toLocaleString('ru-RU', { timeZone: config.sync.timezone });
  const rows = students
    .filter((s) => createdAt(s) >= since)
    .map((s) => ({ ...baseRow(s, groupsOf.get(s.ClientId) || []), created: fmt(createdAt(s)), createdTs: createdAt(s) }));
  return { rows: rows.sort((a, b) => b.createdTs - a.createdTs) };
}

// ---------- звонки «Мои звонки» по ученику ----------
const CALLS_DAYS = 14;
const MIN_CALL_SEC = 90;
const CALL_DAY_FIELD = 'День обзвона постоянное';
const CALL_STATUS_FIELD = 'Статус звонка';

const fmtCallTime = (ts) =>
  new Date(ts * 1000).toLocaleString('ru-RU', { timeZone: config.sync.timezone, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Звонки по номеру (последние 10 цифр): [{ ts, sec, number }]. */
function indexCalls(calls) {
  const byPhone = new Map();
  for (const c of calls) {
    for (const key of phoneKeys(c.client_number)) {
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key).push({ ts: Number(c.start_time) || 0, sec: Number(c.duration) || 0, number: c.client_number });
    }
  }
  return byPhone;
}

/** Номера ученика и родителей с подписью «кто это». */
function contactsOf(s) {
  const out = new Map(); // key -> who
  const add = (raw, who) => { for (const k of phoneKeys(raw)) if (!out.has(k)) out.set(k, who); };
  add(s.Mobile, 'ученик');
  add(s.Phone, 'ученик');
  for (const a of s.Agents || []) {
    const who = [a.WhoIs, a.FirstName].filter(Boolean).join(' ') || 'родитель';
    add(a.Mobile, who);
    add(a.Phone, who);
  }
  return out;
}

/** Все звонки ученику и родителям, новые сверху: [{ ts, sec, number, who }]. */
function callsOf(s, byPhone) {
  const contacts = contactsOf(s);
  const list = [...contacts].flatMap(([key, who]) => (byPhone.get(key) || []).map((c) => ({ ...c, who })));
  return { list: list.sort((a, b) => b.ts - a.ts), hasPhones: contacts.size > 0 };
}

/** Колонки о звонках для строки отчёта; main — звонок, который показываем отдельными колонками. */
function callColumns(s, list, main) {
  return {
    mentor: (s.Assignees || []).map((a) => a.FullName).filter(Boolean).join(', '),
    parentPhones: (s.Agents || [])
      .map((a) => [a.WhoIs, a.FirstName].filter(Boolean).join(' ') + (a.Mobile || a.Phone ? `: ${[a.Mobile, a.Phone].filter(Boolean).join(', ')}` : ''))
      .filter((x) => x.trim())
      .join('; '),
    calls: list.length,
    maxSec: list.reduce((m, c) => Math.max(m, c.sec), 0),
    callNumber: main ? `${main.number} (${main.who})` : '',
    callDate: main ? fmtCallTime(main.ts) : '',
    callSec: main ? main.sec : '',
    allCalls: list.map((c) => `${fmtCallTime(c.ts)} — ${c.number} (${c.who}) — ${c.sec} сек`).join('\n'),
  };
}

const extraFields = (s) => new Map((s.ExtraFields || []).map((f) => [String(f.Name).trim().toLowerCase(), String(f.Value ?? '').trim()]));

// ---------- 14+: нет звонков за 2 недели ----------
const getCalls14 = cached(async () => indexCalls(await listCalls(Math.floor(Date.now() / 1000) - CALLS_DAYS * 86_400)));

/**
 * Активные ученики, с которыми за 14 дней не было разговора от 90 секунд:
 * ни на номер ученика, ни на номера родителей (звонков не было вовсе или все короче 90 сек).
 */
export async function getNoCalls({ refresh = false } = {}) {
  const [{ students, groupsOf }, byPhone] = await Promise.all([getActive({ refresh }), getCalls14({ refresh })]);
  const rows = [];
  for (const s of students) {
    const { list, hasPhones } = callsOf(s, byPhone);
    if (list.some((c) => c.sec >= MIN_CALL_SEC)) continue;
    const ef = extraFields(s);
    rows.push({
      ...baseRow(s, groupsOf.get(s.ClientId) || []),
      ...callColumns(s, list, list[0]), // последний звонок
      callDay: ef.get(CALL_DAY_FIELD.toLowerCase()) || '',
      callStatus: ef.get(CALL_STATUS_FIELD.toLowerCase()) || '',
      noPhones: !hasPhones,
    });
  }
  return { rows: rows.sort(byBranchAndName), days: CALLS_DAYS, minSec: MIN_CALL_SEC };
}

// ---------- ежедневная: план обзвона на день ----------
/** Смещение часового пояса школы (мс) для момента ts. */
function tzOffsetMs(ts) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: config.sync.timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]),
  );
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - ts;
}

const dayCallsCache = new Map(); // date -> { at, byPhone }

/** Звонки по номерам за календарный день date (YYYY-MM-DD) по времени школы. */
async function callsOnDate(date, refresh) {
  const hit = dayCallsCache.get(date);
  if (!refresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.byPhone;
  const utcMidnight = Date.parse(`${date}T00:00:00Z`);
  const from = Math.floor((utcMidnight - tzOffsetMs(utcMidnight)) / 1000);
  const byPhone = indexCalls(await listCalls(from, Math.min(from + 86_399, Math.floor(Date.now() / 1000))));
  dayCallsCache.set(date, { at: Date.now(), byPhone });
  return byPhone;
}

/**
 * Активные ученики, у которых пользовательское поле «День обзвона постоянное» = day,
 * и был ли с ними (номер ученика или родителей) разговор длиннее 90 секунд в день date.
 */
export async function getDailyCalls({ day: callDay, date, refresh = false }) {
  const [{ students, groupsOf }, byPhone] = await Promise.all([getActive({ refresh }), callsOnDate(date, refresh)]);
  const rows = [];
  for (const s of students) {
    const ef = extraFields(s);
    if (ef.get(CALL_DAY_FIELD.toLowerCase()) !== callDay) continue;
    const { list } = callsOf(s, byPhone);
    const longest = list.reduce((m, c) => (!m || c.sec > m.sec ? c : m), null);
    const callStatus = ef.get(CALL_STATUS_FIELD.toLowerCase()) || '';
    rows.push({
      ...baseRow(s, groupsOf.get(s.ClientId) || []),
      ...callColumns(s, list, longest), // самый длинный разговор за день
      callDay,
      callStatus,
      reached: callStatus.toLowerCase() === 'дозвон',
      actual: Boolean(longest && longest.sec > MIN_CALL_SEC),
    });
  }
  return { rows: rows.sort((a, b) => a.mentor.localeCompare(b.mentor, 'ru') || a.name.localeCompare(b.name, 'ru')), minSec: MIN_CALL_SEC };
}
