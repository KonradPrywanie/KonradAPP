import Dexie, { type Table } from 'dexie'
import type {
  BodyMeasurement,
  CardioLog,
  MealLog,
  PlannedMeal,
  PlannedSession,
  Profile,
  SessionLog,
  SetLog,
  ShoppingList,
  TrainingPlan,
  WeightEntry,
} from '@/domain/types'

/**
 * IndexedDB przez Dexie. Zasady schematu — pod przyszłą synchronizację
 * z Postgresem (patrz PLAN.md §1):
 *
 *  1. Klucz główny to UUID, nigdy autoincrement.
 *  2. Każda tabela ma indeks na `updatedAt` — podstawa sync po delcie.
 *  3. Nie ma unikalnych indeksów na polach biznesowych. Soft delete
 *     kolidowałby z nimi (usunięty wpis nadal zajmuje wartość) — unikalność
 *     wymuszamy w repozytorium, gdzie widzimy `deletedAt`.
 *  4. Dane użytkownika usuwamy wyłącznie miękko.
 */
export class FitKonradDb extends Dexie {
  profiles!: Table<Profile, string>
  weightEntries!: Table<WeightEntry, string>
  bodyMeasurements!: Table<BodyMeasurement, string>

  trainingPlans!: Table<TrainingPlan, string>
  plannedSessions!: Table<PlannedSession, string>
  sessionLogs!: Table<SessionLog, string>
  setLogs!: Table<SetLog, string>
  cardioLogs!: Table<CardioLog, string>

  plannedMeals!: Table<PlannedMeal, string>
  mealLogs!: Table<MealLog, string>
  shoppingLists!: Table<ShoppingList, string>

  constructor() {
    super('fitkonrad')

    // ── Wersja 1 ──────────────────────────────────────────────────────
    // Każda przyszła zmiana schematu = NOWY blok `.version(n).stores(...)`
    // z `.upgrade()` gdy trzeba przemigrować dane. Nigdy nie edytujemy
    // wersji już wydanej — użytkownicy mają ją w przeglądarce.
    this.version(1).stores({
      profiles: 'id, updatedAt',
      weightEntries: 'id, date, updatedAt',

      trainingPlans: 'id, status, startDate, updatedAt',
      plannedSessions: 'id, planId, date, [planId+weekIndex], updatedAt',
      sessionLogs: 'id, date, plannedSessionId, type, updatedAt',
      setLogs: 'id, sessionLogId, exerciseId, [exerciseId+createdAt], updatedAt',
      cardioLogs: 'id, sessionLogId, updatedAt',

      plannedMeals: 'id, date, [date+slot], recipeId, updatedAt',
      mealLogs: 'id, date, [date+slot], updatedAt',
      shoppingLists: 'id, weekStart, updatedAt',
    })

    // ── Wersja 2 ──────────────────────────────────────────────────────
    // Obwody ciała w centymetrach, wpisywane raz w tygodniu w sobotę.
    // Bez `upgrade()`: nowa tabela startuje pusta, istniejące dane nietknięte.
    // Wersja 1 zostaje wyżej dosłownie taka, jak została wydana.
    this.version(2).stores({
      bodyMeasurements: 'id, date, updatedAt',
    })

    /**
     * ── Wersja 3 ────────────────────────────────────────────────────────
     * Przepisy i treningi z arkuszy trenera zastąpiły dawny katalog.
     *
     * Schemat tabel się nie zmienia, ale ZAWARTOŚĆ starych planów i jadłospisów
     * przestała mieć znaczenie: wskazują na identyfikatory przepisów i ćwiczeń,
     * których już nie ma. Sesja pokazywałaby „a1-hip-thrust" jako nazwę, posiłek
     * nie miałby składników, lista zakupów odwoływałaby się do produktów
     * usuniętej bazy.
     *
     * Dlatego migracja usuwa MIĘKKO plany, sesje, jadłospisy i listy zakupów,
     * a aplikacja pokazuje wtedy zwykłe „brak planu" / „brak jadłospisu"
     * z przyciskiem generowania. LOG TRENINGOWY I DZIENNIK POSIŁKÓW ZOSTAJĄ
     * NIETKNIĘTE — historia jest append-only i nie kasuje się jej przy zmianie
     * katalogu, nawet gdy w statystykach zostaną surowe identyfikatory ćwiczeń.
     */
    this.version(3)
      .stores({})
      .upgrade(async (tx) => {
        const now = new Date().toISOString()
        for (const table of ['trainingPlans', 'plannedSessions', 'plannedMeals', 'shoppingLists']) {
          const rows = await tx.table(table).toArray()
          await tx.table(table).bulkPut(
            rows.map((row: { deletedAt?: string | null }) => ({
              ...row,
              deletedAt: row.deletedAt ?? now,
              updatedAt: now,
            })),
          )
        }
      })
  }
}

export const db = new FitKonradDb()

/** Nowy identyfikator rekordu. */
export function newId(): string {
  return crypto.randomUUID()
}

/** Znacznik `updatedAt` dla zapisu. */
export function stamp(): string {
  return new Date().toISOString()
}

/** Odfiltrowuje rekordy usunięte miękko. */
export function alive<T extends { deletedAt?: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !r.deletedAt)
}
