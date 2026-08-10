import type { IsoDate, Weekday } from './types'

const MS_PER_DAY = 86_400_000

/** Parsuje `YYYY-MM-DD` jako południe UTC — odporne na strefy i czas letni. */
export function parseIsoDate(date: IsoDate): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  if (!match) throw new RangeError(`Nieprawidłowa data: ${date}`)
  const [, y, m, d] = match
  return Date.UTC(Number(y), Number(m) - 1, Number(d), 12)
}

export function toIsoDate(value: Date | number): IsoDate {
  const d = typeof value === 'number' ? new Date(value) : value
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function todayIso(now = new Date()): IsoDate {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

export function diffDays(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / MS_PER_DAY)
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIsoDate(parseIsoDate(date) + days * MS_PER_DAY)
}

/** ISO-8601: 1 = poniedziałek … 7 = niedziela. */
export function isoWeekday(date: IsoDate): Weekday {
  const jsDay = new Date(parseIsoDate(date)).getUTCDay() // 0 = niedziela
  return (jsDay === 0 ? 7 : jsDay) as Weekday
}

/**
 * Pierwszy dzień tygodnia w tej aplikacji: SOBOTA.
 *
 * Numeracja dni pozostaje ISO (1 = poniedziałek), zmienia się wyłącznie punkt
 * cięcia tygodnia. Tydzień sobotnio-piątkowy jest tu decyzją użytkową, nie
 * kosmetyczną: sobota to dzień pomiarów ciała i dzień, w którym robi się
 * zakupy na kolejne dni, więc lista zakupów, jadłospis i tydzień planu muszą
 * kończyć się razem z tym cyklem. Tydzień ISO rozcinałby zakupy na pół.
 */
export const WEEK_START_DAY: Weekday = 6

/** Początek tygodnia (sobota) zawierającego podaną datę. */
export function startOfWeek(date: IsoDate, weekStartDay: Weekday = WEEK_START_DAY): IsoDate {
  return addDays(date, -weekOrderIndex(isoWeekday(date), weekStartDay))
}

/** Ostatni dzień tygodnia (piątek) zawierającego podaną datę. */
export function endOfWeek(date: IsoDate, weekStartDay: Weekday = WEEK_START_DAY): IsoDate {
  return addDays(startOfWeek(date, weekStartDay), 6)
}

/**
 * Pozycja dnia w tygodniu, 0–6, licząc od `weekStartDay`.
 *
 * Potrzebna wszędzie, gdzie dni trzeba UPORZĄDKOWAĆ albo przeliczyć na
 * przesunięcie od początku tygodnia: sortowanie po `dayOfWeek` dawałoby
 * poniedziałek przed sobotą, czyli kolejność z innego tygodnia.
 */
export function weekOrderIndex(day: Weekday, weekStartDay: Weekday = WEEK_START_DAY): number {
  return (day - weekStartDay + 7) % 7
}

/** Kolejne daty od `from` do `to` włącznie. */
export function dateRange(from: IsoDate, to: IsoDate): IsoDate[] {
  const total = diffDays(from, to)
  if (total < 0) return []
  return Array.from({ length: total + 1 }, (_, i) => addDays(from, i))
}
