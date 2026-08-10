import type {
  BodyMeasurement,
  BodyMetric,
  CardioLog,
  IsoDate,
  MealLog,
  SessionLog,
  SetLog,
} from '../types'
import { addDays, diffDays, startOfWeek } from '../dates'

/**
 * Agregacje pod wykresy postępów.
 *
 * Wszystko liczy się z LOGU, nigdy z planu — plan mówi, co miało być,
 * statystyki mówią, co było. Warstwa jest czysta, żeby dała się przetestować
 * bez bazy i bez Reacta.
 */

export type RangeDays = 7 | 30 | null

/** Filtr zakresu. `null` oznacza całą historię. */
export function withinRange<T extends { date: IsoDate }>(
  items: readonly T[],
  today: IsoDate,
  days: RangeDays,
): T[] {
  if (days === null) return [...items]
  return items.filter((item) => {
    const age = diffDays(item.date, today)
    return age >= 0 && age < days
  })
}

// ─────────────────────────────────────────── Objętość treningowa

export interface WeeklyVolumePoint {
  weekStart: IsoDate
  /** Suma ciężar × powtórzenia. Ćwiczenia z masą własną nie wnoszą kilogramów. */
  volumeKg: number
  sets: number
  sessions: number
  /** Tydzień deloadu — wyliczany z planu, nie z logu, więc podaje go wywołujący. */
  isDeload: boolean
}

/**
 * Objętość tygodniowa.
 *
 * Tygodnie bez treningu dostają zero, a nie są pomijane: przerwa jest
 * informacją, a wykres z dziurą kłamałby o ciągłości.
 */
export function weeklyVolume(
  logs: readonly SessionLog[],
  sets: readonly SetLog[],
  deloadWeekStarts: ReadonlySet<IsoDate> = new Set(),
): WeeklyVolumePoint[] {
  const usable = new Map(
    logs.filter((log) => !log.deletedAt && log.status !== 'skipped').map((log) => [log.id, log]),
  )
  if (usable.size === 0) return []

  const buckets = new Map<IsoDate, { volumeKg: number; sets: number; sessions: Set<string> }>()

  const bucketFor = (weekStart: IsoDate) => {
    const existing = buckets.get(weekStart)
    if (existing) return existing
    const created = { volumeKg: 0, sets: 0, sessions: new Set<string>() }
    buckets.set(weekStart, created)
    return created
  }

  for (const log of usable.values()) {
    bucketFor(startOfWeek(log.date)).sessions.add(log.id)
  }

  for (const set of sets) {
    if (set.deletedAt) continue
    const log = usable.get(set.sessionLogId)
    if (!log) continue
    const bucket = bucketFor(startOfWeek(log.date))
    bucket.sets += 1
    bucket.volumeKg += (set.weightKg ?? 0) * set.reps
  }

  return fillWeeks([...buckets.keys()]).map((weekStart) => {
    const bucket = buckets.get(weekStart)
    return {
      weekStart,
      volumeKg: Math.round(bucket?.volumeKg ?? 0),
      sets: bucket?.sets ?? 0,
      sessions: bucket?.sessions.size ?? 0,
      isDeload: deloadWeekStarts.has(weekStart),
    }
  })
}

// ─────────────────────────────────────────────────── Dystanse

export interface WeeklyDistancePoint {
  weekStart: IsoDate
  runM: number
  swimM: number
  walkM: number
}

/**
 * Dystanse tygodniowe, rozdzielone na dyscypliny.
 *
 * Spacer ma własną serię, a nie wpada do biegania: 6 km marszu z psem i 6 km
 * biegu to inny wysiłek, a zliczenie ich razem zawyżałoby statystykę biegową.
 */
export function weeklyDistance(
  logs: readonly SessionLog[],
  cardio: readonly CardioLog[],
): WeeklyDistancePoint[] {
  const usable = new Map(
    logs.filter((log) => !log.deletedAt && log.status !== 'skipped').map((log) => [log.id, log]),
  )
  const buckets = new Map<IsoDate, { runM: number; swimM: number; walkM: number }>()

  for (const entry of cardio) {
    if (entry.deletedAt) continue
    const log = usable.get(entry.sessionLogId)
    if (!log) continue

    const weekStart = startOfWeek(log.date)
    const bucket = buckets.get(weekStart) ?? { runM: 0, swimM: 0, walkM: 0 }
    if (log.type === 'swim') bucket.swimM += entry.distanceM
    else if (log.type === 'walk') bucket.walkM += entry.distanceM
    else bucket.runM += entry.distanceM
    buckets.set(weekStart, bucket)
  }

  if (buckets.size === 0) return []

  return fillWeeks([...buckets.keys()]).map((weekStart) => ({
    weekStart,
    runM: buckets.get(weekStart)?.runM ?? 0,
    swimM: buckets.get(weekStart)?.swimM ?? 0,
    walkM: buckets.get(weekStart)?.walkM ?? 0,
  }))
}

// ──────────────────────────────────────────────────── Kalorie

export interface DailyKcalPoint {
  date: IsoDate
  fromPlan: number
  manual: number
  total: number
}

