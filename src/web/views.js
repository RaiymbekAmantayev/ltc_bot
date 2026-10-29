export const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--bg:#f4f6fb;--card:#fff;--text:#1b2133;--muted:#6b7488;--line:#e3e7f1;--accent:#2563eb;--accent2:#7c3aed;--ok:#16a34a;--bad:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#0f1320;--card:#171c2e;--text:#e8ebf5;--muted:#98a1ba;--line:#262d45;--accent:#60a5fa;--accent2:#a78bfa;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:var(--bg);color:var(--text)}
a{color:var(--accent)}
.hero{background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;padding:28px 20px 70px}
.wrap{max-width:1200px;margin:0 auto;padding:0 16px}
.hero .wrap{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
.hero h1{margin:0;font-size:24px}.hero p{margin:4px 0 0;opacity:.9}
.hero a.btn{color:#fff;border:1px solid rgba(255,255,255,.6);padding:7px 14px;border-radius:8px;text-decoration:none}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin-top:-48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;box-shadow:0 4px 14px rgba(0,0,0,.06)}
.card .n{font-size:28px;font-weight:700}.card .l{color:var(--muted);font-size:13px}
form.filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;align-items:end;margin:16px 0}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:3px}
input,select{width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit}
button,.btn2{padding:9px 14px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;cursor:pointer;text-decoration:none;display:inline-block;text-align:center}
.btn2.sec{background:transparent;color:var(--accent);border:1px solid var(--line)}
.bar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;margin:6px 0 10px;color:var(--muted)}
.tw{overflow-x:auto}table{width:100%;border-collapse:collapse}
th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);white-space:nowrap}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;background:var(--bg);border:1px solid var(--line);font-size:12px;white-space:nowrap}
.ok{color:var(--ok);font-weight:600}.no{color:var(--muted)}.bad{color:var(--bad)}
details summary{cursor:pointer;font-weight:600}details .d{margin:8px 0 2px;padding:10px;background:var(--bg);border-radius:8px;font-size:13px}
.d h4{margin:8px 0 3px;font-size:12px;color:var(--muted);text-transform:uppercase}.d ul{margin:0;padding-left:18px}
.pager{display:flex;gap:8px;justify-content:center;align-items:center;margin:16px 0}
.note{font-size:12px;color:var(--muted);margin:4px 0 24px}
.login{max-width:360px;margin:12vh auto;padding:0 16px}.login .card{padding:24px}.login h1{margin:0 0 16px;font-size:22px}
textarea{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--text);font:inherit;resize:vertical}
.chk{display:flex;gap:8px;align-items:flex-start;margin:10px 0;color:var(--text);font-size:14px}.chk input{width:auto;margin-top:4px}
.ok-msg{background:rgba(22,163,74,.12);color:var(--ok);padding:8px 10px;border-radius:8px;margin:12px 0}
.bar2{height:8px;background:var(--line);border-radius:99px;overflow:hidden;min-width:90px}.bar2>i{display:block;height:100%;background:var(--accent)}
.ms{position:relative}
.ms summary{list-style:none;cursor:pointer;font-weight:400;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ms summary::-webkit-details-marker{display:none}.ms summary::after{content:' ▾';color:var(--muted)}
.ms[open] summary{border-color:var(--accent)}
.ms .opts{position:absolute;z-index:10;top:calc(100% + 4px);left:0;min-width:100%;width:max-content;max-width:320px;max-height:280px;overflow:auto;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.ms .opt{display:flex;gap:8px;align-items:center;margin:0;padding:6px 8px;border-radius:6px;font-size:14px;color:var(--text);cursor:pointer}
.ms .opt:hover{background:var(--bg)}.ms .opt input{width:auto;margin:0}
.err{background:rgba(220,38,38,.1);color:var(--bad);padding:8px 10px;border-radius:8px;margin-bottom:12px}
`;

const layout = (title, body) =>
  `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body>${body}</body></html>`;

export function loginPage(error) {
  return layout(
    'Вход — админка',
    `<div class="login"><div class="card"><h1>🔐 Админка бота</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/login">
<label for="p">Пароль</label><input id="p" type="password" name="password" autofocus required>
<div style="margin-top:14px"><button style="width:100%">Войти</button></div>
</form></div></div>`,
  );
}

export function mentorLoginPage(error) {
  return layout(
    'Вход — выгрузки',
    `<div class="login"><div class="card"><h1>📋 Выгрузки для менторов</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/mentor/login">
<label for="l">Логин</label><input id="l" name="login" autocomplete="username" autofocus required>
<div style="margin-top:10px"><label for="p">Пароль</label><input id="p" type="password" name="password" autocomplete="current-password" required></div>
<div style="margin-top:14px"><button style="width:100%">Войти</button></div>
</form></div></div>`,
  );
}

export function errorPage(msg = 'Внутренняя ошибка') {
  return layout('Ошибка', `<div class="login"><div class="card"><h1>Ошибка</h1><p>${esc(msg)}</p><a href="/">На главную</a></div></div>`);
}

export function qs(f, extra = {}) {
  const p = new URLSearchParams();
  if (f.q) p.set('q', f.q);
  for (const x of f.statuses || []) p.append('status', x);
  for (const x of f.branches || []) p.append('branch', String(x));
  if (f.bot) p.set('bot', f.bot);
  if (f.regFrom) p.set('reg_from', f.regFrom);
  if (f.regTo) p.set('reg_to', f.regTo);
  for (const [k, v] of Object.entries(extra)) if (v !== '' && v !== undefined && v !== null) p.set(k, String(v));
  const str = p.toString();
  return str ? `?${str}` : '';
}

/** Мультивыбор без JS: выпадающий список с чекбоксами (<details>). */
function multiSelect(name, label, options, selected, allLabel) {
  const sel = new Set(selected.map(String));
  const chosen = options.filter((o) => sel.has(String(o.value)));
  const summary = chosen.length === 0 ? allLabel : chosen.length === 1 ? chosen[0].label : `Выбрано: ${chosen.length}`;
  const items = options
    .map((o) => `<label class="opt"><input type="checkbox" name="${name}" value="${esc(o.value)}"${sel.has(String(o.value)) ? ' checked' : ''}> ${esc(o.label)}</label>`)
    .join('');
  return `<div><label>${esc(label)}</label><details class="ms"><summary>${esc(summary)}</summary><div class="opts">${items || '<span class="no" style="padding:6px 8px">нет данных</span>'}</div></details></div>`;
}

const name = (o) => [o.last_name, o.first_name, o.middle_name].filter(Boolean).join(' ') || '—';

export function dashboardPage({ f, stats, statuses, branches, rows, total, reg, perPage, agentsBy, tgBy, regField }) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const statusMs = multiSelect(
    'status', 'Статус',
    statuses.map((x) => ({ value: x.status ?? '__none__', label: `${x.status ?? 'Без статуса'} (${x.n})` })),
    f.statuses, 'Все статусы',
  );
  const branchMs = multiSelect('branch', 'Филиал', branches.map((b) => ({ value: b.id, label: b.name })), f.branches, 'Все филиалы');
  const botOpts = [['', 'Все'], ['yes', 'Подключены к боту'], ['no', 'Не подключены'], ['parent', 'Зарегистрирован родитель'], ['student', 'Зарегистрирован ученик']]
    .map(([v, l]) => `<option value="${v}"${f.bot === v ? ' selected' : ''}>${l}</option>`)
    .join('');

  const body = rows
    .map((r) => {
      const agents = agentsBy.get(r.client_id) || [];
      const tgs = tgBy.get(r.client_id) || [];
      const agentsHtml = agents.length
        ? `<ul>${agents.map((a) => `<li>${esc(name(a))}${a.who_is ? ` (${esc(a.who_is)})` : ''} — ${esc(a.mobile || a.phone || 'нет телефона')}</li>`).join('')}</ul>`
        : '<div class="no">нет данных</div>';
      const tgHtml = tgs.length
        ? `<ul>${tgs
            .map((t) => {
              const st = t.is_blocked ? '<span class="bad">заблокировал бота</span>' : t.is_subscribed ? '<span class="ok">активен</span>' : 'отписался';
              const who = t.username ? `@${esc(t.username)}` : esc(t.first_name || `chat ${t.chat_id}`);
              return `<li>${who} — ${t.relation === 'parent' ? 'родитель' : 'ученик'}, ${t.lang === 'ru' ? 'RU' : 'KZ'}, ${st}${t.reg_at ? `, с ${esc(t.reg_at)}` : ''}</li>`;
            })
            .join('')}</ul>`
        : '<div class="no">никто не подключён</div>';
      return `<tr>
<td>${r.hh_id}</td><td>${r.client_id}</td>
<td><details><summary>${esc(name(r))}</summary><div class="d">
<h4>Ученик</h4>${esc(r.mobile || r.phone || 'нет телефона')}${r.email ? ` · ${esc(r.email)}` : ''}
<h4>Родители / контакты</h4>${agentsHtml}
<h4>Telegram</h4>${tgHtml}
</div></details></td>
<td>${r.status ? `<span class="badge">${esc(r.status)}</span>` : '<span class="no">—</span>'}</td>
<td>${esc(r.branches || '—')}</td>
<td>${r.bot_users > 0 ? `<span class="ok">✅ ${r.bot_users}</span>` : '<span class="no">—</span>'}</td>
</tr>`;
    })
    .join('');

  const pager = `<div class="pager">
${f.page > 1 ? `<a class="btn2 sec" href="/${qs(f, { page: f.page - 1 })}">← Назад</a>` : ''}
<span>Стр. ${f.page} из ${pages}</span>
${f.page < pages ? `<a class="btn2 sec" href="/${qs(f, { page: f.page + 1 })}">Вперёд →</a>` : ''}
</div>`;

  return layout(
    'Админка — ученики',
    `<div class="hero"><div class="wrap"><div><h1>📣 Админка рассылок</h1><p>Ученики, филиалы и подключение к Telegram-боту</p></div>
<div style="display:flex;gap:8px"><a class="btn" href="/broadcasts">Рассылки</a><a class="btn" href="/mentor">Выгрузки</a><a class="btn" href="/logout">Выйти</a></div></div></div>
<div class="wrap">
<div class="cards">
<div class="card"><div class="n">${stats.students}</div><div class="l">учеников в базе</div></div>
<div class="card"><div class="n">${stats.connected}</div><div class="l">учеников, к кому подключён бот</div></div>
<div class="card"><div class="n">${stats.activeUsers}</div><div class="l">активных получателей в боте</div></div>
<div class="card"><div class="n">${stats.parents}</div><div class="l">родителей зарегистрировалось</div></div>
<div class="card"><div class="n">${stats.studentUsers}</div><div class="l">учеников зарегистрировалось</div></div>
<div class="card"><div class="n">${stats.branches}</div><div class="l">филиалов</div></div>
</div>
<form class="filters" method="get" action="/">
<div><label>ID ученика или ФИО</label><input name="q" value="${esc(f.q)}" placeholder="например 1234 или Иванов"></div>
${statusMs}
${branchMs}
<div><label>Telegram-бот</label><select name="bot">${botOpts}</select></div>
<div><label>Регистрация в боте с</label><input type="date" name="reg_from" value="${esc(f.regFrom)}"></div>
<div><label>по</label><input type="date" name="reg_to" value="${esc(f.regTo)}"></div>
<div style="display:flex;gap:8px"><button>Найти</button><a class="btn2 sec" href="/">Сброс</a></div>
</form>
<div class="bar"><span>Найдено: <b>${total}</b> · зарегистрировалось родителей: <b>${reg.parents}</b>, учеников: <b>${reg.students}</b></span><div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn2" href="/broadcast${qs(f)}">📣 Рассылка по фильтру</a><a class="btn2 sec" href="/export.xlsx${qs(f)}">⬇ Экспорт в Excel</a></div></div>
<div class="card tw" style="padding:0"><table>
<thead><tr><th>ID</th><th>ClientId</th><th>Ученик</th><th>Статус</th><th>Филиалы</th><th>В боте</th></tr></thead>
<tbody>${body || '<tr><td colspan="6" class="no" style="text-align:center;padding:30px">Ничего не найдено</td></tr>'}</tbody></table></div>
${pager}
<div class="note">ID — это «Id» ученика в HolliHop, ClientId — «ClientId». Для регистрации в боте сейчас используется: <b>${regField === 'client_id' ? 'ClientId' : 'ID'}</b>. Поиск по числу ищет по обоим.</div>
</div>`,
  );
}

const HEAD = (title, sub) => `<div class="hero"><div class="wrap"><div><h1>${title}</h1><p>${sub}</p></div>
<div style="display:flex;gap:8px"><a class="btn" href="/">Ученики</a><a class="btn" href="/broadcasts">Рассылки</a><a class="btn" href="/mentor">Выгрузки</a><a class="btn" href="/logout">Выйти</a></div></div></div>`;

export function broadcastFormPage({ f, title, counts, csrf, error, text = '', audience = 'all', html = false, personalize = true, restricted = [] }) {
  const opt = (v, label, c) =>
    `<option value="${v}"${audience === v ? ' selected' : ''}>${label} — ${c.people} чел., ${c.messages} сообщ.</option>`;
  const hidden = [
    `<input type="hidden" name="q" value="${esc(f.q)}">`,
    ...f.statuses.map((x) => `<input type="hidden" name="status" value="${esc(x)}">`),
    ...f.branches.map((x) => `<input type="hidden" name="branch" value="${x}">`),
    ...(f.regFrom ? [`<input type="hidden" name="reg_from" value="${esc(f.regFrom)}">`] : []),
    ...(f.regTo ? [`<input type="hidden" name="reg_to" value="${esc(f.regTo)}">`] : []),
  ].join('');
  return layout(
    'Новая рассылка',
    `${HEAD('📣 Новая рассылка', 'Сообщение получат ученики и родители, подключённые к боту')}
<div class="wrap" style="margin-top:-40px;max-width:760px">
<div class="card">
<p style="margin-top:0"><b>Кому:</b> ${esc(title)}</p>
<p class="note" style="margin:0 0 12px">Учеников по фильтру: <b>${counts.totalStudents}</b>, из них подключено к боту: <b>${counts.connected}</b>.
Остальные сообщение не получат — писать первыми Telegram не позволяет.${restricted.length ? ` Дополнительно действует фильтр статусов из .env: ${esc(restricted.join(', '))}.` : ''}</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/broadcast">
<input type="hidden" name="csrf" value="${esc(csrf)}">${hidden}
<label>Аудитория</label>
<select name="audience">${opt('all', 'Родители и ученики', counts.all)}${opt('parents', 'Только родители', counts.parents)}${opt('students', 'Только ученики', counts.students)}</select>
<label class="chk"><input type="checkbox" name="personalize" value="1"${personalize ? ' checked' : ''}><span>Отдельное сообщение на каждого ученика с обращением <b>«Уважаемый родитель ученика Иванов Иван!»</b> (на языке получателя: по умолчанию казахский, русский — если выбран в боте). Если у родителя несколько детей, он получит по сообщению на каждого. Обращение пишется на языке получателя (по умолчанию қазақша, если язык не выбран), а основной текст уходит так, как вы его написали. Без галочки — одно сообщение на человека, без обращения.</span></label>
<label>Текст сообщения (до 3800 символов)</label>
<textarea name="text" rows="9" maxlength="3800" required>${esc(text)}</textarea>
<label class="chk"><input type="checkbox" name="html" value="1"${html ? ' checked' : ''}><span>Использовать HTML-форматирование: <code>&lt;b&gt;жирный&lt;/b&gt;</code>, <code>&lt;i&gt;курсив&lt;/i&gt;</code>, <code>&lt;a href="https://…"&gt;ссылка&lt;/a&gt;</code>. Без галочки текст уходит как есть.</span></label>
<label class="chk"><input type="checkbox" name="confirm" value="1" required><span>Я проверил(а) текст и фильтр и подтверждаю отправку. Отменить уже отправленные сообщения нельзя.</span></label>
<button>🚀 Отправить рассылку</button> <a class="btn2 sec" href="/${qs(f)}">Назад к списку</a>
</form>
<p class="note">Сообщение с фото, видео или файлом можно разослать из Telegram-бота командой /broadcast.</p>
</div></div>`,
  );
}

const PROBLEM_LABELS = {
  photo: 'Нет фото',
  schedule: 'Не заполнено расписание',
  time: 'Не заполнено время занятий',
  mismatch: 'Некорректное расписание (поле не совпадает с группой)',
  nogroup: 'Не состоит ни в одной группе',
};

export function mentorPage({ f, who, unregistered, statuses, branches, title, activeStatuses, fields, testCategory, today }) {
  const statusMs = multiSelect(
    'status', 'Статус',
    statuses.map((x) => ({ value: x.status ?? '__none__', label: `${x.status ?? 'Без статуса'} (${x.n})` })),
    f.statuses, 'Все статусы',
  );
  const branchOpts = branches.map((b) => ({ value: b.id, label: b.name }));
  const branchMs = (selected = []) => multiSelect('branch', 'Филиал', branchOpts, selected, 'Все мои филиалы');
  const whoOpts = [['none', 'Никто не зарегистрирован'], ['parent', 'Не зарегистрирован родитель'], ['student', 'Не зарегистрирован ученик']]
    .map(([v, l]) => `<option value="${v}"${who === v ? ' selected' : ''}>${l}</option>`)
    .join('');
  const problemChecks = Object.entries(PROBLEM_LABELS)
    .map(([v, l]) => `<label class="chk"><input type="checkbox" name="problem" value="${v}"><span>${esc(l)}</span></label>`)
    .join('');
  const refresh = '<label class="chk"><input type="checkbox" name="refresh" value="1"><span>Обновить данные из HolliHop (не брать из кэша)</span></label>';
  const section = (icon, head, body) => `<div class="card" style="margin-bottom:16px"><h2 style="margin-top:0;font-size:18px">${icon} ${head}</h2>${body}</div>`;
  const nav = '<a class="btn" href="/login">Админка</a>'; // вход в админку всегда по паролю администратора
  const active = esc(activeStatuses.join(', '));

  return layout(
    'Выгрузки',
    `<div class="hero"><div class="wrap"><div><h1>📋 Выгрузки</h1><p>${esc(title)} · филиалы: ${esc(branches.map((b) => b.name).join(', ') || 'нет')}</p></div>
<div style="display:flex;gap:8px">${nav}<a class="btn" href="/mentor/logout">Выйти</a></div></div></div>
<div class="wrap" style="margin-top:-40px;max-width:900px">
${section('🤖', 'Не зарегистрированы в Telegram-боте', `
<form class="filters" method="get" action="/mentor" style="margin-top:0">
${statusMs}
${branchMs(f.branches)}
<div><label>Кто не зарегистрирован</label><select name="who">${whoOpts}</select></div>
<div><button>Показать</button></div>
</form>
<div class="bar"><span>Учеников в списке: <b>${unregistered}</b></span>
<a class="btn2" href="/mentor/unregistered.xlsx${qs({ ...f, q: '', bot: '' }, { who })}">⬇ Скачать Excel</a></div>
<p class="note" style="margin:0">ID HolliHop, ФИО, статус, филиал, телефон ученика, родители с телефонами и кто из них уже подключился к боту.</p>`)}
${section('🚫', 'Не посещают', `
<p class="note" style="margin:0 0 8px">Активные ученики (${active}), у которых за последние 7 дней нет ни одного результата теста категории
«${esc(testCategory)}» — ни группового, ни персонального. В файле — дата последнего такого результата за 30 дней.</p>
<form method="get" action="/mentor/not-attending.xlsx">${branchMs()}${refresh}<button>⬇ Скачать Excel</button></form>`)}
${section('📅', 'Ежедневная (план обзвона)', `
<p class="note" style="margin:0 0 8px">Активные ученики, у которых в HolliHop поле «День обзвона постоянное» равно выбранному дню.
Файл из двух листов: <b>Сводка</b> — запланировано / «Статус звонка» = Дозвон / фактически был разговор больше 90 секунд по «Мои звонки»
(номер ученика или родителей) за выбранную дату, всего и по каждому ментору; <b>Ученики</b> — список.</p>
<form method="get" action="/mentor/daily.xlsx">
<div class="filters" style="margin:0">
<div><label>День обзвона</label><input type="number" name="day" min="0" max="31" required placeholder="например 3"></div>
<div><label>Дата звонков (по умолчанию сегодня)</label><input type="date" name="date" value="${esc(today)}" max="${esc(today)}"></div>
${branchMs()}
</div>
${refresh}<button>⬇ Скачать Excel</button></form>`)}
${section('📞', '14+ (нет звонков за 2 недели)', `
<p class="note" style="margin:0 0 8px">Активные ученики (${active}), с которыми за последние 14 дней по «Мои звонки» не было разговора от 90 секунд —
ни на номер ученика, ни на номера родителей (звонков не было вовсе или все короче 90 сек).
Колонки: ID, ФИО, статус, моб. телефон, ментор, «День обзвона постоянное», «Статус звонка».</p>
<form method="get" action="/mentor/no-calls.xlsx">${branchMs()}${refresh}<button>⬇ Скачать Excel</button></form>`)}
${section('🌱', 'Адаптация', `
<p class="note" style="margin:0 0 8px">Активные ученики (${active}), созданные в HolliHop за последние 7 дней.</p>
<form method="get" action="/mentor/adaptation.xlsx">${branchMs()}${refresh}<button>⬇ Скачать Excel</button></form>`)}
${section('🗂', 'Проверка данных в HolliHop', `
<p class="note" style="margin:0 0 8px">Активные ученики (${active}), у которых не хватает хотя бы одного из данных.
Расписание и время берутся из пользовательских полей «${esc(fields[0])}» и «${esc(fields[1])}» и сравниваются с текущим расписанием групп ученика
(время совпадает, если начало отличается не больше чем на 10 минут).</p>
<form method="get" action="/mentor/hh-check.xlsx">
${branchMs()}
<label style="margin-top:10px">Что проверить (ничего не выбрано — все проблемы)</label>
${problemChecks}
${refresh}
<button>⬇ Скачать Excel</button>
</form>`)}
<p class="note">Выгрузки «Не посещают», «Адаптация» и «Проверка данных» берут данные из HolliHop напрямую и кэшируются на 10 минут; первая выгрузка формируется до ~30 секунд.</p>
</div>`,
  );
}

const STATUS_RU = { running: '⏳ идёт', done: '✅ завершена', cancelled: '⛔ остановлена', failed: '❌ ошибка' };

export function broadcastsPage({ rows, csrf, createdId, refresh }) {
  const body = rows
    .map((b) => {
      const pct = b.total ? Math.round(((b.sent + b.failed + b.blocked) / b.total) * 100) : 100;
      return `<tr>
<td>#${b.id}</td><td>${esc(b.created)}</td>
<td>${esc(b.title || '—')}<div class="no" style="font-size:12px">${esc((b.text || '[сообщение из бота]').slice(0, 90))}</div></td>
<td>${STATUS_RU[b.status] || esc(b.status)}</td>
<td><div class="bar2"><i style="width:${pct}%"></i></div>${b.sent} / ${b.total}
<div class="no" style="font-size:12px">блок: ${b.blocked}, ошибки: ${b.failed}</div></td>
<td>${b.status === 'running' ? `<form method="post" action="/broadcasts/${b.id}/stop"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="btn2 sec" style="padding:5px 10px">Остановить</button></form>` : ''}</td>
</tr>`;
    })
    .join('');
  return layout(
    'Рассылки',
    `${refresh ? '<meta http-equiv="refresh" content="5">' : ''}${HEAD('📜 Рассылки', 'История и ход отправки (обновляется автоматически, пока идёт отправка)')}
<div class="wrap" style="margin-top:-40px">
${createdId ? `<div class="ok-msg">Рассылка #${createdId} запущена.</div>` : ''}
<div class="card tw" style="padding:0"><table>
<thead><tr><th>№</th><th>Создана</th><th>Кому / текст</th><th>Статус</th><th>Прогресс</th><th></th></tr></thead>
<tbody>${body || '<tr><td colspan="6" class="no" style="text-align:center;padding:30px">Рассылок ещё не было</td></tr>'}</tbody></table></div>
</div>`,
  );
}
