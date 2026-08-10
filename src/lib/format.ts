import type { PlannedSession, StrengthPayload, SwimPayload, Unit } from '@/domain/types'
import { breadSlices } from '@/domain/shopping/canonical'
import { SESSION_TYPE_LABELS } from './labels'

const FOCUS_LABELS: Record<StrengthPayload['focus'], string> = {
  full: 'całe ciało',
  upper: 'górna część',
  lower: 'dolna część',
  push: 'pchanie',
  pull: 'ciągnięcie',
  legs: 'nogi',
  glutes: 'biodra i pośladki',
}

const STROKE_LABELS: Record<SwimPayload['stroke'], string> = {
  freestyle: 'kraul',
  breaststroke: 'klasyczny',
  backstroke: 'grzbietowy',
  butterfly: 'delfin',
  any: 'dowolny styl',
}

export function formatPace(secPerKm: number): string {
  const minutes = Math.floor(secPerKm / 60)
  const seconds = secPerKm % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function formatDuration(totalSec: number): string {
  const hours = Math.floor(totalSec / 3600)
  const minutes = Math.round((totalSec % 3600) / 60)
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`
}

export function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1).replace('.', ',')} km`
    : `${meters} m`
}

export function sessionTitle(session: PlannedSession): string {
  const payload = session.payload
  switch (payload.kind) {
    case 'strength':
      return `${SESSION_TYPE_LABELS.strength} — ${FOCUS_LABELS[payload.focus]}`
    case 'run':
      return payload.intervals ? 'Bieganie — interwały' : 'Bieganie — spokojne'
    case 'swim':
      return `Pływanie — ${STROKE_LABELS[payload.stroke]}`
    case 'rest':
      return 'Odpoczynek'
  }
}

/** Jednowierszowe podsumowanie sesji do listy i kafla „Dziś". */
export function sessionSummary(session: PlannedSession): string {
  const payload = session.payload
  switch (payload.kind) {
    case 'strength': {
      const sets = payload.exercises.reduce((total, e) => total + e.sets.length, 0)
      return `${payload.exercises.length} ćwiczeń, ${sets} serii, ~${payload.estimatedMinutes} min`
    }
    case 'run': {
      const parts = [
        formatDistance(payload.distanceM),
        `${formatPace(payload.targetPaceSecPerKm)}/km`,
        `strefa ${payload.zone}`,
      ]
      if (payload.intervals) parts.push(payload.intervals)
      return parts.join(' · ')
    }
    case 'swim':
      return `${payload.distanceM} m · ${payload.sets} serii · przerwa ${payload.restSec} s`
    case 'rest':
      return payload.note ?? 'Dzień wolny'
  }
}

/** Liczba z polskim przecinkiem, bez zbędnych zer. */
export function pl(value: number, decimals = 1): string {
  return value.toFixed(decimals).replace(/[.,]?0+$/, '').replace('.', ',')
}

export function signed(value: number, decimals = 1): string {
  return `${value > 0 ? '+' : ''}${pl(value, decimals)}`
}

/** `2026-08-05` → `środa, 5 sierpnia`. */
export function formatDateLong(isoDate: string): string {
  return formatIso(isoDate, { weekday: 'long', day: 'numeric', month: 'long' })
}

/** `2026-08-05` → `5 sie`. Krótko, bo trafia na przyciski przełącznika tygodni. */
export function formatDayMonth(isoDate: string): string {
  return formatIso(isoDate, { day: 'numeric', month: 'short' }).replace(/\.$/, '')
}

/**
 * `2026-08-05` → `śr 5 sie`.
 *
 * Dzień tygodnia z datą, bo przy liście zakupów liczy się „na kiedy", a sama
 * data nie mówi, czy to dzień siłowni, czy weekend.
 */
export function formatWeekday(isoDate: string): string {
  return formatIso(isoDate, { weekday: 'short', day: 'numeric', month: 'short' })
    .replace(/\./g, '')
    .replace(',', '')
}

/**
 * Zakres tygodnia: `1 sie – 7 sie`.
 *
 * Numer tygodnia sam nie mówi, o który odcinek kalendarza chodzi, a tydzień tej
 * aplikacji zaczyna się w sobotę — czyli nie tam, gdzie odruchowo zakłada
 * większość kalendarzy. Dlatego zakres pokazujemy wprost, wszędzie tak samo:
 * w planie, w jadłospisie i na liście zakupów.
 */
export function formatWeekRange(weekStartIso: string, weekEndIso: string): string {
  return `${formatDayMonth(weekStartIso)} – ${formatDayMonth(weekEndIso)}`
}

/**
 * Ilość składnika do wyświetlenia.
 *
 * Gramy i mililitry bez zmian, sztuki z przecinkiem dziesiętnym i skrótem „szt".
 * Gdy przepis nie podaje ilości („Czosnek", „Sok z cytryny"), pokazujemy zapis
 * ze źródła albo „do smaku" — nigdy wymyślonej liczby.
 */
export function formatIngredientAmount(ingredient: {
  amount: number | null
  unit: Unit
  label?: string
}): string {
  if (ingredient.amount === null) return ingredient.label || 'do smaku'
  const value = amountText(ingredient.amount)
  return ingredient.unit === 'piece' ? `${value} szt` : `${value} ${ingredient.unit}`
}

/**
 * Ilość na liście zakupów — z kromkami przy chlebie.
 *
 * „Chleb razowy 245 g" jest prawdą, której nikt nie użyje: chleb kupuje się
 * w bochenkach, a odmierza kromkami. Gramy zostają w nawiasie, bo to one są
 * liczbą z przepisu i po nich widać, że pozycja się zsumowała.
 * Przeliczenie i jego granice — patrz `breadSlices`.
 */
export function formatShoppingAmount(item: {
  name: string
  amount: number | null
  unit: Unit
  label?: string
}): string {
  const slices = breadSlices(item)
  if (slices === null) return formatIngredientAmount(item)
  // Połówka kromki to „0,5 kromki" — dopełniacz, nie mianownik ani liczba mnoga.
  const sliceText = Number.isInteger(slices)
    ? countLabel(slices, ['kromka', 'kromki', 'kromek'])
    : `${amountText(slices)} kromki`
  return `${sliceText} (${amountText(item.amount as number)} g)`
}

/**
 * Liczba ilości — całości bez przecinka, ułamki z przecinkiem.
 *
 * NIE przez `pl(value, 0)`: tamta funkcja obcina końcowe zera po
 * `toFixed(decimals)`, więc przy zerowej liczbie miejsc „240" robiło się „24",
 * a „60 g makaronu" pokazywało się jako „6 g". Wyszło z podglądu jadłospisu
 * (`scripts/dietReport.ts`) — testy tego nie widziały, bo sprawdzały liczby
 * w bazie, nie napis na ekranie.
 */
function amountText(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : pl(amount, 1)
}

/**
 * Odmiana po liczebniku — trzy formy, jak wymaga polski.
 *
 * `[1, 2–4, 5+]`, z wyjątkiem nastek: „12 tygodni", nie „12 tygodnie".
 * Jedno miejsce na tę regułę, bo interfejs liczy różne rzeczy (tygodnie,
 * sesje, treningi) i każda kopia tej logiki rozjeżdżałaby się osobno.
 */
export function countLabel(count: number, forms: [string, string, string]): string {
  const [one, few, many] = forms
  if (count === 1) return `${count} ${one}`
  const rest = count % 10
  const teens = count % 100
  const isFew = rest >= 2 && rest <= 4 && !(teens >= 12 && teens <= 14)
  return `${count} ${isFew ? few : many}`
}

/** 1 tydzień, 2–4 tygodnie, 5+ tygodni. */
export function weeksLabel(weeks: number): string {
  return countLabel(weeks, ['tydzień', 'tygodnie', 'tygodni'])
}

/** 1 pomiar, 2–4 pomiary, 5+ pomiarów. */
export function measurementsLabel(count: number): string {
  return countLabel(count, ['pomiar', 'pomiary', 'pomiarów'])
}

/** 1 rekord, 2–4 rekordy, 5+ rekordów. */
export function recordsLabel(count: number): string {
  return countLabel(count, ['rekord', 'rekordy', 'rekordów'])
}

/** 1 posiłek, 2–4 posiłki, 5+ posiłków. */
export function mealsLabel(count: number): string {
  return countLabel(count, ['posiłek', 'posiłki', 'posiłków'])
}

/** 1 sesja, 2–4 sesje, 5+ sesji. */
export function sessionsLabel(count: number): string {
  return countLabel(count, ['sesja', 'sesje', 'sesji'])
}

function formatIso(isoDate: string, options: Intl.DateTimeFormatOptions): string {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year ?? 2000, (month ?? 1) - 1, day ?? 1, 12))
  return new Intl.DateTimeFormat('pl-PL', { ...options, timeZone: 'UTC' }).format(date)
}