/**
 * Kalorie per dzień, z rozbiciem na wpisy z planu i odstępstwa.
 *
 * Dni bez logu są POMIJANE, nie zerowane. „Nie zalogowałem" to nie to samo
 * co „zjadłem zero kalorii" — wyzerowanie takiego dnia zafałszowałoby
 * i wykres, i wrażenie użytkownika o własnej diecie.
 */
export function dailyKcal(logs: readonly MealLog[]): DailyKcalPoint[] {
  const buckets = new Map<IsoDate, { fromPlan: number; manual: number }>()

  for (const log of logs) {
    if (log.deletedAt) continue
    const bucket = buckets.get(log.date) ?? { fromPlan: 0, manual: 0 }
    if (log.source === 'manual') bucket.manual += log.macros.kcal
    else bucket.fromPlan += log.macros.kcal
    buckets.set(log.date, bucket)
  }

  return [...buckets.entries()]
    .map(([date, bucket]) => ({
      date,
      fromPlan: Math.round(bucket.fromPlan),
      manual: Math.round(bucket.manual),
      total: Math.round(bucket.fromPlan + bucket.manual),
    }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ───────────────────────────────────────────────── Obwody ciała

export interface BodyMetricPoint {
  date: IsoDate
  valueCm: number
}

export interface BodyMetricSeries {
  metric: BodyMetric
  points: BodyMetricPoint[]
  first: number | null
  last: number | null
  /** Zmiana od pierwszego do ostatniego pomiaru w zakresie. */
  changeCm: number | null
}

/**
 * Jedna miara jako seria czasowa.
 *
 * Dni bez pomiaru są POMIJANE, nie zerowane — tak samo jak w kaloriach:
 * „nie mierzyłem" to nie „mam zero centymetrów w pasie". Pomiary są tygodniowe,
 * więc dziur jest z definicji więcej niż wartości i wypełnianie ich czymkolwiek
 * dawałoby wykres opowiadający o interpolacji, nie o ciele.
 */
export function bodyMetricSeries(
  measurements: readonly BodyMeasurement[],
  metric: BodyMetric,
): BodyMetricSeries {
  const points = measurements
    .filter((row) => !row.deletedAt)
    .map((row) => ({ date: row.date, value: row[metric] }))
    .filter((row): row is { date: IsoDate; value: number } => typeof row.value === 'number')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((row) => ({ date: row.date, valueCm: row.value }))

  const first = points[0]?.valueCm ?? null
  const last = points.at(-1)?.valueCm ?? null

  return {
    metric,
    points,
    first,
    last,
    changeCm: first !== null && last !== null ? Math.round((last - first) * 10) / 10 : null,
  }
}

/** Które miary mają w zakresie choć jeden pomiar — do doboru zakładek wykresu. */
export function measuredMetrics(
  measurements: readonly BodyMeasurement[],
  metrics: readonly BodyMetric[],
): BodyMetric[] {
  return metrics.filter((metric) =>
    measurements.some((row) => !row.deletedAt && typeof row[metric] === 'number'),
  )
}

// ────────────────────────────────────────────── Realizacja planu

export interface AdherenceSummary {
  done: number
  partial: number
  skipped: number
  /** Zalogowane sesje POCHODZĄCE Z PLANU. */
  logged: number
  /** Udział wykonanych w całości, 0–100. */
  donePct: number
  /** Treningi dopisane poza planem — liczone osobno, nie jako realizacja. */
  extra: number
}

/**
 * Realizacja planu.
 *
 * Liczy WYŁĄCZNIE sesje powiązane z planem (`plannedSessionId`). Treningi
 * dopisane poza planem raportujemy osobno: wrzucenie ich do „wykonanych"
 * zawyżałoby realizację — spacer z psem w dniu wolnym nie jest wykonaniem
 * zaplanowanej sesji, choć jest aktywnością wartą policzenia.
 */
export function adherence(logs: readonly SessionLog[]): AdherenceSummary {
  let done = 0
  let partial = 0
  let skipped = 0
  let extra = 0

  for (const log of logs) {
    if (log.deletedAt) continue
    if (log.plannedSessionId === null) {
      extra++
      continue
    }
    if (log.status === 'done') done++
    else if (log.status === 'partial') partial++
    else skipped++
  }

  const logged = done + partial + skipped
  return {
    done,
    partial,
    skipped,
    logged,
    donePct: logged === 0 ? 0 : Math.round((done / logged) * 100),
    extra,
  }
}

/** Uzupełnia brakujące tygodnie między pierwszym i ostatnim wpisem. */
function fillWeeks(weekStarts: readonly IsoDate[]): IsoDate[] {
  if (weekStarts.length === 0) return []
  const sorted = [...weekStarts].sort((a, b) => a.localeCompare(b))
  const first = sorted[0] as IsoDate
  const last = sorted[sorted.length - 1] as IsoDate

  const out: IsoDate[] = []
  for (let cursor = first; diffDays(cursor, last) >= 0; cursor = addDays(cursor, 7)) {
    out.push(cursor)
  }
  return out
}
