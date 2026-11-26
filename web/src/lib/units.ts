import type { EffortScale, WeightUnit } from './types';

// Weights are always stored in kilograms; the unit only affects display and entry.
const LB_PER_KG = 2.2046226218;

export const fromKg = (unit: WeightUnit, kg: number) => (unit === 'kg' ? kg : kg * LB_PER_KG);
export const toKg = (unit: WeightUnit, value: number) => (unit === 'kg' ? value : value / LB_PER_KG);
export const weightText = (unit: WeightUnit, kg: number) => `${fmtNumber(fromKg(unit, kg))} ${unit}`;

// Effort is stored as RPE. RIR is the same information read from the other end
// (RIR = 10 − RPE), so switching scales never loses data.
export const effortTitle = (scale: EffortScale) => (scale === 'rpe' ? 'RPE' : 'RIR');

/** Values offered in the picker, expressed in the given scale. */
export const effortChoices = (scale: EffortScale) =>
  scale === 'rpe' ? [10, 9.5, 9, 8.5, 8, 7.5, 7, 6.5, 6] : [0, 1, 2, 3, 4, 5];

export const effortValue = (scale: EffortScale, rpe: number) => (scale === 'rpe' ? rpe : Math.max(0, 10 - rpe));
export const rpeFrom = (scale: EffortScale, value: number) => (scale === 'rpe' ? value : 10 - value);
export const effortText = (scale: EffortScale, rpe: number) => fmtNumber(effortValue(scale, rpe), 1);
export const effortLabel = (scale: EffortScale, rpe: number) =>
  scale === 'rpe' ? `RPE ${effortText(scale, rpe)}` : `${effortText(scale, rpe)} RIR`;

/** Number in the browser's locale without trailing zeros: 80, 82.5, 61.25. */
export function fmtNumber(value: number, maxDecimals = 2): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: maxDecimals, useGrouping: false });
}

/** Accepts both "82.5" and "82,5" — the phone's decimal key follows the region setting. */
export function parseDecimal(text: string): number | null {
  const cleaned = text.trim().replace(',', '.');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** "1 workout" / "3 workouts". */
export function fmtCount(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** "1h 05m" / "45m" for finished workouts. */
export function fmtDuration(seconds: number): string {
  const minutes = Math.floor(Math.max(0, Math.round(seconds)) / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${minutes}m`;
}

/** "1:05:32" / "05:32" for the running timer. */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

// The interface is English, so dates are too — whatever language the browser is set to.
const DATE_LOCALE = 'en-GB';
const dayMonthFormat = new Intl.DateTimeFormat(DATE_LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
const dateFormat = new Intl.DateTimeFormat(DATE_LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
const dateTimeFormat = new Intl.DateTimeFormat(DATE_LOCALE, {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const monthYearFormat = new Intl.DateTimeFormat(DATE_LOCALE, { month: 'long', year: 'numeric' });
const shortDateFormat = new Intl.DateTimeFormat(DATE_LOCALE, { day: 'numeric', month: 'short' });

/** "Fri 20 Nov" */
export const fmtDayMonth = (time: number) => dayMonthFormat.format(time).replace(',', '');
/** "20 Nov 2026" */
export const fmtDate = (time: number) => dateFormat.format(time);
/** "20 Nov 2026, 18:10" */
export const fmtDateTime = (time: number) => dateTimeFormat.format(time);
/** "November 2026" */
export const fmtMonthYear = (time: number) => monthYearFormat.format(time);
/** "20 Nov" */
export const fmtShortDate = (time: number) => shortDateFormat.format(time);

/** Local calendar day as the YYYY-MM-DD a date input uses. */
/** How long ago a day was, in calendar days: "today", "yesterday", "5 days ago". */
export function fmtDaysAgo(time: number, now = Date.now()): string {
  const midnight = (value: number) => new Date(value).setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((midnight(now) - midnight(time)) / 86_400_000));
  if (days === 0) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export function toDateInputValue(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Today keeps the current time of day; any other day lands on its noon. */
export function fromDateInputValue(value: string, now = Date.now()): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  if (value === toDateInputValue(now)) return now;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime();
}
