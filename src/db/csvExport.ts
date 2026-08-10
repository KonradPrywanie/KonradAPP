import type {
  BodyMeasurement,
  CardioLog,
  MealLog,
  SessionLog,
  SetLog,
  WeightEntry,
} from '@/domain/types'
import { weightTrend } from '@/domain/calc'
import { exerciseName } from '@/lib/catalog'
import {
  BODY_METRIC_LABELS,
  MEAL_SLOT_LABELS,
  SESSION_STATUS_LABELS,
  SESSION_TYPE_LABELS,
} from '@/lib/labels'
import {
  BODY_METRICS,
  bodyMeasurementRepo,
  mealLogRepo,
  sessionLogRepo,
  weightRepo,
} from './repositories'

/**
 * Eksport historii do CSV.
 *
 * Separatorem jest średnik, nie przecinek: polski Excel domyślnie oczekuje
 * średnika i przy przecinku wrzuca cały wiersz do jednej komórki. Liczby
 * zapisujemy z przecinkiem dziesiętnym z tego samego powodu.
 *
 * To eksport do analizy, nie kopia zapasowa — CSV nie odtworzy bazy.
 * Do odtworzenia służy `backup.ts`.
 */

export const CSV_SEPARATOR = ';'

export function toCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const lines = [headers.map(escapeCell).join(CSV_SEPARATOR)]
  for (const row of rows) {
    lines.push(row.map(escapeCell).join(CSV_SEPARATOR))
  }
  return lines.join('\r\n')
}

export function weightCsv(entries: readonly WeightEntry[]): string {
  const trend = weightTrend(entries)
  return toCsv(
    ['Data', 'Masa [kg]', 'Trend [kg]'],
    trend.map((point) => [point.date, point.weightKg, point.trendKg]),
  )
}

/**
 * Obwody ciała.
 *
 * Wszystkie miary w jednym wierszu na datę, bez wypełniania braków: puste pole
 * znaczy „nie mierzyłem", a nie zero centymetrów. Arkusz sam sobie z tym
 * poradzi, podstawiona wartość już nie.
 */
export function bodyMeasurementCsv(rows: readonly BodyMeasurement[]): string {
  return toCsv(
    ['Data', ...BODY_METRICS.map((metric) => `${BODY_METRIC_LABELS[metric]} [cm]`), 'Uwagi'],
    [...rows]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((row) => [
        row.date,
        ...BODY_METRICS.map((metric) => row[metric] ?? ''),
        row.notes ?? '',
      ]),
  )
}

export function setLogCsv(logs: readonly SessionLog[], sets: readonly SetLog[]): string {
  const logById = new Map(logs.map((log) => [log.id, log]))
  const rows = sets
    .map((set) => {
      const log = logById.get(set.sessionLogId)
      if (!log) return null
      return [
        log.date,
        SESSION_STATUS_LABELS[log.status],
        exerciseName(set.exerciseId),
        set.setIndex + 1,
        set.reps,
        set.weightKg ?? '',
        set.rpe ?? '',
        // Objętość liczona tu, żeby arkusz nie musiał znać reguły.
        set.weightKg != null ? set.weightKg * set.reps : '',
      ] as const
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  return toCsv(
    ['Data', 'Status', 'Ćwiczenie', 'Seria', 'Powtórzenia', 'Ciężar [kg]', 'RPE', 'Objętość [kg]'],
    rows,
  )
}

export function cardioCsv(logs: readonly SessionLog[], cardio: readonly CardioLog[]): string {
  const logById = new Map(logs.map((log) => [log.id, log]))
  const rows = cardio
    .map((entry) => {
      const log = logById.get(entry.sessionLogId)
      if (!log) return null
      const paceSecPerKm =
        entry.distanceM > 0 ? Math.round(entry.durationSec / (entry.distanceM / 1000)) : 0
      return [
        log.date,
        SESSION_TYPE_LABELS[log.type],
        SESSION_STATUS_LABELS[log.status],
        entry.distanceM,
        Math.round(entry.durationSec / 60),
        entry.avgHr ?? '',
        paceSecPerKm > 0 ? formatPaceForSheet(paceSecPerKm) : '',
      ] as const
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])))

  return toCsv(
    ['Data', 'Dyscyplina', 'Status', 'Dystans [m]', 'Czas [min]', 'Tętno śr.', 'Tempo [min/km]'],
    rows,
  )
}

export function mealLogCsv(logs: readonly MealLog[]): string {
  const rows = [...logs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((log) => [
      log.date,
      // Etykiety, nie klucze: nagłówki są po polsku, więc kolumna z „lunch"
      // albo „other" w środku polskiego arkusza była zwykłą niekonsekwencją.
      MEAL_SLOT_LABELS[log.slot],
      log.source === 'plan' ? 'z planu' : 'poza planem',
      log.label ?? '',
      log.macros.kcal,
      log.macros.proteinG,
      log.macros.fatG,
      log.macros.carbsG,
    ])

  return toCsv(
    ['Data', 'Posiłek', 'Źródło', 'Opis', 'Kalorie', 'Białko [g]', 'Tłuszcz [g]', 'Węgle [g]'],
    rows,
  )
}

export interface CsvBundle {
  name: string
  content: string
  rowCount: number
}

/** Wszystkie zestawy naraz — do przycisku „eksportuj historię". */
export async function buildCsvBundles(): Promise<CsvBundle[]> {
  const [entries, logs, cardio, meals, measurements] = await Promise.all([
    weightRepo.all(),
    sessionLogRepo.all(),
    sessionLogRepo.allCardio(),
    allMealLogs(),
    bodyMeasurementRepo.all(),
  ])

  const sets = (
    await Promise.all(logs.map((log) => sessionLogRepo.setsForSession(log.id)))
  ).flat()

  return [
    { name: 'masa-ciala.csv', content: weightCsv(entries), rowCount: entries.length },
    {
      name: 'obwody-ciala.csv',
      content: bodyMeasurementCsv(measurements),
      rowCount: measurements.length,
    },
    { name: 'trening-serie.csv', content: setLogCsv(logs, sets), rowCount: sets.length },
    { name: 'cardio.csv', content: cardioCsv(logs, cardio), rowCount: cardio.length },
    { name: 'posilki.csv', content: mealLogCsv(meals), rowCount: meals.length },
  ]
}

async function allMealLogs(): Promise<MealLog[]> {
  const intake = await mealLogRepo.dailyIntake()
  const perDay = await Promise.all(intake.map((day) => mealLogRepo.byDate(day.date)))
  return perDay.flat()
}

function formatPaceForSheet(secPerKm: number): string {
  const minutes = Math.floor(secPerKm / 60)
  const seconds = secPerKm % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  // Przecinek dziesiętny — polski Excel nie rozpozna liczby z kropką.
  const text = typeof value === 'number' ? String(value).replace('.', ',') : String(value)
  if (text.includes(CSV_SEPARATOR) || text.includes('"') || /[\r\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`
  }
  return text
}
