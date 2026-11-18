// One deadline calculation for bar colours, the overdue icon, tooltips and the overdue filter. Every date is a calendar
// day (local midnight) in the Dynamics user's time zone, already converted by toUserCalendarDate, so comparisons are
// day counts and never depend on the browser's time zone or the time of day.
import type { TaskStatus } from "./fieldMap";

const hasDate = (value:Date|null|undefined):value is Date => value instanceof Date && !Number.isNaN(value.getTime());

// Active rows only: blue until the first threshold, then yellow, orange and dark orange, red once Finish has passed.
export type DeadlineLevel = "scheduled" | "approaching" | "near" | "imminent" | "overdue";
// Days before Finish at which each colour starts; the defaults keep 3.6.0's "due soon within 2 days" boundary.
export type DeadlineThresholds = { approaching:number; near:number; imminent:number };
export type DeadlineState = { level:DeadlineLevel; days:number };
// How Dataverse stores a Date and Time column: user local (converted to the user's zone), date only, or time zone independent.
export type DateBehavior = "userLocal" | "dateOnly" | "timeZoneIndependent";

export const DEFAULT_THRESHOLDS:DeadlineThresholds = { approaching: 2, near: 1, imminent: 0 };
const DAY = 86400000;

const dayNumber = (date:Date) => Math.round(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY);
const fromUtcParts = (date:Date) => new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

// Calendar days from today to the date (negative once it has passed).
export function daysUntil(date:Date, today:Date):number {
  return dayNumber(date) - dayNumber(today);
}

// The user's calendar day for an instant, from the Dynamics time zone offset (minutes east of UTC) for that instant.
export function userCalendarDay(instant:Date, offsetMinutes:number):Date {
  return fromUtcParts(new Date(instant.getTime() + offsetMinutes * 60000));
}

export const browserOffset = (date:Date) => -date.getTimezoneOffset();

// Date Only and time-zone-independent values keep the calendar day Dataverse stored; user-local values are converted to
// the user's Dynamics time zone. Returns local midnight of that day, or null for empty or invalid values.
export function toUserCalendarDate(raw:unknown, behavior:DateBehavior, offsetFor:(instant:Date)=>number = browserOffset):Date|null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (behavior !== "userLocal" && typeof raw === "string") {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
    if (match) return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  }
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw as string | number);
  if (!hasDate(date)) return null;
  if (behavior === "userLocal") return userCalendarDay(date, offsetFor(date));
  if (behavior === "timeZoneIndependent") return fromUtcParts(date);
  // Date Only may arrive as UTC midnight or as local midnight depending on the host.
  const isUtcMidnight = date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  return isUtcMidnight ? fromUtcParts(date) : new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

// Whole numbers of days, each threshold no later than the one before it. Empty values keep the default.
export function resolveThresholds(raw:{ approaching?:unknown; near?:unknown; imminent?:unknown }):{ thresholds:DeadlineThresholds; error?:string } {
  const read = (value:unknown, fallback:number) => value === null || value === undefined || value === "" ? fallback : Number(value);
  const thresholds = {
    approaching: read(raw.approaching, DEFAULT_THRESHOLDS.approaching),
    near: read(raw.near, DEFAULT_THRESHOLDS.near),
    imminent: read(raw.imminent, DEFAULT_THRESHOLDS.imminent)
  };
  const values = [thresholds.approaching, thresholds.near, thresholds.imminent];
  if (values.some(value => !Number.isInteger(value) || value < 0 || value > 365)) {
    return { thresholds: DEFAULT_THRESHOLDS, error: "Deadline colour thresholds must be whole numbers of days from 0 to 365, so the defaults (2, 1, 0) are used." };
  }
  if (thresholds.approaching < thresholds.near || thresholds.near < thresholds.imminent) {
    return { thresholds: DEFAULT_THRESHOLDS, error: "Deadline colour thresholds must not increase (yellow ≥ orange ≥ dark orange), so the defaults (2, 1, 0) are used." };
  }
  return { thresholds };
}

// Only Active rows with a Finish date have a deadline. A task due today is never overdue.
export function deadlineState(status:TaskStatus, due:Date|null, today:Date, thresholds:DeadlineThresholds = DEFAULT_THRESHOLDS):DeadlineState|undefined {
  if (status !== "Active" || !hasDate(due)) return undefined;
  const days = daysUntil(due, today);
  if (days < 0) return { level: "overdue", days: -days };
  if (days <= thresholds.imminent) return { level: "imminent", days };
  if (days <= thresholds.near) return { level: "near", days };
  if (days <= thresholds.approaching) return { level: "approaching", days };
  return { level: "scheduled", days };
}

const dayCount = (days:number) => `${days} day${days === 1 ? "" : "s"}`;

export function deadlineText(state:DeadlineState):string {
  if (state.level === "overdue") return `Overdue by ${dayCount(state.days)}`;
  if (state.days === 0) return "Due today";
  if (state.days === 1) return "Due tomorrow";
  return `Due in ${dayCount(state.days)}`;
}

// The last day that is overdue today (yesterday in the user's zone), for the server-side on-or-before condition.
export function lastOverdueDay(today:Date):string {
  const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
}
