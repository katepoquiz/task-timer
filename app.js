// Task Timer: UI and app behavior.
import {
  KEY, REMINDER_MIN, REMINDER_MAX, UserError, load, update, loadWarning, cleanName,
  startTimer, pauseTimer, resumeTimer, stopTimer, discardTimer, removeGap, markSeen,
  editSession, deleteSession, mergeBackup,
} from './store.js';
import {
  MIN, isRunning, elapsedMs, formatClock, formatDuration, formatTime, formatDate,
  relativeDay, dayKey, decimalHours, weekStartKey, monthStartKey,
} from './time.js';

const GAP_MS = 5 * MIN;        // longer than this without the app ticking = closed or asleep
const HEARTBEAT_MS = 15_000;   // how often "last seen" is saved while running

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON = {
  play: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M4 17.3V20h2.7l8-8-2.7-2.7-8 8ZM19.7 7a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.6 1.6 2.7 2.7L19.7 7Z"/></svg>',
  del: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Z"/></svg>',
};

let state;
let lastTick = Date.now();
let lastHeartbeat = 0;
let gapPending = false;
let view = 'timer';
let lastBadge = null;
let persisted = null;
const filters = { project: '', task: '', from: '', to: '', range: 'all' };

// ---------- Saving ----------

function commit(mutator) {
  try {
    const { state: next, result } = update(mutator);
    state = next;
    render();
    return result;
  } catch (err) {
    if (err instanceof UserError) toast(err.message, 'error');
    else {
      console.error(err);
      toast(`Couldn't save: ${err.message || err}. Your saved data hasn't changed.`, 'error');
      try { state = load(); render(); } catch { /* ignore */ }
    }
    return undefined;
  }
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
    persisted = await navigator.storage?.persisted?.();
  } catch { /* not critical */ }
}

// ---------- Timer actions ----------

function readForm() {
  return { project: cleanName($('projectInput').value), task: cleanName($('taskInput').value) };
}

function showFormError(msg) {
  $('formError').textContent = msg;
  $('formError').hidden = !msg;
}

async function startOrSwitch({ project, task }) {
  if (!project) return showFormError('Enter a project name.');
  if (!task) return showFormError('Enter a task name.');
  showFormError('');
  state = load();
  const a = state.active;

  if (!a) {
    commit((s) => startTimer(s, { project, task }, Date.now()));
    requestPersistence();
    return;
  }
  if (a.project === project && a.task === task) {
    if (!isRunning(a)) togglePause();
    else toast('That task is already running.');
    return;
  }

  const choice = await openDialog({
    title: 'Switch tasks?',
    body: `<p>Only one timer runs at a time.</p>
      <div class="summary"><strong>${esc(a.task)}</strong>${esc(a.project)}<br>${formatDuration(elapsedMs(a))} so far</div>
      <p>Stop and save this session, then start <strong>${esc(task)}</strong>?</p>`,
    actions: [
      { label: 'Cancel', value: null },
      { label: 'Save and switch', value: 'switch', kind: 'primary', focus: true },
    ],
  });
  if (choice !== 'switch') return;
  const saved = commit((s) => {
    const now = Date.now();
    const sess = s.active ? stopTimer(s, now) : null;
    startTimer(s, { project, task }, now);
    return sess;
  });
  if (saved) toast(`Saved ${formatDuration(saved.durationMs)} on "${saved.task}". Now timing "${task}".`);
}

function togglePause() {
  const a = state.active;
  if (!a) return;
  if (isRunning(a)) commit((s) => pauseTimer(s, Date.now()));
  else commit((s) => resumeTimer(s, Date.now()));
}

