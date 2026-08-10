import type {
  BodyMeasurement,
  BodyMetric,
  CardioLog,
  IsoDate,
  Macros,
  MealLog,
  MealSlot,
  Profile,
  SessionLog,
  SessionStatus,
  SetLog,
  Uuid,
  WeightEntry,
} from '@/domain/types'
import type { DailyIntake } from '@/domain/calc'
import { alive, db, newId, stamp } from './db'

/**
 * Repozytoria. Jedyne miejsce, które zna Dexie — `domain/` nie może go widzieć.
 * Wszystkie odczyty filtrują soft delete; wszystkie usunięcia są miękkie.
 */

// ─────────────────────────────────────────────────────────── Profil

export const profileRepo = {
  /** Aplikacja jest jednoużytkownikowa — profil jest jeden. */
  async get(): Promise<Profile | undefined> {
    const rows = await db.profiles.toArray()
    return alive(rows)[0]
  },

  async save(
    input: Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
  ): Promise<Profile> {
    const existing = await profileRepo.get()
    const now = stamp()
    const profile: Profile = existing
      ? { ...existing, ...input, updatedAt: now }
      : { ...input, id: newId(), createdAt: now, updatedAt: now, deletedAt: null }
    await db.profiles.put(profile)
    return profile
  },

  async patch(patch: Partial<Profile>): Promise<Profile | undefined> {
    const existing = await profileRepo.get()
    if (!existing) return undefined
    const updated: Profile = { ...existing, ...patch, updatedAt: stamp() }
    await db.profiles.put(updated)
    return updated
  },
}

// ───────────────────────────────────────────────────────── Pomiary

export const weightRepo = {
  async all(): Promise<WeightEntry[]> {
    const rows = await db.weightEntries.orderBy('date').toArray()
    return alive(rows)
  },

  /**
   * Jeden pomiar na dzień. Unikalność wymuszamy tutaj, a nie indeksem —
   * indeks unikalny kolidowałby z wpisami usuniętymi miękko.
   */
  async upsert(date: IsoDate, weightKg: number): Promise<WeightEntry> {
    if (!Number.isFinite(weightKg) || weightKg <= 0) {
      throw new RangeError('Waga musi być dodatnia')
    }
    const sameDay = alive(await db.weightEntries.where('date').equals(date).toArray())
    const now = stamp()
    const first = sameDay[0]

    const entry: WeightEntry = first
      ? { ...first, weightKg, updatedAt: now }
      : { id: newId(), date, weightKg, createdAt: now, updatedAt: now, deletedAt: null }

    // Gdyby z jakiegoś powodu istniały duplikaty — zostawiamy jeden.
    for (const dup of sameDay.slice(1)) {
      await db.weightEntries.put({ ...dup, deletedAt: now, updatedAt: now })
    }

    await db.weightEntries.put(entry)
    return entry
  },

  async softDelete(id: Uuid): Promise<void> {
    const row = await db.weightEntries.get(id)
    if (!row) return
    const now = stamp()
    await db.weightEntries.put({ ...row, deletedAt: now, updatedAt: now })
  },

  async latest(): Promise<WeightEntry | undefined> {
    return (await weightRepo.all()).at(-1)
  },
}

// ───────────────────────────────────────────── Obwody ciała

/** Miary, o które pyta formularz — kolejność jest kolejnością pól. */
export const BODY_METRICS: readonly BodyMetric[] = [
  'waistCm',
  'hipsCm',
  'chestCm',
  'thighCm',
  'armCm',
]

export type BodyMeasurementInput = Partial<Record<BodyMetric, number | null>> & {
  notes?: string
}

/**
 * Obwody ciała.
 *
 * Ta sama zasada jednego wpisu na dzień, co w `weightRepo` — poprawka pomiaru
 * nadpisuje wpis z tego dnia, a nie dokłada drugi. Pusty wpis jest odrzucany:
 * rekord bez ani jednej miary nic nie znaczy, a zaśmiecałby wykres i historię.
 */
