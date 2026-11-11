import { esc, layout } from './views.js';

/** Коины как в HolliHop: 1701.2, 1700; нет значения — «—». */
export const fmtCoins = (v) => (v === null || v === undefined ? '—' : String(Math.round(Number(v) * 100) / 100));

const link = (path, params) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null) p.set(k, String(v));
  const s = p.toString();
  return s ? `${path}?${s}` : path;
};

function head(user, title, sub) {
  const nav = [
    ['/coins', '🪙 Коины'],
    ['/coins/absences', '📅 Пропуски'],
    ['/coins/history', 'История'],
    ...(user.isHead ? [['/coins/products', 'Товары']] : []),
    ['/coins/password', 'Пароль'],
    ['/coins/logout', 'Выйти'],
  ].map(([href, l]) => `<a class="btn" href="${href}">${l}</a>`).join('');
  return `<div class="hero"><div class="wrap"><div><h1>${title}</h1><p>Кураторы · ${esc(sub)} · ${esc(user.name)} (ID ${user.id})${user.isHead ? ' · руководитель' : ''}</p></div>
<div style="display:flex;gap:8px;flex-wrap:wrap">${nav}</div></div></div>`;
}
const msg = ({ ok, error }) => `${ok ? `<div class="ok-msg">${esc(ok)}</div>` : ''}${error ? `<div class="err">${esc(error)}</div>` : ''}`;
const pager = (path, params, page, pages) => (pages <= 1 ? '' : `<div class="pager">
${page > 1 ? `<a class="btn2 sec" href="${link(path, { ...params, page: page - 1 })}">← Назад</a>` : ''}
<span>Стр. ${page} из ${pages}</span>
${page < pages ? `<a class="btn2 sec" href="${link(path, { ...params, page: page + 1 })}">Вперёд →</a>` : ''}
</div>`);
const mentorSelect = (mentors, selected, allLabel) => `<select name="mentor"><option value="">${allLabel}</option>${mentors
  .map((m) => `<option value="${m.id}"${selected === m.id ? ' selected' : ''}>${esc(m.name)} (${m.n})</option>`).join('')}</select>`;

export function coinsLoginPage(error, defaultHint) {
  return layout(
    'Вход — кураторы',
    `<div class="login"><div class="card"><h1>👥 Кураторы</h1>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/coins/login">
<label for="l">Ваш ID сотрудника в HolliHop</label><input id="l" name="login" inputmode="numeric" autocomplete="username" autofocus required>
<div style="margin-top:10px"><label for="p">Пароль</label><input id="p" type="password" name="password" autocomplete="current-password" required></div>
<div style="margin-top:14px"><button style="width:100%">Войти</button></div>
</form>
${defaultHint ? '<p class="note" style="margin:12px 0 0">При первом входе — пароль, который выдал администратор. Потом смените его в разделе «Пароль».</p>' : ''}
</div></div>`,
  );
}