async function requestStop() {
  state = load();
  const a = state.active;
  if (!a) return;
  const choice = await openDialog({
    title: 'Stop and save this session?',
    body: `<div class="summary"><strong>${esc(a.task)}</strong>${esc(a.project)}</div>
      <p><span class="big-num">${formatDuration(elapsedMs(a))}</span><br>
      <span class="hint">Started ${esc(relativeDay(a.segments[0].start))} at ${esc(formatTime(a.segments[0].start))}. You can edit the duration later in History.</span></p>`,
    actions: [
      { label: 'Discard session', value: 'discard', kind: 'danger-link', left: true },
      { label: 'Keep timing', value: null },
      { label: 'Save session', value: 'save', kind: 'primary', focus: true },
    ],
  });
  if (choice === 'save') {
    const sess = commit((s) => (s.active && s.active.id === a.id ? stopTimer(s, Date.now()) : null));
    if (sess) toast(`Saved ${formatDuration(sess.durationMs)} on "${sess.task}".`);
  } else if (choice === 'discard') {
    const sure = await openDialog({
      title: 'Discard this session?',
      body: `<p>The ${formatDuration(elapsedMs(a))} tracked on <strong>${esc(a.task)}</strong> won't be saved. This can't be undone.</p>`,
      actions: [
        { label: 'Keep it', value: null, focus: true },
        { label: 'Discard', value: 'yes', kind: 'danger-solid' },
      ],
    });
    if (sure === 'yes') {
      commit((s) => { if (s.active && s.active.id === a.id) discardTimer(s); });
      toast('Session discarded.');
    }
  }
}

// ---------- Forgotten-timer protection ----------

/** The app wasn't ticking from gapStart to now while the timer ran. Ask what to do. */
async function handleGap(gapStart, now) {
  if (gapPending) return;
  const a = state.active;
  if (!a || !isRunning(a)) return;
  gapPending = true;
  const gapMs = now - gapStart;
  const choice = await openDialog({
    title: 'Were you working the whole time?',
    body: `<div class="summary"><strong>${esc(a.task)}</strong>${esc(a.project)}</div>
      <p>The timer kept running from <strong>${esc(relativeDay(gapStart))}, ${esc(formatTime(gapStart))}</strong>
      to now (${formatDuration(gapMs)}) while this app was closed, asleep, or in the background.</p>
      <p class="hint">Total if you keep it: ${formatDuration(elapsedMs(a, now))}. Without that time: ${formatDuration(elapsedMs(a, gapStart))}.</p>`,
    actions: [
      { label: `Stop at ${formatTime(gapStart)} and save`, value: 'stopAt', kind: 'primary' },
      { label: 'Remove that time, keep timing', value: 'trim' },
      { label: 'Yes, keep all the time', value: 'keep', focus: true },
    ],
    stacked: true,
  });
  gapPending = false;
  const id = a.id;
  if (choice === 'stopAt') {
    const sess = commit((s) => (s.active?.id === id ? stopTimer(s, Date.now(), gapStart) : null));
    if (sess) toast(`Saved ${formatDuration(sess.durationMs)} on "${sess.task}", ending at ${formatTime(gapStart)}.`);
  } else if (choice === 'trim') {
    commit((s) => { if (s.active?.id === id) removeGap(s, gapStart, Date.now()); });
    toast(`Removed ${formatDuration(gapMs)}. Timer still running.`);
  } else {
    commit((s) => markSeen(s, Date.now()));
  }
  lastTick = Date.now();
}

function maybeRemind(now) {
  const a = state.active;
  const mins = state.settings.reminderMinutes;
  if (!a || !isRunning(a) || !mins || gapPending) return;
  if (now - a.remindFrom < mins * MIN) return;
  const fired = commit((s) => {
    const x = s.active;
    if (!x || x.id !== a.id || !isRunning(x) || now - x.remindFrom < mins * MIN) return false;
    x.remindFrom = now;
    x.reminderDue = true;
    return true;
  });
  if (fired) {
    notify(`Still working on "${a.task}"?`, `Timer running for ${formatDuration(elapsedMs(state.active, now))} (${a.project}). Pause or stop it if you're done.`);
  }
}

