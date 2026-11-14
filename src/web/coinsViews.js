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

const pct = (rate) => `${Math.round(Number(rate || 0) * 100)}%`;
const callBadge = (v) => {
  if (!v) return '<span class="no">—</span>';
  const cls = v.toLowerCase() === 'дозвон' ? ' ok' : v.toLowerCase().includes('недозвон') ? ' bad' : '';
  return `<span class="badge${cls}">${esc(v)}</span>`;
};
const fmtDay = (d) => (d ? d.split('-').reverse().join('.') : '');
/** Выпадающий список: значения списка + текущее значение, если его там нет (сохранено раньше). */
const options = (list, cur, empty) => `<option value="">${empty}</option>${[...new Set([...list, ...(cur && !list.includes(cur) ? [cur] : [])])]
  .map((s) => `<option${s === cur ? ' selected' : ''}>${esc(s)}</option>`).join('')}`;

/**
 * «Кураторы → Пропуски»: ученики с пропусками из LTC, статус звонка и день обзвона из HolliHop,
 * статус и причина пропуска. Период общий: меняет только руководитель, остальные видят его только для чтения.
 */
export function absencesPage({ user, f, rows, shown, total, page, pages, days, mentors, sorts, callStatuses = [], emptyCall = '__empty', statuses, reasons, reasonRequired, csrf, ok, error }) {
  const qp = { q: f.q, mentor: f.mentor, call: f.call, day: f.day, sort: f.sort }; // период в ссылках не нужен — он общий
  const back = link('/coins/absences', { ...qp, page });
  const body = rows.map((r) => {
    const fb = r.feedback;
    const need = reasonRequired.includes(fb?.status || '');
    return `<tr id="s${esc(r.studentId)}"><td>${esc(r.hh?.hh_id ?? '—')}<div class="no" style="font-size:12px">ClientId ${esc(r.studentId)}</div></td>
<td>${esc(r.student || '—')}<div class="no" style="font-size:12px">${esc(r.groupsText)}</div></td>
${user.isHead ? `<td style="font-size:13px">${esc(r.hh?.assignees || '—')}</td>` : ''}
<td style="white-space:nowrap"><b style="font-size:16px">${pct(r.rate)}</b><div class="no" style="font-size:12px">${Number(r.absent) || 0} из ${Number(r.lessons) || 0}</div></td>
<td>${callBadge(r.callStatus)}</td>
<td>${r.callDay ? esc(r.callDay) : '<span class="no">—</span>'}</td>
<td><form method="post" action="/coins/absences/feedback" class="fbf" style="display:grid;gap:6px;min-width:230px">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="back" value="${esc(back)}">
<input type="hidden" name="student_id" value="${esc(r.studentId)}"><input type="hidden" name="from" value="${esc(f.from)}"><input type="hidden" name="to" value="${esc(f.to)}">
<select name="status" required aria-label="Статус пропуска">${options(statuses, fb?.status || '', 'Статус…')}</select>
<select name="reason" aria-label="Причина пропуска"${need ? ' required' : ''}>${options(reasons, fb?.reason || '', need ? 'Причина — обязательно' : 'Причина (необязательно)')}</select>
<button style="padding:7px 12px">${fb ? 'Обновить' : 'Сохранить'}</button></form>
${fb ? `<div class="no" style="font-size:12px;margin-top:4px">${esc(fb.mentor || '')}${fb.mentor ? ' · ' : ''}${esc(r.feedbackAtText)}</div>` : ''}</td></tr>`;
  }).join('');
  const cols = user.isHead ? 7 : 6;
  const callOpts = [['', 'Все'], [emptyCall, 'Не заполнено'], ...[...new Set([...callStatuses, ...(f.call && f.call !== emptyCall ? [f.call] : [])])].map((s) => [s, s])]
    .map(([v, l]) => `<option value="${esc(v)}"${f.call === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const dayOpts = `<option value="">Все</option>${days.map((d) => `<option${f.day === d ? ' selected' : ''}>${esc(d)}</option>`).join('')}`;
  const sortOpts = Object.entries(sorts).map(([v, l]) => `<option value="${v}"${f.sort === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const periodText = `${fmtDay(f.from)} — ${fmtDay(f.to)}`;
  const period = user.isHead
    ? `<form class="filters" method="post" action="/coins/absences/period" style="margin:0 0 4px;padding-bottom:12px;border-bottom:1px solid var(--line)">
<input type="hidden" name="csrf" value="${esc(csrf)}">
<div><label>Период для всех кураторов: с</label><input type="date" name="from" value="${esc(f.from)}" required></div>
<div><label>по</label><input type="date" name="to" value="${esc(f.to)}" required></div>
<div><button>Сохранить период</button></div>
<div class="no" style="font-size:12px;align-self:center">${f.periodSet ? 'Кураторы видят этот период и не могут его менять.' : 'Период ещё не задан — по умолчанию текущий месяц.'}</div>
</form>`
    : `<div class="bar" style="margin:0 0 4px"><span>Период: <b>${periodText}</b> <span class="badge">🔒 устанавливает руководитель</span></span></div>`;
  return layout(
    'Кураторы — пропуски',
    `${head(user, '📅 Пропуски учеников', user.isHead ? 'Все ученики' : 'Мои ученики')}
<div class="wrap" style="margin-top:-40px">
<div class="card">
${msg({ ok, error })}
${period}
<form class="filters" method="get" action="/coins/absences">
<div><label>ID ученика или ФИО</label><input name="q" value="${esc(f.q)}" placeholder="например 1234 или Иванов"></div>
${user.isHead ? `<div><label>Куратор (ответственный)</label>${mentorSelect(mentors, f.mentor, 'Все ученики')}</div>` : ''}
<div><label>Статус звонка (HolliHop)</label><select name="call">${callOpts}</select></div>
<div><label>День обзвона постоянное</label><select name="day">${dayOpts}</select></div>
<div><label>Сортировка</label><select name="sort">${sortOpts}</select></div>
<div style="display:flex;gap:8px"><button>Найти</button><a class="btn2 sec" href="/coins/absences">Сброс</a></div>
</form>
<div class="bar" style="margin-bottom:0"><span>Период ${periodText} · показано: <b>${shown}</b> из <b>${total}</b> учеников с пропусками</span>
<span style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn2 sec" href="${link('/coins/absences', { ...qp, refresh: 1 })}">↻ Обновить из LTC</a>
<a class="btn2 sec" href="${link('/coins/absences.xlsx', qp)}">⬇ Экспорт в Excel</a></span></div>
</div>
<div class="card tw" style="padding:0;margin-top:12px"><table>
<thead><tr><th>ID</th><th>Ученик · группы</th>${user.isHead ? '<th>Куратор</th>' : ''}<th>% пропусков</th><th>Статус звонка</th><th>День обзвона</th><th>Статус и причина пропуска</th></tr></thead>
<tbody>${body || `<tr><td colspan="${cols}" class="no" style="text-align:center;padding:30px">${error ? 'Список не загружен' : 'Учеников с пропусками за период нет'}</td></tr>`}</tbody></table></div>
${pager('/coins/absences', qp, page, pages)}
<p class="note">Пропуски и уже данные статусы приходят из LTC (список кэшируется на 5 минут, «Обновить из LTC» — загрузить заново).
«Статус звонка» и «День обзвона постоянное» — пользовательские поля HolliHop по ученику (обновляются раз в 10 минут).
Причина выбирается из списка; для статуса ${reasonRequired.map((s) => `«${esc(s)}»`).join(', ')} она обязательна.
Повторное сохранение перезаписывает статус и причину.</p>
</div>
<script>
(() => {
  const need = ${JSON.stringify(reasonRequired).replace(/</g, '\\u003c')};
  for (const form of document.querySelectorAll('form.fbf')) {
    const st = form.elements.status;
    const rs = form.elements.reason;
    const sync = () => {
      const req = need.includes(st.value);
      rs.required = req;
      rs.options[0].textContent = req ? 'Причина — обязательно' : 'Причина (необязательно)';
    };
    st.addEventListener('change', sync);
    sync();
  }
})();
</script>`,
  );
}
