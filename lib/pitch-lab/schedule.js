/**
 * Pitch Lab review calendar — one definition of when the weekly report and the
 * monthly Mandate Review run, shared by pitch-lab-scheduler.js (which decides
 * whether to run) and the dashboard snapshot (which tells the website when the
 * next one is). Keeping both on this module means the date shown can never drift
 * from the date the job actually fires.
 *
 * Pure: a clock in, ISO instants out. All wall-clock times are America/New_York.
 */
import { etDateString } from "../market-calendar.js";

export const WEEKLY_REPORT_ET = Object.freeze({ weekday: 6, hour: 10, minute: 0 }); // Saturday 10:00
export const MANDATE_REVIEW_ET = Object.freeze({ weekday: 6, hour: 11, minute: 0, maxDayOfMonth: 7 }); // first Saturday 11:00

const DAY_MS = 86_400_000;

function etClock(instant) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  return { hour: Number(parts.find((p) => p.type === "hour").value), minute: Number(parts.find((p) => p.type === "minute").value) };
}

/** The instant a YYYY-MM-DD ET date reads hour:minute in New York (EDT or EST). */
export function etInstant(dateStr, hour, minute = 0) {
  const [y, m, d] = dateStr.split("-").map(Number);
  for (const offsetHours of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hour + offsetHours, minute));
    const clock = etClock(candidate);
    if (etDateString(candidate) === dateStr && clock.hour === hour && clock.minute === minute) return candidate;
  }
  throw new RangeError(`no ${hour}:${minute} ET on ${dateStr}`);
}

const weekdayOf = (dateStr) => new Date(`${dateStr}T12:00:00Z`).getUTCDay();
const dayOfMonth = (dateStr) => Number(dateStr.slice(8, 10));
const addDays = (dateStr, days) => new Date(Date.parse(`${dateStr}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** True on the ET date the monthly Mandate Review runs (the month's first Saturday). */
export function isMandateReviewDay(now = new Date()) {
  const date = etDateString(new Date(now));
  return weekdayOf(date) === MANDATE_REVIEW_ET.weekday && dayOfMonth(date) <= MANDATE_REVIEW_ET.maxDayOfMonth;
}

function nextMatching(now, slot, dateOk) {
  const at = new Date(now);
  const today = etDateString(at);
  for (let i = 0; i <= 45; i += 1) {
    const date = addDays(today, i);
    if (weekdayOf(date) !== slot.weekday || !dateOk(date)) continue;
    const instant = etInstant(date, slot.hour, slot.minute);
    if (instant > at) return instant.toISOString();
  }
  throw new RangeError("no matching slot within 45 days");
}

/** Next weekly report run strictly after `now`. */
export function nextWeeklyReportAt(now = new Date()) {
  return nextMatching(now, WEEKLY_REPORT_ET, () => true);
}

/** Next monthly Mandate Review run strictly after `now`. */
export function nextMandateReviewAt(now = new Date()) {
  return nextMatching(now, MANDATE_REVIEW_ET, (date) => dayOfMonth(date) <= MANDATE_REVIEW_ET.maxDayOfMonth);
}