async function notify(title, body) {
  if (!state.settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = {
    body, tag: 'tasktimer-reminder', renotify: true, requireInteraction: true,
    icon: 'icons/icon-192.png',
    actions: [{ action: 'pause', title: 'Pause' }, { action: 'stop', title: 'Stop' }],
  };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) await reg.showNotification(title, opts);
    else { delete opts.actions; new Notification(title, opts); }
  } catch (err) { console.warn('Notification failed', err); }
}

function heartbeat(now = Date.now()) {
  lastHeartbeat = now;
  if (!state.active || !isRunning(state.active) || gapPending) return;
  try {
    const { state: next } = update((s) => markSeen(s, now));
    state = next;
  } catch { /* a missed heartbeat only makes gap detection less precise */ }
}

function tick() {
  const now = Date.now();
  const sinceLast = now - lastTick;
  const prev = lastTick;
  lastTick = now;
  const a = state.active;
  if (a && isRunning(a) && sinceLast > GAP_MS) {
    handleGap(Math.max(prev, a.lastSeenAt || 0), now); // PC slept while the app was open
  }
  renderClock(now);
  maybeRemind(now);
  if (now - lastHeartbeat >= HEARTBEAT_MS) heartbeat(now);
}

// Update the screen right as each displayed second changes, so the clock never lags.
let tickTimer = null;
function scheduleTick() {
  clearTimeout(tickTimer);
  const a = state.active;
  const delay = isRunning(a) ? 1000 - (elapsedMs(a) % 1000) + 10 : 1000;
  tickTimer = setTimeout(() => {
    try { tick(); } finally { scheduleTick(); }
  }, delay);
}

// ---------- Rendering ----------

function render() {
  renderTimer();
  renderRecent();
  renderDatalists();
  if (view === 'history') renderHistory();
  applyTheme();
  updateBadge();
  if (tickTimer !== null) scheduleTick();
}

function renderTimer() {
  const a = state.active;
  const running = isRunning(a);
  const status = !a ? 'idle' : running ? 'running' : 'paused';
  document.body.dataset.status = status;
  $('statusText').textContent = { idle: 'Not running', running: 'Running', paused: 'Paused' }[status];
  $('currentTask').hidden = !a;
  if (a) { $('curTask').textContent = a.task; $('curProject').textContent = a.project; }
  $('startBtn').hidden = !!a;
  $('pauseBtn').hidden = !a;
  $('stopBtn').hidden = !a;
  $('pauseBtn').textContent = running ? 'Pause' : 'Resume';
  $('pauseBtn').classList.toggle('primary', !!a && !running);
  $('reminderBanner').hidden = !(a && running && a.reminderDue);
  updateSwitchBtn();
  renderClock();
}

function todayTotal(now) {
  const today = dayKey(now);
  let total = state.sessions.reduce((t, s) => (dayKey(s.start) === today ? t + s.durationMs : t), 0);
  if (state.active) total += elapsedMs(state.active, now);
  return total;
}

function renderClock(now = Date.now()) {
  const a = state.active;
  const ms = elapsedMs(a, now);
  $('clock').textContent = formatClock(ms);
  $('todayTotal').textContent = formatDuration(todayTotal(now));

  if (!a) $('timerMeta').textContent = 'Enter a project and task, then press Start.';
  else {
    const started = `Started ${relativeDay(a.segments[0].start, now).toLowerCase()} at ${formatTime(a.segments[0].start)}`;
    const last = a.segments[a.segments.length - 1];
    $('timerMeta').textContent = isRunning(a) ? started : `Paused at ${formatTime(last.end)}. ${started}.`;
  }
  if (a && a.reminderDue) {
    $('reminderText').textContent = `Still working on "${a.task}"? This timer has been running for ${formatDuration(ms)}.`;
  }

  // Window title shows on the Windows taskbar, so the timer is visible even when minimized.
  if (!a) document.title = 'Task Timer';
  else if (isRunning(a)) document.title = `▶ ${formatDuration(ms)} | ${a.task}`;
  else document.title = `❚❚ Paused | ${a.task}`;
}

