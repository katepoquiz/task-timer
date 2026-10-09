// Storage and data model.
// Every change goes through update(): read the latest saved data, change it, save it.
// Reading fresh each time keeps two open windows from overwriting each other,
// and there is only one "active" slot, so two timers can never run at once.

import { elapsedMs, isRunning } from './time.js';

export const KEY = 'tasktimer:data:v1';
export const NAME_MAX = 100;
export const REMINDER_MIN = 5;
export const REMINDER_MAX = 720;

export class UserError extends Error {}

export let loadWarning = '';

function defaults() {
  return {
    version: 1,
    active: null,
    sessions: [],
    settings: { reminderMinutes: 60, notifications: false, theme: 'system' },
  };
}

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

/** Trim, collapse spaces, cap length. */
export function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

function normalizeActive(a) {
  if (!a || typeof a !== 'object' || !Array.isArray(a.segments) || a.segments.length === 0) return null;
  const segments = a.segments
    .filter((s) => s && Number.isFinite(Number(s.start)))
    .map((s) => ({ start: Number(s.start), end: s.end == null ? null : Number(s.end) }));
  if (!segments.length) return null;
  return {
    id: String(a.id || uid()),
    project: cleanName(a.project) || 'Untitled project',
    task: cleanName(a.task) || 'Untitled task',
    segments,
    remindFrom: Number(a.remindFrom) || segments[segments.length - 1].start,
    reminderDue: !!a.reminderDue,
    lastSeenAt: Number(a.lastSeenAt) || Date.now(),
  };
}

/** Strict check, used for imported backups. Returns null if unusable. */
export function normalizeSession(x) {
  if (!x || typeof x !== 'object') return null;
  const start = Number(x.start);
  const durationMs = Number(x.durationMs);
  if (!Number.isFinite(start) || !Number.isFinite(durationMs) || durationMs < 0) return null;
  const end = Number(x.end);
  return {
    id: String(x.id || uid()),
    project: cleanName(x.project) || 'Untitled project',
    task: cleanName(x.task) || 'Untitled task',
    start,
    end: Number.isFinite(end) ? end : start + durationMs,
    durationMs: Math.round(durationMs),
    edited: !!x.edited,
  };
}

function normalize(data) {
  const base = defaults();
  if (!data || typeof data !== 'object') return base;
  const settings = { ...base.settings, ...(data.settings || {}) };
  const rm = Number(settings.reminderMinutes);
  settings.reminderMinutes = rm === 0 ? 0 : Math.min(REMINDER_MAX, Math.max(REMINDER_MIN, Number.isFinite(rm) ? rm : 60));
  if (!['system', 'light', 'dark'].includes(settings.theme)) settings.theme = 'system';
  return {
    version: 1,
    active: normalizeActive(data.active),
    // Saved sessions are kept as-is (only lightly repaired), never dropped.
    sessions: Array.isArray(data.sessions) ? data.sessions.map((s) => normalizeSession(s) || s) : [],
    settings,
  };
}

export function load() {
  const raw = localStorage.getItem(KEY); // throws if storage is blocked
  if (raw == null) return defaults();
  try {
    return normalize(JSON.parse(raw));
  } catch {
    // Never silently lose data: keep the unreadable copy under a separate key.
    const backupKey = `tasktimer:unreadable:${Date.now()}`;
    try { localStorage.setItem(backupKey, raw); } catch { /* ignore */ }
    loadWarning = `Saved data couldn't be read. A copy was kept in browser storage as "${backupKey}".`;
    return defaults();
  }
}

export function save(state) {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/** Read latest, apply change, save. If the change throws, nothing is saved. */
export function update(mutator) {
  const state = load();
  const result = mutator(state);
  save(state);
  return { state, result };
}

// ---- Timer actions ----

export function startTimer(s, { project, task }, now) {
  project = cleanName(project);
  task = cleanName(task);
  if (!project) throw new UserError('Enter a project name.');
  if (!task) throw new UserError('Enter a task name.');
  if (s.active) throw new UserError('A timer is already active. Stop it before starting another.');
  s.active = {
    id: uid(), project, task,
    segments: [{ start: now, end: null }],
    remindFrom: now, reminderDue: false, lastSeenAt: now,
  };
  return s.active;
}

export function pauseTimer(s, now) {
  const a = s.active;
  if (!a || !isRunning(a)) return false;
  const last = a.segments[a.segments.length - 1];
  last.end = Math.max(now, last.start);
  a.reminderDue = false;
  return true;
}

export function resumeTimer(s, now) {
  const a = s.active;
  if (!a || isRunning(a)) return false;
  a.segments.push({ start: now, end: null });
  a.remindFrom = now;
  a.reminderDue = false;
  a.lastSeenAt = now;
  return true;
}

/** Close the session and add it to history. endAt lets us stop "back in time". */
export function stopTimer(s, now, endAt = now) {
  const a = s.active;
  if (!a) return null;
  const last = a.segments[a.segments.length - 1];
  if (last.end == null) last.end = Math.max(last.start, Math.min(endAt, now));
  const session = {
    id: a.id,
    project: a.project,
    task: a.task,
    start: a.segments[0].start,
    end: last.end,
    durationMs: elapsedMs(a, now),
    edited: false,
  };
  s.sessions.push(session);
  s.active = null;
  return session;
}

export function discardTimer(s) {
  s.active = null;
}

/** Drop the time between gapStart and now, keep the timer running. */
export function removeGap(s, gapStart, now) {
  const a = s.active;
  if (!a || !isRunning(a)) return false;
  const last = a.segments[a.segments.length - 1];
  last.end = Math.max(last.start, Math.min(gapStart, now));
  a.segments.push({ start: now, end: null });
  a.remindFrom = now;
  a.reminderDue = false;
  a.lastSeenAt = now;
  return true;
}

export function markSeen(s, now) {
  if (s.active) s.active.lastSeenAt = now;
}

// ---- History actions ----

export function editSession(s, id, { project, task, durationMs }) {
  const sess = s.sessions.find((x) => x.id === id);
  if (!sess) throw new UserError('That session no longer exists.');
  project = cleanName(project);
  task = cleanName(task);
  if (!project || !task) throw new UserError('Project and task are required.');
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new UserError('Enter a valid duration.');
  if (durationMs !== sess.durationMs) sess.edited = true;
  Object.assign(sess, { project, task, durationMs });
}

export function deleteSession(s, id) {
  const i = s.sessions.findIndex((x) => x.id === id);
  if (i === -1) return false;
  s.sessions.splice(i, 1);
  return true;
}

/** Adds sessions from a backup that aren't already here. Never removes anything. */
export function mergeBackup(s, backup) {
  const src = backup && (backup.data || backup);
  if (!src || !Array.isArray(src.sessions)) throw new UserError("That file isn't a Task Timer backup.");
  const have = new Set(s.sessions.map((x) => x.id));
  let added = 0;
  for (const raw of src.sessions) {
    const sess = normalizeSession(raw);
    if (sess && !have.has(sess.id)) { s.sessions.push(sess); have.add(sess.id); added++; }
  }
  return added;
}