export const bodyMeasurementRepo = {
  async all(): Promise<BodyMeasurement[]> {
    const rows = await db.bodyMeasurements.orderBy('date').toArray()
    return alive(rows)
  },

  async onDate(date: IsoDate): Promise<BodyMeasurement | undefined> {
    return alive(await db.bodyMeasurements.where('date').equals(date).toArray())[0]
  },

  /** Wpisy z zakresu dat włącznie — do sprawdzenia, czy tydzień ma pomiar. */
  async inRange(from: IsoDate, to: IsoDate): Promise<BodyMeasurement[]> {
    return (await bodyMeasurementRepo.all()).filter((row) => row.date >= from && row.date <= to)
  },

  async latest(): Promise<BodyMeasurement | undefined> {
    return (await bodyMeasurementRepo.all()).at(-1)
  },

  async upsert(date: IsoDate, input: BodyMeasurementInput): Promise<BodyMeasurement> {
    const values: Partial<Record<BodyMetric, number>> = {}
    for (const metric of BODY_METRICS) {
      const value = input[metric]
      if (value == null) continue
      if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`Obwód ${metric} musi być dodatni`)
      }
      values[metric] = Math.round(value * 10) / 10
    }
    if (Object.keys(values).length === 0) {
      throw new RangeError('Podaj przynajmniej jeden obwód')
    }

    const sameDay = alive(await db.bodyMeasurements.where('date').equals(date).toArray())
    const now = stamp()
    const first = sameDay[0]

    const notes = input.notes?.trim()
    const entry: BodyMeasurement = first
      ? // Nadpisanie czyści miary pominięte w formularzu — inaczej nie dałoby
        // się skasować omyłkowego wpisu, a tylko go zmienić na inną liczbę.
        { ...first, ...blankMetrics(), ...values, notes, updatedAt: now }
      : {
          id: newId(),
          date,
          ...values,
          notes,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }

    for (const dup of sameDay.slice(1)) {
      await db.bodyMeasurements.put({ ...dup, deletedAt: now, updatedAt: now })
    }

    await db.bodyMeasurements.put(entry)
    return entry
  },

  async softDelete(id: Uuid): Promise<void> {
    const row = await db.bodyMeasurements.get(id)
    if (!row) return
    const now = stamp()
    await db.bodyMeasurements.put({ ...row, deletedAt: now, updatedAt: now })
  },
}

function blankMetrics(): Record<BodyMetric, undefined> {
  return {
    waistCm: undefined,
    hipsCm: undefined,
    chestCm: undefined,
    thighCm: undefined,
    armCm: undefined,
  }
}

// ─────────────────────────────────────────────── Log posiłków

export const mealLogRepo = {
  async byDate(date: IsoDate): Promise<MealLog[]> {
    return alive(await db.mealLogs.where('date').equals(date).toArray())
  },

  async logFromPlan(
    date: IsoDate,
    slot: MealSlot,
    plannedMealId: Uuid,
    macros: Macros,
  ): Promise<MealLog> {
    return insertMealLog({ date, slot, plannedMealId, source: 'plan', macros })
  },

  /**
   * Odstępstwo od planu. To obywatel pierwszej kategorii, nie wyjątek —
   * bez tego kalorie na dashboardzie kłamią, a adaptacyjny TDEE nie działa.
   */
  async logManual(
    date: IsoDate,
    slot: MealSlot,
    label: string,
    macros: Macros,
  ): Promise<MealLog> {
    return insertMealLog({ date, slot, plannedMealId: null, source: 'manual', label, macros })
  },

  async softDelete(id: Uuid): Promise<void> {
    const row = await db.mealLogs.get(id)
    if (!row) return
    const now = stamp()
    await db.mealLogs.put({ ...row, deletedAt: now, updatedAt: now })
  },

  async consumedOn(date: IsoDate): Promise<Macros> {
    const logs = await mealLogRepo.byDate(date)
    return logs.reduce<Macros>(
      (sum, log) => ({
        kcal: sum.kcal + log.macros.kcal,
        proteinG: sum.proteinG + log.macros.proteinG,
        fatG: sum.fatG + log.macros.fatG,
        carbsG: sum.carbsG + log.macros.carbsG,
      }),
      { kcal: 0, proteinG: 0, fatG: 0, carbsG: 0 },
    )
  },

  /** Dobowe sumy kalorii — wejście do `adaptiveTdee()`. */
  async dailyIntake(): Promise<DailyIntake[]> {
    const logs = alive(await db.mealLogs.toArray())
    const byDate = new Map<IsoDate, number>()
    for (const log of logs) {
      byDate.set(log.date, (byDate.get(log.date) ?? 0) + log.macros.kcal)
    }
    return [...byDate.entries()]
      .map(([date, kcal]) => ({ date, kcal: Math.round(kcal) }))
      .sort((a, b) => a.date.localeCompare(b.date))
  },
}

async function insertMealLog(
  input: Omit<MealLog, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
): Promise<MealLog> {
  const now = stamp()
  const log: MealLog = { ...input, id: newId(), createdAt: now, updatedAt: now, deletedAt: null }
  await db.mealLogs.add(log)
  return log
}

// ──────────────────────────────────────────────── Log treningów