function updateBadge() {
  const running = isRunning(state.active);
  if (running === lastBadge || !('setAppBadge' in navigator)) return;
  lastBadge = running;
  // Shows a dot on the installed app's taskbar icon while timing.
  (running ? navigator.setAppBadge() : navigator.clearAppBadge()).catch(() => {});
}

function updateSwitchBtn() {
  const a = state.active;
  const { project, task } = readForm();
  $('switchBtn').hidden = !(a && project && task && (project !== a.project || task !== a.task));
}

function sessionItem(s, { withEdit }) {
  const when = `${relativeDay(s.start)}, ${formatTime(s.start)} to ${formatTime(s.end)}`;
  return `<li class="session">
    <div class="s-main">
      <div class="s-task">${esc(s.task)}</div>
      <div class="s-sub">${esc(s.project)}</div>
      <div class="s-sub">${esc(when)}</div>
    </div>
    <span class="s-dur">${formatDuration(s.durationMs)}${s.edited ? '<span class="s-edited" title="Duration edited by hand">edited</span>' : ''}</span>
    <span class="s-actions">
      <button type="button" class="icon-btn" data-act="start" data-id="${esc(s.id)}" title="Start this task again" aria-label="Start ${esc(s.task)} again">${ICON.play}</button>
      ${withEdit ? `<button type="button" class="icon-btn" data-act="edit" data-id="${esc(s.id)}" title="Edit" aria-label="Edit session">${ICON.edit}</button>
      <button type="button" class="icon-btn" data-act="delete" data-id="${esc(s.id)}" title="Delete" aria-label="Delete session">${ICON.del}</button>` : ''}
    </span>
  </li>`;
}

function sortedSessions() {
  return [...state.sessions].sort((a, b) => b.start - a.start);
}

function renderRecent() {
  const recent = sortedSessions().slice(0, 6);
  $('recentList').innerHTML = recent.length
    ? recent.map((s) => sessionItem(s, { withEdit: true })).join('')
    : '<li class="empty">No sessions yet. Your finished sessions will show up here.</li>';
}

function uniqueBy(list, fn) {
  return [...new Set(list.map(fn))];
}

function renderDatalists() {
  const sorted = sortedSessions();
  const projects = uniqueBy(sorted, (s) => s.project);
  $('projectList').innerHTML = projects.map((p) => `<option value="${esc(p)}">`).join('');
  const proj = cleanName($('projectInput').value);
  const tasks = uniqueBy(sorted.filter((s) => !proj || s.project === proj), (s) => s.task);
  $('taskList').innerHTML = tasks.map((t) => `<option value="${esc(t)}">`).join('');
}

// ---------- History ----------

function filtered() {
  return sortedSessions().filter((s) => {
    const k = dayKey(s.start);
    return (!filters.project || s.project === filters.project)
      && (!filters.task || s.task === filters.task)
      && (!filters.from || k >= filters.from)
      && (!filters.to || k <= filters.to);
  });
}

function fillSelect(sel, values, current, allLabel) {
  sel.innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}"${v === current ? ' selected' : ''}>${esc(v)}</option>`).join('');
}

