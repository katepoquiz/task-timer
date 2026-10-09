// Pure time helpers. No DOM, no storage.

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;

/** True when the active session has an open (running) segment. */
export function isRunning(active) {
  if (!active || !Array.isArray(active.segments) || active.segments.length === 0) return false;
  return active.segments[active.segments.length - 1].end == null;
}

/**
 * Elapsed time is always calculated from saved timestamps, never from a counter,
 * so it stays correct across minimizing, refreshing, closing, and sleep.
 */
export function elapsedMs(active, now = Date.now()) {
  if (!active || !Array.isArray(active.segments)) return 0;
  return active.segments.reduce((total, seg) => {
    const end = seg.end == null ? now : seg.end;
    return total + Math.max(0, end - seg.start); // guards against clock changes
  }, 0);
}

const pad = (n) => String(n).padStart(2, '0');

/** 01:23:45 for the big clock. */
export function formatClock(ms) {
  const total = Math.floor(Math.max(0, ms) / SEC);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 1h 25m, 45m, 30s for lists and totals. */
export function formatDuration(ms) {
  ms = Math.max(0, ms || 0);
  if (ms < MIN) return ms < SEC ? '0m' : `${Math.floor(ms / SEC)}s`;
  const totalMin = Math.floor(ms / MIN);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Decimal hours, for pasting into Zoho or a spreadsheet. */
export function decimalHours(ms) {
  return (Math.max(0, ms) / HOUR).toFixed(2);
}

/** Local calendar date key, YYYY-MM-DD. */
export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(ts) {
  return new Date(ts).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Today", "Yesterday", or a short date. */
export function relativeDay(ts, now = Date.now()) {
  const k = dayKey(ts);
  if (k === dayKey(now)) return 'Today';
  if (k === dayKey(now - 24 * HOUR)) return 'Yesterday';
  return formatDate(ts);
}

/** Day key for the Monday of the week containing ts. */
export function weekStartKey(ts) {
  const d = new Date(ts);
  const offset = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - offset);
  return dayKey(d.getTime());
}

export function monthStartKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
}