export function coinsListPage({ user, rows, total, sumCoins, page, pages, f, mentors, products, csrf, ok, error }) {
  const productOpts = products.map((p) => `<option value="${p.id}">${esc(p.name)} — ${fmtCoins(p.price)}</option>`).join('');
  const back = link('/coins', { ...f, page });
  const body = rows.map((r) => {
    const coins = r.coins === null ? 0 : Number(r.coins);
    const affordable = products.filter((p) => Number(p.price) <= coins);
    const form = !products.length
      ? '<span class="no">нет товаров</span>'
      : !affordable.length
        ? '<span class="no">не хватает коинов</span>'
        : `<form method="post" action="/coins/spend" style="display:flex;gap:6px;min-width:260px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="client_id" value="${r.client_id}"><input type="hidden" name="back" value="${esc(back)}">
<select name="product_id" required><option value="">Товар…</option>${affordable.map((p) => `<option value="${p.id}">${esc(p.name)} — ${fmtCoins(p.price)}</option>`).join('')}</select>
<button style="white-space:nowrap">Списать</button></form>`;
    return `<tr><td>${r.hh_id}</td><td>${esc([r.last_name, r.first_name, r.middle_name].filter(Boolean).join(' ') || '—')}
<div class="no" style="font-size:12px">${esc(r.status || '')}${r.branches ? ` · ${esc(r.branches)}` : ''}</div></td>
${user.isHead ? `<td>${esc(r.assignees || '—')}</td>` : ''}
<td style="font-size:18px;font-weight:700;white-space:nowrap">🪙 ${fmtCoins(r.coins)}</td><td>${form}</td></tr>`;
  }).join('');
  const cols = user.isHead ? 5 : 4;
  return layout(
    'Кураторы — коины',
    `${head(user, '🪙 Коины', user.isHead ? 'Все ученики' : 'Мои ученики')}
<div class="wrap" style="margin-top:-40px">
<div class="card">
${msg({ ok, error })}
<form class="filters" method="get" action="/coins" style="margin-top:0">
<div><label>ID ученика или ФИО</label><input name="q" value="${esc(f.q)}" placeholder="например 1234 или Иванов"></div>
${user.isHead ? `<div><label>Куратор (ответственный)</label>${mentorSelect(mentors, f.mentor, 'Все ученики')}</div>` : ''}
<div style="display:flex;gap:8px"><button>Найти</button><a class="btn2 sec" href="/coins">Сброс</a></div>
</form>
<div class="bar" style="margin-bottom:0"><span>Учеников: <b>${total}</b> · коинов у них всего: <b>${fmtCoins(sumCoins)}</b></span>
<span>Товаров в выборе: <b>${products.length}</b>${productOpts ? '' : user.isHead ? ' — <a href="/coins/products">добавить</a>' : ' — товары добавляет руководитель'}</span></div>
</div>
<div class="card tw" style="padding:0;margin-top:12px"><table>
<thead><tr><th>ID</th><th>Ученик</th>${user.isHead ? '<th>Куратор</th>' : ''}<th>Коины</th><th>Списать за товар</th></tr></thead>
<tbody>${body || `<tr><td colspan="${cols}" class="no" style="text-align:center;padding:30px">${user.isHead ? 'Ничего не найдено' : 'За вами в HolliHop не закреплено учеников (поле «Ответственный»)'}</td></tr>`}</tbody></table></div>
${pager('/coins', f, page, pages)}
<p class="note">Коины берутся из поля HolliHop «Коины» (список обновляется раз в 10 минут). При списании текущее значение проверяется в HolliHop,
новое записывается туда же, а операция сохраняется в истории. Отменить списание можно только вручную в HolliHop.</p>
</div>`,
  );
}

const ACTION = { spend: 'Списание', product_add: 'Новый товар', product_edit: 'Изменение товара' };