function renderHistory() {
  const all = sortedSessions();
  const projects = uniqueBy(all, (s) => s.project).sort((a, b) => a.localeCompare(b));
  if (filters.project && !projects.includes(filters.project)) filters.project = '';
  const tasks = uniqueBy(all.filter((s) => !filters.project || s.project === filters.project), (s) => s.task)
    .sort((a, b) => a.localeCompare(b));
  if (filters.task && !tasks.includes(filters.task)) filters.task = '';
  fillSelect($('fProject'), projects, filters.project, 'All projects');
  fillSelect($('fTask'), tasks, filters.task, 'All tasks');
  $('fFrom').value = filters.from;
  $('fTo').value = filters.to;
  document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === filters.range)));

  const list = filtered();
  const grand = list.reduce((t, s) => t + s.durationMs, 0);
  $('histTotal').textContent = list.length ? `${formatDuration(grand)} in ${list.length} session${list.length === 1 ? '' : 's'}` : '';

  // Totals per project, with each task underneath
  const byProject = new Map();
  for (const s of list) {
    if (!byProject.has(s.project)) byProject.set(s.project, { total: 0, tasks: new Map() });
    const p = byProject.get(s.project);
    p.total += s.durationMs;
    p.tasks.set(s.task, (p.tasks.get(s.task) || 0) + s.durationMs);
  }
  $('totals').innerHTML = list.length
    ? `<table class="totals"><tbody>${[...byProject].sort((a, b) => b[1].total - a[1].total).map(([name, p]) =>
        `<tr class="proj"><td>${esc(name)}</td><td>${formatDuration(p.total)}</td></tr>` +
        [...p.tasks].sort((a, b) => b[1] - a[1]).map(([t, ms]) =>
          `<tr class="task"><td>${esc(t)}</td><td>${formatDuration(ms)}</td></tr>`).join('')
      ).join('')}</tbody></table>`
    : '<p class="empty">No sessions match these filters.</p>';

  // Sessions grouped by day, with a daily total
  const byDay = new Map();
  for (const s of list) {
    const k = dayKey(s.start);
    if (!byDay.has(k)) byDay.set(k, []);
    byDay.get(k).push(s);
  }
  $('histList').innerHTML = list.length
    ? [...byDay].map(([, items]) => `<div class="day">
        <div class="day-head"><span>${esc(formatDate(items[0].start))}</span><span>${formatDuration(items.reduce((t, s) => t + s.durationMs, 0))}</span></div>
        <ul class="sessions">${items.map((s) => sessionItem(s, { withEdit: true })).join('')}</ul></div>`).join('')
    : '<p class="empty">Nothing here yet.</p>';
}

function setRange(range) {
  const now = Date.now();
  filters.range = range;
  filters.to = range === 'all' ? '' : dayKey(now);
  filters.from = { today: dayKey(now), week: weekStartKey(now), month: monthStartKey(now), all: '' }[range];
  renderHistory();
}