export const sessionLogRepo = {
  async byDate(date: IsoDate): Promise<SessionLog[]> {
    return alive(await db.sessionLogs.where('date').equals(date).toArray())
  },

  async forPlannedSession(plannedSessionId: Uuid): Promise<SessionLog | undefined> {
    return alive(
      await db.sessionLogs.where('plannedSessionId').equals(plannedSessionId).toArray(),
    )[0]
  },

  /**
   * Zapisuje wykonanie sesji wraz z seriami w jednej transakcji.
   * `setLogs` są per SERIA — bez tej granularności nie ma progresji
   * ani objętości treningowej.
   */
  async record(
    input: Omit<SessionLog, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    sets: Omit<SetLog, 'id' | 'sessionLogId' | 'createdAt' | 'updatedAt' | 'deletedAt'>[] = [],
  ): Promise<SessionLog> {
    const now = stamp()
    const log: SessionLog = {
      ...input,
      id: newId(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    const setRows: SetLog[] = sets.map((s) => ({
      ...s,
      id: newId(),
      sessionLogId: log.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }))

    await db.transaction('rw', db.sessionLogs, db.setLogs, async () => {
      await db.sessionLogs.add(log)
      if (setRows.length > 0) await db.setLogs.bulkAdd(setRows)
    })
    return log
  },

  async markStatus(
    plannedSessionId: Uuid,
    date: IsoDate,
    type: SessionLog['type'],
    status: SessionStatus,
  ): Promise<SessionLog> {
    const existing = await sessionLogRepo.forPlannedSession(plannedSessionId)
    if (existing) {
      const updated: SessionLog = { ...existing, status, updatedAt: stamp() }
      await db.sessionLogs.put(updated)
      return updated
    }
    return sessionLogRepo.record({ plannedSessionId, date, type, status })
  },

  /**
   * Wycofuje wpis, żeby dało się go wprowadzić ponownie.
   *
   * Nie łamie zasady „log jest append-only": usuwamy miękko, więc błędny
   * wpis zostaje w bazie ze znacznikiem `deletedAt`. Bez tej możliwości
   * literówka w ciężarze zostawałaby w historii na zawsze i psuła progresję.
   */
  async undoLog(sessionLogId: Uuid): Promise<void> {
    const now = stamp()
    await db.transaction('rw', db.sessionLogs, db.setLogs, db.cardioLogs, async () => {
      const log = await db.sessionLogs.get(sessionLogId)
      if (log) await db.sessionLogs.put({ ...log, deletedAt: now, updatedAt: now })

      const sets = await db.setLogs.where('sessionLogId').equals(sessionLogId).toArray()
      for (const set of sets) {
        await db.setLogs.put({ ...set, deletedAt: now, updatedAt: now })
      }
      const cardio = await db.cardioLogs.where('sessionLogId').equals(sessionLogId).toArray()
      for (const row of cardio) {
        await db.cardioLogs.put({ ...row, deletedAt: now, updatedAt: now })
      }
    })
  },

  /** Sesja cardio: log sesji + pomiar dystansu i czasu w jednej transakcji. */
  async recordCardio(
    input: Omit<SessionLog, 'id' | 'createdAt' | 'updatedAt' | 'deletedAt'>,
    cardio: { distanceM: number; durationSec: number; avgHr?: number },
  ): Promise<SessionLog> {
    const now = stamp()
    const log: SessionLog = {
      ...input,
      id: newId(),
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    const cardioRow: CardioLog = {
      ...cardio,
      id: newId(),
      sessionLogId: log.id,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }

    await db.transaction('rw', db.sessionLogs, db.cardioLogs, async () => {
      await db.sessionLogs.add(log)
      await db.cardioLogs.add(cardioRow)
    })
    return log
  },

  async cardioForSession(sessionLogId: Uuid): Promise<CardioLog | undefined> {
    return alive(await db.cardioLogs.where('sessionLogId').equals(sessionLogId).toArray())[0]
  },

  /** Wszystkie logi sesji — wejście do statystyk i historii. */
  async all(): Promise<SessionLog[]> {
    const rows = alive(await db.sessionLogs.toArray())
    return rows.sort((a, b) => a.date.localeCompare(b.date))
  },

  async allCardio(): Promise<CardioLog[]> {
    return alive(await db.cardioLogs.toArray())
  },

  async setsForExercise(exerciseId: string): Promise<SetLog[]> {
    return alive(await db.setLogs.where('exerciseId').equals(exerciseId).toArray())
  },

  async setsForSession(sessionLogId: Uuid): Promise<SetLog[]> {
    return alive(await db.setLogs.where('sessionLogId').equals(sessionLogId).toArray())
  },
}
