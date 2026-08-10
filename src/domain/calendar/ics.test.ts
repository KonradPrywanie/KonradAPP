import { describe, expect, it } from 'vitest'
import {
  escapeText,
  fold,
  measurementReminderIcs,
  MEASUREMENT_HOUR,
  MEASUREMENT_WEEKS,
  nextSaturday,
} from './ics'

const NOW = '2026-07-30T22:15:00.000Z'

describe('nextSaturday', () => {
  it('w sobotę zwraca dzisiejszy dzień', () => {
    // 1 sierpnia 2026 to sobota.
    expect(nextSaturday('2026-08-01')).toBe('2026-08-01')
  })

  it('poza sobotą zwraca NAJBLIŻSZĄ, nie tę z bieżącego tygodnia', () => {
    /**
     * `startOfWeek` daje sobotę tygodnia bieżącego, która bywa w przeszłości
     * (tydzień aplikacji zaczyna się w sobotę). Przypomnienie z datą wstecz
     * kalendarz zaimportuje jako serię, której pierwsze wystąpienia już minęły.
     */
    expect(nextSaturday('2026-08-02')).toBe('2026-08-08') // niedziela → następna sobota
    expect(nextSaturday('2026-08-05')).toBe('2026-08-08') // środa
    expect(nextSaturday('2026-08-07')).toBe('2026-08-08') // piątek
  })
})

describe('measurementReminderIcs', () => {
  const reminder = measurementReminderIcs({ today: '2026-08-05', now: NOW })
  const lines = reminder.content.split('\r\n')

  it('buduje poprawny szkielet kalendarza', () => {
    expect(lines[0]).toBe('BEGIN:VCALENDAR')
    expect(lines).toContain('VERSION:2.0')
    expect(lines).toContain('BEGIN:VEVENT')
    expect(lines).toContain('END:VEVENT')
    expect(lines.at(-2)).toBe('END:VCALENDAR')
    // RFC 5545 wymaga CRLF, nie samego LF.
    expect(reminder.content.includes('\r\n')).toBe(true)
    expect(reminder.content.split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(
      true,
    )
  })

  it('KRYTYCZNE: jedno wydarzenie z regułą powtarzania na 12 sobót', () => {
    // Dwanaście osobnych wpisów oznaczałoby dwanaście rzeczy do skasowania.
    expect(lines.filter((line) => line === 'BEGIN:VEVENT')).toHaveLength(1)
    expect(lines).toContain(`RRULE:FREQ=WEEKLY;BYDAY=SA;COUNT=${MEASUREMENT_WEEKS}`)
    expect(reminder.weeks).toBe(12)
    expect(reminder.firstDate).toBe('2026-08-08')
    expect(reminder.lastDate).toBe('2026-10-24') // 11 tygodni później
  })

  it('godzina 9:00–10:00 w czasie LOKALNYM, bez Z i bez TZID', () => {
    /**
     * Czas zmiennoprzecinkowy: „sobota 9:00" ma znaczyć dziewiątą tam, gdzie
     * użytkownik jest — także po zmianie czasu na letni. Zapis z UTC
     * przesunąłby godzinę o strefę.
     */
    expect(lines).toContain('DTSTART:20260808T090000')
    expect(lines).toContain('DTEND:20260808T100000')
    expect(MEASUREMENT_HOUR).toBe(9)
    expect(lines.some((line) => line.startsWith('DTSTART') && line.includes('Z'))).toBe(false)
    expect(lines.some((line) => line.includes('TZID'))).toBe(false)
  })

  it('ma treść, przypomnienie i stabilny identyfikator', () => {
    expect(lines).toContain('SUMMARY:Podaj miary do aplikacji')
    expect(lines).toContain('BEGIN:VALARM')
    expect(lines).toContain('TRIGGER:PT0M')
    // UID zależy od daty startu, więc ponowny import tej samej serii ją nadpisze.
    expect(lines).toContain('UID:pomiary-2026-08-08@fitkonrad')
    expect(lines).toContain('DTSTAMP:20260730T221500Z')
  })

  it('powtórne wywołanie dla tego samego tygodnia daje ten sam plik', () => {
    const again = measurementReminderIcs({ today: '2026-08-07', now: NOW })
    expect(again.content).toBe(reminder.content)
  })

  it('liczba tygodni i godzina są parametrami z sensownymi granicami', () => {
    const short = measurementReminderIcs({ today: '2026-08-01', now: NOW, weeks: 4, hour: 7 })
    expect(short.content).toContain('COUNT=4')
    expect(short.content).toContain('DTSTART:20260801T070000')
    expect(short.lastDate).toBe('2026-08-22')

    // Zero tygodni nie jest serią; 30 to nie godzina.
    expect(measurementReminderIcs({ today: '2026-08-01', now: NOW, weeks: 0 }).weeks).toBe(1)
    expect(
      measurementReminderIcs({ today: '2026-08-01', now: NOW, hour: 30 }).content,
    ).toContain('T230000')
  })

  it('odrzuca nieprawidłowy znacznik czasu, zamiast wpisać śmieci do pliku', () => {
    expect(() => measurementReminderIcs({ today: '2026-08-01', now: 'wczoraj' })).toThrow(
      RangeError,
    )
  })
})

describe('escapeText', () => {
  it('KRYTYCZNE: escapuje przecinek, średnik, ukośnik i nową linię', () => {
    // Bez tego przecinek w „talia, biodra" rozdziela wartości i kalendarz
    // pokazuje obciętą treść albo odrzuca plik.
    expect(escapeText('talia, biodra')).toBe('talia\\, biodra')
    expect(escapeText('a;b')).toBe('a\\;b')
    expect(escapeText('a\\b')).toBe('a\\\\b')
    expect(escapeText('linia\ndruga')).toBe('linia\\ndruga')
  })

  it('opis w pliku ma uciekane przecinki', () => {
    const content = measurementReminderIcs({ today: '2026-08-01', now: NOW }).content
    expect(content).toContain('talia\\, biodra')
  })
})

describe('fold', () => {
  it('krótkiej linii nie rusza', () => {
    expect(fold('SUMMARY:Pomiary')).toBe('SUMMARY:Pomiary')
  })

  it('KRYTYCZNE: liczy OKTETY, nie znaki — polskie litery zajmują dwa bajty', () => {
    /**
     * Przy liczeniu znaków linia z polskimi literami wychodzi dłuższa niż 75
     * oktetów, a część kalendarzy (m.in. iOS) odrzuca taki plik bez komunikatu.
     */
    const line = 'DESCRIPTION:' + 'ą'.repeat(60)
    const folded = fold(line)
    const encoder = new TextEncoder()
    for (const part of folded.split('\r\n')) {
      expect(encoder.encode(part).length).toBeLessThanOrEqual(75)
    }
    // Kontynuacje zaczynają się od spacji — tak wygląda złożona linia w RFC 5545.
    expect(folded.split('\r\n').slice(1).every((part) => part.startsWith(' '))).toBe(true)
  })

  it('złożona linia po usunięciu zawinięć wraca do oryginału', () => {
    const line = 'DESCRIPTION:' + 'a'.repeat(200)
    expect(fold(line).replaceAll('\r\n ', '')).toBe(line)
  })

  it('plik nie ma linii dłuższych niż dopuszcza norma', () => {
    const content = measurementReminderIcs({ today: '2026-08-01', now: NOW }).content
    const encoder = new TextEncoder()
    for (const line of content.split('\r\n')) {
      expect(encoder.encode(line).length, line).toBeLessThanOrEqual(75)
    }
  })
})