function exportCsv() {
  const list = filtered();
  if (!list.length) return toast('No sessions to export with these filters.');
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  const rows = [['Date', 'Project', 'Task', 'Start', 'End', 'Duration', 'Hours', 'Edited']];
  for (const s of [...list].reverse()) {
    rows.push([dayKey(s.start), s.project, s.task, formatTime(s.start), formatTime(s.end),
      formatDuration(s.durationMs), decimalHours(s.durationMs), s.edited ? 'yes' : '']);
  }
  download(`task-timer-${dayKey(Date.now())}.csv`, '\ufeff' + rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
}

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------- Session edit / delete / restart ----------

async function onSessionAction(act, id) {
  const sess = state.sessions.find((s) => s.id === id);
  if (!sess) return;
  if (act === 'start') {
    $('projectInput').value = sess.project;
    $('taskInput').value = sess.task;
    if (view !== 'timer') showView('timer');
    return startOrSwitch({ project: sess.project, task: sess.task });
  }
  if (act === 'delete') {
    const ok = await openDialog({
      title: 'Delete this session?',
      body: `<div class="summary"><strong>${esc(sess.task)}</strong>${esc(sess.project)}<br>${esc(formatDate(sess.start))}, ${formatDuration(sess.durationMs)}</div><p>This can't be undone.</p>`,
      actions: [{ label: 'Cancel', value: null, focus: true }, { label: 'Delete session', value: 'yes', kind: 'danger-solid' }],
    });
    if (ok === 'yes' && commit((s) => deleteSession(s, id))) toast('Session deleted.');
    return;
  }
  if (act === 'edit') return editDialog(sess);
}

async function editDialog(sess) {
  const totalMin = Math.floor(sess.durationMs / MIN);
  const origH = Math.floor(totalMin / 60);
  const origM = totalMin % 60;
  const body = document.createElement('div');
  body.className = 'form-grid';
  body.innerHTML = `
    <label class="field"><span>Project</span><input name="project" maxlength="100" value="${esc(sess.project)}"></label>
    <label class="field"><span>Task</span><input name="task" maxlength="100" value="${esc(sess.task)}"></label>
    <div class="row">
      <label class="field"><span>Hours</span><input name="h" type="number" min="0" max="168" step="1" value="${origH}"></label>
      <label class="field"><span>Minutes</span><input name="m" type="number" min="0" max="59" step="1" value="${origM}"></label>
    </div>
    <p class="hint">Recorded ${esc(formatDate(sess.start))}, ${esc(formatTime(sess.start))}–${esc(formatTime(sess.end))}.</p>
    <p class="form-error" hidden></p>`;
  let changes;
  const result = await openDialog({
    title: 'Edit session',
    body,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save changes', value: 'save', kind: 'primary' }],
    onAction(value) {
      if (value !== 'save') return true;
      const f = (n) => body.querySelector(`[name="${n}"]`).value;
      const project = cleanName(f('project'));
      const task = cleanName(f('task'));
      const h = Number(f('h') || 0);
      const m = Number(f('m') || 0);
      let err = '';
      if (!project || !task) err = 'Project and task are required.';
      else if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || h > 168 || m < 0 || m > 59) err = 'Use whole numbers: hours 0–168, minutes 0–59.';
      else if (h === 0 && m === 0 && (origH || origM)) err = 'Duration must be at least 1 minute. To remove the session, delete it instead.';
      const errEl = body.querySelector('.form-error');
      errEl.textContent = err;
      errEl.hidden = !err;
      if (err) return false;
      const durationMs = h === origH && m === origM ? sess.durationMs : (h * 60 + m) * MIN;
      changes = { project, task, durationMs };
      return true;
    },
  });
  if (result === 'save' && changes) {
    if (commit((s) => { editSession(s, sess.id, changes); return true; })) toast('Session updated.');
  }
}

// ---------- Settings ----------

