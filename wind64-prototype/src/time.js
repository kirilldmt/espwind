export const MOSCOW = 'Europe/Moscow';
export const HOUR = 3600000;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: MOSCOW, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: MOSCOW, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const validTime = now => Number.isFinite(now) && now >= Date.parse('2020-01-01') && now < Date.parse('2100-01-01');
export const dateInMoscow = (time = Date.now()) => dateFormatter.format(time);
export const timeInMoscow = time => timeFormatter.format(time);
export const hourInMoscow = time => Number(timeInMoscow(time).slice(0, 2));
export const atHour = (date, hour) => Date.parse(`${date}T00:00:00+03:00`) + hour * HOUR;
export function addDays(date, count) { return new Date(Date.parse(`${date}T12:00:00Z`) + count * 24 * HOUR).toISOString().slice(0, 10); }
export const forecastDates = (baseDate = dateInMoscow(), count = 8) => Array.from({ length: count }, (_, i) => addDays(baseDate, i));
export function dateLabel(date, now) {
  if (!date || !validTime(now)) return '--';
  const today = dateInMoscow(now);
  return date === today ? 'СЕГ' : date === addDays(today, 1) ? 'ЗАВ' : `${date.slice(8)}.${date.slice(5, 7)}`;
}
