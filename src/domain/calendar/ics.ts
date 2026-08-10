import type { IsoDate, IsoTimestamp } from '../types'
import { addDays, isoWeekday, startOfWeek, WEEK_START_DAY } from '../dates'

/**
 * Plik kalendarza (iCalendar, RFC 5545) z cyklicznym przypomnieniem o pomiarach.
 *
 * Dlaczego kalendarz, a nie powiadomienie w aplikacji: PWA bez serwera nie umie
 * obudzić się o dziewiątej w sobotę. `Notification Triggers API` nie weszło do
 * przeglądarek, a Web Push wymaga serwera z kluczami VAPID — decyzja z v1, patrz
 * README. Kalendarz telefonu robi dokładnie to, czego tu brakuje, i robi to
 * niezawodnie także wtedy, gdy aplikacja jest zamknięta.
 *
 * Plik pobiera się RAZ i importuje do kalendarza. To nie jest synchronizacja:
 * zmiana w aplikacji nie zmieni już zaimportowanego wydarzenia. Za to `UID`
 * zależy od daty startu, więc ponowny import tej samej serii ją NADPISZE,
 * a nie zdubluje.
 */

/** Godzina przypomnienia — sobota rano, przed śniadaniem. */
export const MEASUREMENT_HOUR = 9
/** Ile tygodni obejmuje seria. */
export const MEASUREMENT_WEEKS = 12

export interface MeasurementReminderInput {
  /** Data, od której liczymy najbliższą sobotę. */
  today: IsoDate
  /** Znacznik czasu wpisywany w `DTSTAMP`. Podawany z zewnątrz — domena nie czyta zegara. */
  now: IsoTimestamp
  weeks?: number
  hour?: number
}

export interface MeasurementReminder {
  /** Treść pliku `.ics`. */
  content: string
  /** Pierwsza sobota serii — do pokazania w interfejsie. */
  firstDate: IsoDate
  /** Ostatnia sobota serii. */
  lastDate: IsoDate
  weeks: number
}

/**
 * Najbliższa sobota — dzisiejsza, gdy dziś jest sobota.
 *
 * `startOfWeek` daje sobotę tygodnia BIEŻĄCEGO, która bywa w przeszłości (do
 * sześciu dni wstecz). Przypomnienie w przeszłości nie ma sensu, więc gdy
 * sobota już minęła, bierzemy następną.
 */
export function nextSaturday(today: IsoDate): IsoDate {
  if (isoWeekday(today) === WEEK_START_DAY) return today
  return addDays(startOfWeek(today), 7)
}

/**
 * Buduje serię cotygodniowych przypomnień o pomiarach.
 *
 * Jedno wydarzenie z regułą powtarzania (`RRULE`), nie dwanaście osobnych:
 * kalendarz pokazuje wtedy jedną pozycję do skasowania, a nie dwanaście.
 *
 * Czas jest ZMIENNOPRZECINKOWY — bez `Z` i bez `TZID`. To celowe: „sobota 9:00"
 * ma znaczyć dziewiątą tam, gdzie użytkownik jest, także po zmianie czasu
 * na letni i po wyjeździe do innej strefy. Zapis z UTC przesunąłby godzinę
 * o strefę, a `TZID` wymagałby dołączenia definicji `VTIMEZONE`.
 */
export function measurementReminderIcs(input: MeasurementReminderInput): MeasurementReminder {
  const weeks = Math.max(1, Math.floor(input.weeks ?? MEASUREMENT_WEEKS))
  const hour = clampHour(input.hour ?? MEASUREMENT_HOUR)

  const firstDate = nextSaturday(input.today)
  const lastDate = addDays(firstDate, (weeks - 1) * 7)

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FITKonrad//Pomiary//PL',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:pomiary-${firstDate}@fitkonrad`,
    `DTSTAMP:${stampFor(input.now)}`,
    `DTSTART:${dateTime(firstDate, hour)}`,
    `DTEND:${dateTime(firstDate, hour + 1)}`,
    `RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=${weeks}`,
    'SUMMARY:Podaj miary do aplikacji',
    'DESCRIPTION:' +
      escapeText(
        'Waga i obwody (talia, biodra, klatka, udo, ramię) — rano, przed śniadaniem, ' +
          'zawsze w tych samych warunkach. Wpisz w FITKonradzie: zakładka Dziś albo ' +
          'Profil → „Wpisz wagę i pomiary".',
      ),
    'LOCATION:FITKonrad',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Podaj miary do aplikacji',
    // Przypomnienie w momencie wydarzenia — pomiar robi się od razu, nie planuje.
    'TRIGGER:PT0M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ]

  // RFC 5545 wymaga CRLF i zawijania długich linii — patrz `fold`.
  return {
    content: lines.map(fold).join('\r\n') + '\r\n',
    firstDate,
    lastDate,
    weeks,
  }
}

/** `2026-08-01` + 9 → `20260801T090000` (czas zmiennoprzecinkowy). */
function dateTime(date: IsoDate, hour: number): string {
  return `${date.replaceAll('-', '')}T${String(clampHour(hour)).padStart(2, '0')}0000`
}

/** `2026-07-30T22:15:00.000Z` → `20260730T221500Z`. */
function stampFor(now: IsoTimestamp): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(now)
  if (!match) throw new RangeError(`Nieprawidłowy znacznik czasu: ${now}`)
  const [, y, m, d, hh, mm, ss] = match
  return `${y}${m}${d}T${hh}${mm}${ss}Z`
}

function clampHour(hour: number): number {
  return Math.min(23, Math.max(0, Math.round(hour)))
}

/**
 * Escapowanie tekstu zgodnie z RFC 5545: `\`, `;`, `,` i nowa linia.
 *
 * Bez tego przecinek w opisie („talia, biodra") rozdziela wartości i kalendarz
 * pokazuje obciętą treść albo odrzuca plik.
 */
export function escapeText(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll(';', '\\;')
    .replaceAll(',', '\\,')
    .replaceAll('\n', '\\n')
}

/**
 * Zawijanie linii do 75 oktetów, kontynuacja po spacji.
 *
 * Liczą się OKTETY, nie znaki — polskie znaki w UTF-8 zajmują dwa bajty, więc
 * liczenie znaków dałoby linie dłuższe niż dopuszcza norma. Część kalendarzy
 * (m.in. iOS) odrzuca takie pliki bez komunikatu.
 */
export function fold(line: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(line).length <= 75) return line

  const out: string[] = []
  let current = ''
  let bytes = 0

  for (const char of line) {
    const size = encoder.encode(char).length
    // Pierwsza linia ma 75 oktetów, kolejne 74 + wiodąca spacja.
    const limit = out.length === 0 ? 75 : 74
    if (bytes + size > limit) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += char
    bytes += size
  }
  if (current) out.push(current)

  return out.map((part, index) => (index === 0 ? part : ` ${part}`)).join('\r\n')
}