async function openSettings() {
  if (navigator.storage?.persisted) { try { persisted = await navigator.storage.persisted(); } catch { /* ignore */ } }
  const st = state.settings;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const body = document.createElement('div');
  body.innerHTML = `
    <div class="settings-section">
      <h3>Reminders</h3>
      <label class="field"><span>Remind me when a timer has run this many minutes (0 turns reminders off)</span>
        <input name="reminder" type="number" min="0" max="${REMINDER_MAX}" step="5" value="${st.reminderMinutes}"></label>
      <label class="check" style="margin-top:.6rem"><input name="notify" type="checkbox" ${st.notifications && perm === 'granted' ? 'checked' : ''} ${perm === 'unsupported' ? 'disabled' : ''}>
        Also show a Windows notification</label>
      <p class="hint" data-perm>${perm === 'denied' ? 'Notifications are blocked for this app. Open the app menu (⋮) &gt; App info &gt; Settings, and allow Notifications.' : 'The in-app reminder always shows. The notification also reaches you when the app is minimized.'}</p>
    </div>
    <div class="settings-section">
      <h3>Appearance</h3>
      <label class="field"><span>Theme</span>
        <select name="theme">
          <option value="system"${st.theme === 'system' ? ' selected' : ''}>Match Windows</option>
          <option value="light"${st.theme === 'light' ? ' selected' : ''}>Light</option>
          <option value="dark"${st.theme === 'dark' ? ' selected' : ''}>Dark</option>
        </select></label>
    </div>
    <div class="settings-section">
      <h3>Your data</h3>
      <p class="hint">${state.sessions.length} sessions saved on this computer, in this Chrome profile only. ${persisted ? 'Chrome has marked this storage as persistent.' : 'Chrome may clear it if you clear browsing data for this site.'}</p>
      <div class="btn-row">
        <button type="button" class="btn small" data-backup>Download backup</button>
        <button type="button" class="btn small" data-restore>Restore from backup</button>
        <input type="file" accept="application/json,.json" data-file hidden>
      </div>
      <p class="hint">Restoring adds missing sessions from the file. It never deletes anything.</p>
    </div>
    <p class="form-error" hidden></p>`;

  body.querySelector('[data-backup]').onclick = () => {
    download(`task-timer-backup-${dayKey(Date.now())}.json`,
      JSON.stringify({ app: 'task-timer', exportedAt: new Date().toISOString(), data: load() }, null, 2), 'application/json');
  };
  const fileInput = body.querySelector('[data-file]');
  body.querySelector('[data-restore]').onclick = () => fileInput.click();
  fileInput.onchange = async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const added = commit((s) => mergeBackup(s, data));
      if (added !== undefined) toast(added ? `Added ${added} session${added === 1 ? '' : 's'} from the backup.` : 'Everything in that backup is already here.');
    } catch {
      toast("That file couldn't be read as a Task Timer backup.", 'error');
    }
  };
  const notifyBox = body.querySelector('[name="notify"]');
  notifyBox.onchange = async () => {
    if (!notifyBox.checked || Notification.permission === 'granted') return;
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      notifyBox.checked = false;
      body.querySelector('[data-perm]').textContent = 'Notifications are blocked. Open the app menu (⋮) > App info > Settings, and allow Notifications.';
    }
  };

  let next;
  const choice = await openDialog({
    title: 'Settings',
    body,
    actions: [{ label: 'Cancel', value: null }, { label: 'Save settings', value: 'save', kind: 'primary' }],
    onAction(value) {
      if (value !== 'save') return true;
      const raw = body.querySelector('[name="reminder"]').value.trim();
      const mins = Number(raw);
      const errEl = body.querySelector('.form-error');
      if (raw === '' || !Number.isInteger(mins) || (mins !== 0 && (mins < REMINDER_MIN || mins > REMINDER_MAX))) {
        errEl.textContent = `Enter 0, or a whole number of minutes from ${REMINDER_MIN} to ${REMINDER_MAX}.`;
        errEl.hidden = false;
        return false;
      }
      next = { reminderMinutes: mins, notifications: notifyBox.checked, theme: body.querySelector('[name="theme"]').value };
      return true;
    },
  });
  if (choice === 'save' && next) {
    commit((s) => { Object.assign(s.settings, next); });
    toast('Settings saved.');
  }
}

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
}

// ---------- Dialog + toast helpers ----------

/** Modal dialog. Resolves with the chosen action's value, or null on Esc. */
function openDialog({ title, body, actions, onAction, stacked }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    const h = document.createElement('h2');
    h.textContent = title;
    const content = document.createElement('div');
    content.className = 'dialog-body';
    if (typeof body === 'string') content.innerHTML = body; else content.append(body);
    const footer = document.createElement('div');
    footer.className = 'dialog-actions' + (stacked ? ' stacked' : '');
    let focusBtn;
    const close = (v) => { dlg.close(); dlg.remove(); resolve(v); };
    for (const a of actions) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label;
      b.className = 'btn' + (a.kind === 'primary' ? ' primary' : a.kind === 'danger-solid' ? ' danger-solid' : a.kind === 'danger-link' ? ' danger' : '') + (a.left ? ' left' : '');
      b.dataset.value = a.value ?? '';
      b.onclick = () => { if (onAction && onAction(a.value) === false) return; close(a.value); };
      if (a.focus) focusBtn = b;
      footer.append(b);
    }
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(null); });
    dlg.append(h, content, footer);
    document.body.append(dlg);
    dlg.showModal();
    (focusBtn || footer.lastElementChild).focus();
  });
}

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 4000);
}

// ---------- Views ----------

function showView(v) {
  view = v;
  $('view-timer').hidden = v !== 'timer';
  $('view-history').hidden = v !== 'history';
  document.querySelectorAll('.tab').forEach((t) => {
    if (t.dataset.view === v) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current');
  });
  if (v === 'history') renderHistory();
}

// ---------- Wiring ----------