export function coinsHistoryPage({ user, rows, total, page, pages, f, mentors }) {
  const body = rows.map((r) => `<tr><td style="white-space:nowrap">${esc(r.at)}</td><td>${ACTION[r.action] || esc(r.action)}</td>
<td>${esc(r.employee_name || '')} <span class="no">(${r.employee_id})</span></td>
<td>${r.student_client_id ? `${esc(r.student_name || '')} <span class="no">(ID ${r.student_hh_id ?? '—'})</span>` : '<span class="no">—</span>'}</td>
<td>${esc(r.product_name || '—')}${r.price !== null ? ` <span class="no">· ${fmtCoins(r.price)}</span>` : ''}</td>
<td style="white-space:nowrap">${r.action === 'spend' ? `${fmtCoins(r.coins_before)} → <b>${fmtCoins(r.coins_after)}</b>` : ''}</td>
<td style="font-size:13px">${esc(r.note || '')}</td></tr>`).join('');
  return layout(
    'Кураторы — история',
    `${head(user, '📜 История', user.isHead ? 'Все действия' : 'Мои действия')}
<div class="wrap" style="margin-top:-40px">
<div class="card">
<form class="filters" method="get" action="/coins/history" style="margin-top:0">
<div><label>Ученик: ID или ФИО</label><input name="q" value="${esc(f.q)}"></div>
${user.isHead ? `<div><label>Кто сделал</label>${mentorSelect(mentors, f.mentor, 'Все')}</div>` : ''}
<div><label>Действие</label><select name="action"><option value="">Все</option>${Object.entries(ACTION)
  .map(([v, l]) => `<option value="${v}"${f.action === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
<div><label>С</label><input type="date" name="from" value="${esc(f.from)}"></div>
<div><label>По</label><input type="date" name="to" value="${esc(f.to)}"></div>
<div style="display:flex;gap:8px"><button>Найти</button><a class="btn2 sec" href="/coins/history">Сброс</a></div>
</form>
<div class="bar" style="margin-bottom:0"><span>Записей: <b>${total}</b></span><a class="btn2 sec" href="${link('/coins/history.xlsx', f)}">⬇ Экспорт в Excel</a></div>
</div>
<div class="card tw" style="padding:0;margin-top:12px"><table>
<thead><tr><th>Когда (Астана)</th><th>Действие</th><th>Кто</th><th>Ученик</th><th>Товар · цена</th><th>Коины</th><th>Примечание</th></tr></thead>
<tbody>${body || '<tr><td colspan="7" class="no" style="text-align:center;padding:30px">Записей нет</td></tr>'}</tbody></table></div>
${pager('/coins/history', f, page, pages)}
</div>`,
  );
}

export function coinsProductsPage({ user, products, csrf, ok, error }) {
  const body = products.map((p) => `<tr><td colspan="4" style="padding:6px 10px">
<form method="post" action="/coins/products/${p.id}" style="display:grid;grid-template-columns:2fr 1fr auto auto;gap:8px;align-items:center">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<input name="name" value="${esc(p.name)}" maxlength="255" required aria-label="Название">
<input name="price" value="${fmtCoins(p.price)}" inputmode="decimal" required aria-label="Цена">
<label class="chk" style="margin:0;white-space:nowrap"><input type="checkbox" name="active" value="1"${p.is_active ? ' checked' : ''}><span>в выборе</span></label>
<button class="btn2 sec" style="padding:7px 12px">Сохранить</button>
</form></td></tr>`).join('');
  return layout(
    'Кураторы — товары',
    `${head(user, '🛍 Товары', 'Что можно получить за коины')}
<div class="wrap" style="margin-top:-40px;max-width:820px">
<div class="card">
${msg({ ok, error })}
<h2 style="margin-top:0;font-size:18px">Добавить товар</h2>
<form class="filters" method="post" action="/coins/products" style="margin:0">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div style="grid-column:span 2"><label>Название</label><input name="name" maxlength="255" required placeholder="например Тетрадь LTC"></div>
<div><label>Цена, коинов</label><input name="price" inputmode="decimal" required placeholder="150"></div>
<div><button>Добавить</button></div>
</form>
</div>
<div class="card tw" style="padding:0;margin-top:12px"><table>
<thead><tr><th>Название · цена · в выборе</th></tr></thead>
<tbody>${body || '<tr><td class="no" style="text-align:center;padding:30px">Товаров ещё нет</td></tr>'}</tbody></table></div>
<p class="note">Товар без галочки «в выборе» скрыт у менторов, но остаётся в истории. Все изменения товаров тоже пишутся в историю.</p>
</div>`,
  );
}

export function coinsPasswordPage({ user, csrf, ok, error }) {
  return layout(
    'Кураторы — пароль',
    `${head(user, '🔑 Пароль', 'Смена пароля')}
<div class="wrap" style="margin-top:-40px;max-width:420px">
<div class="card">
${msg({ ok, error })}
<form method="post" action="/coins/password">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<label for="c">Текущий пароль</label><input id="c" type="password" name="current" autocomplete="current-password" required>
<div style="margin-top:10px"><label for="n">Новый пароль (от 6 символов)</label><input id="n" type="password" name="next" minlength="6" autocomplete="new-password" required></div>
<div style="margin-top:10px"><label for="r">Новый пароль ещё раз</label><input id="r" type="password" name="repeat" minlength="6" autocomplete="new-password" required></div>
<div style="margin-top:14px"><button style="width:100%">Сменить пароль</button></div>
</form></div></div>`,
  );
}

/** Как прошла доставка сообщения в бот (страница и Excel). */
export const msgStatusText = (m) => {
  if (!m) return '';
  if (m.status === 'running') return `Отправляется (${m.sent} из ${m.total})`;
  if (m.sent > 0) return `Ушло (${m.sent} из ${m.total})`;
  if (m.status === 'cancelled') return 'Отменено';
  return 'Не доставлено';
};
const msgBadge = (m) => {
  if (!m) return '';
  const running = m.status === 'running';
  const cls = running ? '' : m.sent > 0 ? ' ok' : ' bad';
  const icon = running ? '⏳' : m.sent > 0 ? '✅' : '❌';
  return `<div style="margin-bottom:6px"><span class="badge${cls}">${icon} ${esc(msgStatusText(m))}</span>
<div class="no" style="font-size:12px">${esc(m.at)}${m.by ? ` · ${esc(m.by)}` : ''}</div></div>`;
};

const pct = (rate) => `${Math.round(Number(rate || 0) * 100)}%`;
const callBadge = (v) => {
  if (!v) return '<span class="no">—</span>';
  const cls = v.toLowerCase() === 'дозвон' ? ' ok' : v.toLowerCase().includes('недозвон') ? ' bad' : '';
  return `<span class="badge${cls}">${esc(v)}</span>`;
};

/** «Кураторы → Пропуски»: ученики с пропусками из LTC, статус звонка и день обзвона из HolliHop, форма статуса и причины. */
export function absencesPage({ user, f, rows, shown, total, page, pages, days, mentors, statuses, reasons, csrf, ok, error }) {
  const back = link('/coins/absences', { ...f, page });
  const statusOpts = (cur) => `<option value="">Статус…</option>${[...new Set([...statuses, ...(cur && !statuses.includes(cur) ? [cur] : [])])]
    .map((s) => `<option${s === cur ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;
  const body = rows.map((r) => {
    const fb = r.feedback;
    return `<tr id="s${esc(r.studentId)}"><td>${esc(r.hh?.hh_id ?? '—')}<div class="no" style="font-size:12px">ClientId ${esc(r.studentId)}</div></td>
<td>${esc(r.student || '—')}<div class="no" style="font-size:12px">${esc(r.groupsText)}</div></td>
${user.isHead ? `<td style="font-size:13px">${esc(r.hh?.assignees || '—')}</td>` : ''}
<td style="white-space:nowrap"><b>${Number(r.absent) || 0}</b> из ${Number(r.lessons) || 0}<div class="no" style="font-size:12px">${pct(r.rate)}</div></td>
<td>${callBadge(r.callStatus)}</td>
<td>${r.callDay ? esc(r.callDay) : '<span class="no">—</span>'}</td>
<td><form method="post" action="/coins/absences/feedback" style="display:grid;gap:6px;min-width:230px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="${esc(back)}">
<input type="hidden" name="student_id" value="${esc(r.studentId)}"><input type="hidden" name="from" value="${esc(f.from)}"><input type="hidden" name="to" value="${esc(f.to)}">
<select name="status" required aria-label="Статус пропуска">${statusOpts(fb?.status || '')}</select>
<input name="reason" list="reasons" maxlength="1000" value="${esc(fb?.reason || '')}" placeholder="Причина (необязательно)" aria-label="Причина пропуска">
<button style="padding:7px 12px">${fb ? 'Обновить' : 'Сохранить'}</button></form>
${fb ? `<div class="no" style="font-size:12px;margin-top:4px">${esc(fb.mentor || '')}${fb.mentor ? ' · ' : ''}${esc(r.feedbackAtText)}</div>` : ''}</td>
<td style="white-space:nowrap">${msgBadge(r.msg)}${r.tg.parents || r.tg.students
    ? `<a class="btn2 sec" style="padding:7px 12px" href="${link('/coins/absences/message', { ...f, student: r.studentId })}">📣 ${r.msg ? 'Написать ещё' : 'Написать'}</a>
<div class="no" style="font-size:12px;margin-top:4px">в боте: ${r.tg.parents ? `родит. ${r.tg.parents}` : ''}${r.tg.parents && r.tg.students ? ', ' : ''}${r.tg.students ? 'ученик' : ''}</div>`
    : '<span class="no" style="font-size:12px">не подключён<br>к боту</span>'}</td></tr>`;
  }).join('');
  const cols = user.isHead ? 8 : 7;
  const fbOpts = [['', 'Все'], ['none', 'Без статуса'], ['done', 'Со статусом'], ...statuses.map((s) => [s, s])]
    .map(([v, l]) => `<option value="${esc(v)}"${f.fb === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const dayOpts = `<option value="">Все</option>${days.map((d) => `<option${f.day === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}`;
  return layout(
    'Кураторы — пропуски',
    `${head(user, '📅 Пропуски учеников', user.isHead ? 'Все ученики' : 'Мои ученики')}
<div class="wrap" style="margin-top:-40px">
<div class="card">
${msg({ ok, error })}
<form class="filters" method="get" action="/coins/absences" style="margin-top:0">
<div><label>С</label><input type="date" name="from" value="${esc(f.from)}" required></div>
<div><label>По</label><input type="date" name="to" value="${esc(f.to)}" required></div>
<div><label>ID ученика или ФИО</label><input name="q" value="${esc(f.q)}" placeholder="например 1234 или Иванов"></div>
${user.isHead ? `<div><label>Куратор (ответственный)</label>${mentorSelect(mentors, f.mentor, 'Все ученики')}</div>` : ''}
<div><label>Статус пропуска</label><select name="fb">${fbOpts}</select></div>
<div><label>День обзвона постоянное</label><select name="day">${dayOpts}</select></div>
<div><label>Сообщение в бот</label><select name="msg">${[['', 'Все'], ['sent', 'Отправлено'], ['none', 'Не отправлено']]
  .map(([v, l]) => `<option value="${v}"${f.msg === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
<div style="display:flex;gap:8px"><button>Найти</button><a class="btn2 sec" href="/coins/absences">Сброс</a></div>
</form>
<div class="bar" style="margin-bottom:0"><span>Показано: <b>${shown}</b> из <b>${total}</b> учеников с пропусками</span>
<span style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn2 sec" href="${link('/coins/absences', { ...f, refresh: 1 })}">↻ Обновить из LTC</a>
<a class="btn2 sec" href="${link('/coins/absences.xlsx', f)}">⬇ Экспорт в Excel</a></span></div>
</div>
<datalist id="reasons">${reasons.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
<div class="card tw" style="padding:0;margin-top:12px"><table>
<thead><tr><th>ID</th><th>Ученик · группы</th>${user.isHead ? '<th>Куратор</th>' : ''}<th>Пропуски</th><th>Статус звонка</th><th>День обзвона</th><th>Статус и причина пропуска</th><th>Сообщение в бот</th></tr></thead>
<tbody>${body || `<tr><td colspan="${cols}" class="no" style="text-align:center;padding:30px">${error ? 'Список не загружен' : 'Учеников с пропусками за период нет'}</td></tr>`}</tbody></table></div>
${pager('/coins/absences', f, page, pages)}
<p class="note">Пропуски и уже данные статусы приходят из LTC (список кэшируется на 5 минут, «Обновить из LTC» — загрузить заново).
«Статус звонка» и «День обзвона постоянное» — пользовательские поля HolliHop по ID ученика (обновляются раз в 10 минут).
Статус сохраняется в LTC за выбранный период; повторное сохранение перезаписывает статус и причину.</p>
</div>`,
  );
}

/** Сообщение в Telegram-бот по одному ученику из «Пропусков»: родителям и/или самому ученику. */
export function absencesBroadcastPage({ user, f, student: st, counts, csrf, error, text = '', audience = 'parents', botReady = true }) {
  const def = audience === 'parents' && !counts.parents.messages && counts.students.messages ? 'students' : audience;
  const opt = (v, label, c) => `<option value="${v}"${def === v ? ' selected' : ''}${c.messages ? '' : ' disabled'}>${label} — ${c.people} чел.</option>`;
  const hidden = Object.entries({ ...f, student: st?.studentId ?? '' })
    .filter(([, v]) => v !== '' && v !== null && v !== undefined)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join('');
  const backUrl = `${link('/coins/absences', f)}${st ? `#s${st.studentId}` : ''}`;
  const canSend = botReady && st && counts.all.messages > 0;
  return layout(
    'Кураторы — сообщение',
    `${head(user, '📣 Сообщение в бот', 'Пропуски ученика')}
<div class="wrap" style="margin-top:-40px;max-width:760px">
<div class="card">
${st ? `<p style="margin-top:0"><b>${esc(st.student)}</b> <span class="no">· ID ${esc(st.hh?.hh_id ?? '—')} · ClientId ${esc(st.studentId)}</span></p>
<p class="note" style="margin:0 0 12px">${esc(st.groupsText)} · пропусков <b>${Number(st.absent) || 0}</b> из ${Number(st.lessons) || 0} за ${esc(f.from)} — ${esc(f.to)}
${st.callStatus ? ` · статус звонка: ${esc(st.callStatus)}` : ''}${st.feedback ? ` · статус пропуска: ${esc(st.feedback.status)}${st.feedback.reason ? ` (${esc(st.feedback.reason)})` : ''}` : ''}</p>` : ''}
${msg({ error: error || (botReady ? null : 'Бот недоступен — сообщение отправить нельзя.') || (st && !counts.all.messages ? 'Ни родители, ни ученик не подключены к боту — отправить некому.' : null) })}
${st ? `<form method="post" action="/coins/absences/message">
<input type="hidden" name="csrf" value="${esc(csrf)}">${hidden}
<label>Кому</label>
<select name="audience">${opt('parents', 'Родителям', counts.parents)}${opt('students', 'Ученику', counts.students)}${opt('all', 'Родителям и ученику', counts.all)}</select>
<p class="note" style="margin:6px 0 10px">Родитель получит сообщение с обращением «Уважаемый родитель ученика ${esc(st.student)}!» на своём языке в боте.</p>
<label>Текст сообщения (до 3800 символов)</label>
<textarea name="text" rows="7" maxlength="3800" required placeholder="Например: ваш ребёнок пропустил ${Number(st.absent) || 0} занятие(я). Пожалуйста, свяжитесь с куратором.">${esc(text)}</textarea>
<div style="margin-top:12px"><button${canSend ? '' : ' disabled'}>🚀 Отправить</button> <a class="btn2 sec" href="${esc(backUrl)}">Назад к списку</a></div>
</form>` : `<a class="btn2 sec" href="${esc(backUrl)}">Назад к списку</a>`}
<p class="note">Сообщение уходит только этому ученику и/или его родителям, подключённым к боту. Оно также видно в админке в разделе «Рассылки».</p>
</div></div>`,
  );
}