function wire() {
  $('taskForm').addEventListener('submit', (e) => { e.preventDefault(); startOrSwitch(readForm()); });
  $('pauseBtn').addEventListener('click', togglePause);
  $('stopBtn').addEventListener('click', requestStop);
  $('settingsBtn').addEventListener('click', openSettings);
  $('projectInput').addEventListener('input', () => { renderDatalists(); updateSwitchBtn(); showFormError(''); });
  $('taskInput').addEventListener('input', () => { updateSwitchBtn(); showFormError(''); });

  $('reminderBanner').addEventListener('click', (e) => {
    const act = e.target.closest('[data-reminder]')?.dataset.reminder;
    if (act === 'ack') commit((s) => { if (s.active) { s.active.reminderDue = false; s.active.remindFrom = Date.now(); } });
    if (act === 'pause') togglePause();
    if (act === 'stop') requestStop();
  });

  document.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (tab) return showView(tab.dataset.view);
    const go = e.target.closest('[data-goto]');
    if (go) return showView(go.dataset.goto);
    const btn = e.target.closest('[data-act]');
    if (btn) return onSessionAction(btn.dataset.act, btn.dataset.id);
    const range = e.target.closest('[data-range]');
    if (range) return setRange(range.dataset.range);
  });

  $('fProject').addEventListener('change', (e) => { filters.project = e.target.value; filters.task = ''; renderHistory(); });
  $('fTask').addEventListener('change', (e) => { filters.task = e.target.value; renderHistory(); });
  $('fFrom').addEventListener('change', (e) => { filters.from = e.target.value; filters.range = ''; renderHistory(); });
  $('fTo').addEventListener('change', (e) => { filters.to = e.target.value; filters.range = ''; renderHistory(); });
  $('exportCsv').addEventListener('click', exportCsv);

  // Another window changed the data: pick it up.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    try { state = load(); render(); } catch { /* ignore */ }
  });

  // Save "last seen" whenever the app is hidden or closed.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') heartbeat(); else tick();
  });
  window.addEventListener('pagehide', () => heartbeat());
  // Chrome may freeze a background window. That's not you walking away, so don't ask about it.
  document.addEventListener('freeze', () => heartbeat());
  document.addEventListener('resume', () => { lastTick = Date.now(); });

  // Buttons on the Windows notification.
  navigator.serviceWorker?.addEventListener('message', (e) => {
    if (e.data?.type === 'notification-action') handleExternalAction(e.data.action);
  });
}

function handleExternalAction(action) {
  state = load();
  render();
  if (action === 'pause' && isRunning(state.active)) { togglePause(); toast('Timer paused.'); }
  if (action === 'stop' && state.active) requestStop();
}

function init() {
  try {
    state = load();
  } catch (err) {
    $('fatal').textContent = "This app can't access browser storage, so it can't save your time. Check that cookies and site data aren't blocked for this site in Chrome settings.";
    $('fatal').hidden = false;
    console.error(err);
    return;
  }
  wire();

  const a = state.active;
  if (a) {
    $('projectInput').value = a.project;
    $('taskInput').value = a.task;
  }
  render();
  if (loadWarning) toast(loadWarning, 'error');

  const now = Date.now();
  if (a && isRunning(a)) {
    const lastSeen = a.lastSeenAt || a.segments[a.segments.length - 1].start;
    if (now - lastSeen > GAP_MS) handleGap(lastSeen, now);
    else toast('Your running timer was restored.');
  } else if (a) {
    toast(`You have a paused session: "${a.task}". Resume or stop it when you're ready.`);
  }

  const params = new URLSearchParams(location.search);
  const action = params.get('action');
  if (action) {
    history.replaceState(null, '', location.pathname);
    handleExternalAction(action);
  }

  heartbeat(now);
  lastTick = now;
  scheduleTick();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline support unavailable:', err));
  }
  if (state.sessions.length || state.active) requestPersistence();
}

window.addEventListener('unhandledrejection', (e) => { console.error(e.reason); });
init();
