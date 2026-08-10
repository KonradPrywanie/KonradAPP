import { beforeEach, describe, expect, it } from 'vitest'
import type { Profile } from '@/domain/types'
import { macros } from '@/domain/calc/macros'
import { db } from './db'
import { mealLogRepo, profileRepo, sessionLogRepo, weightRepo } from './repositories'
import { planRepo } from './planRepo'
import { dietRepo } from './dietRepo'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  backupFileName,
  countRecords,
  exportBackup,
  importBackup,
  parseBackup,
  type BackupFile,
} from './backup'
import { cardioCsv, mealLogCsv, setLogCsv, toCsv, weightCsv } from './csvExport'

// Sobota — pierwszy dzień tygodnia aplikacji, więc plan nie ma częściowego
// pierwszego tygodnia i liczba sesji jest wielokrotnością siódemki.
const START = '2026-08-01'
const TARGETS = macros({ kcal: 2207, goal: 'cut', weightKg: 80, heightCm: 180 }).macros

async function seedProfile(): Promise<Profile> {
  return profileRepo.save({
    name: 'Test',
    birthYear: 1996,
    sex: 'male',
    heightCm: 180,
    startWeightKg: 80,
    goal: 'cut',
    activityLevel: 'moderate',
    experience: 'intermediate',
    equipment: ['gym', 'dumbbells', 'home', 'running'],
    availableDays: [1, 2, 4, 5],
    emphasis: 'balanced',
    sessionMinutes: 60,
    // Bieganie w sprzęcie ⇒ punkt wyjścia jest wymagany, inaczej
    // `generateAndSave` odmawia (patrz `missingPlanInputs`).
    runBaseline: { distanceM: 6000, paceSecPerKm: 330 },
    diet: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
    cooking: { weekdayMinutes: 45, prepStyle: 'daily' },
    injuries: [],
    mealSplit: { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 },
    kcalOverride: null,
  })
}

/** Baza z danymi we wszystkich istotnych tabelach. */
async function seedEverything() {
  const profile = await seedProfile()
  const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
  await dietRepo.generateWeek(profile, START, TARGETS)
  await weightRepo.upsert(START, 80)
  await weightRepo.upsert('2026-08-04', 79.6)

  const session = (await planRepo.sessionsForWeek(plan.id, 0)).find(
    (s) => s.payload.kind === 'strength',
  )
  const log = await sessionLogRepo.record(
    { plannedSessionId: session?.id ?? null, date: START, type: 'strength', status: 'done' },
    [
      { exerciseId: 'bench-press', setIndex: 0, reps: 8, weightKg: 80, rpe: 7 },
      { exerciseId: 'bench-press', setIndex: 1, reps: 8, weightKg: 80, rpe: 8 },
    ],
  )
  await sessionLogRepo.recordCardio(
    { plannedSessionId: null, date: '2026-08-04', type: 'run', status: 'done', durationMin: 30 },
    { distanceM: 6000, durationSec: 1800, avgHr: 150 },
  )
  await mealLogRepo.logManual(START, 'snack', 'pizza', {
    kcal: 900,
    proteinG: 35,
    fatG: 40,
    carbsG: 95,
  })

  return { profile, plan, log }
}

async function clearDb() {
  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) await table.clear()
  })
}

beforeEach(clearDb)

// ════════════════════════════════════════════════════════════════════
//  Eksport
// ════════════════════════════════════════════════════════════════════

describe('exportBackup', () => {
  it('zapisuje metadane formatu i wersję schematu', async () => {
    const backup = await exportBackup(new Date('2026-07-29T10:00:00.000Z'))
    expect(backup.format).toBe(BACKUP_FORMAT)
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(backup.schemaVersion).toBe(db.verno)
    expect(backup.exportedAt).toBe('2026-07-29T10:00:00.000Z')
  })

  it('zawiera wszystkie tabele bazy, także puste', async () => {
    const backup = await exportBackup()
    for (const table of db.tables) {
      expect(backup.tables[table.name], table.name).toBeDefined()
      expect(Array.isArray(backup.tables[table.name])).toBe(true)
    }
  })

  it('zrzuca dane ze wszystkich tabel', async () => {
    await seedEverything()
    const backup = await exportBackup()

    expect(backup.tables['profiles']).toHaveLength(1)
    expect(backup.tables['trainingPlans']).toHaveLength(1)
    expect(backup.tables['plannedSessions']).toHaveLength(4 * 7)
    expect(backup.tables['plannedMeals']).toHaveLength(28) // 7 dni × 4 posiłki
    expect(backup.tables['weightEntries']).toHaveLength(2)
    expect(backup.tables['sessionLogs']).toHaveLength(2)
    expect(backup.tables['setLogs']).toHaveLength(2)
    expect(backup.tables['cardioLogs']).toHaveLength(1)
    expect(backup.tables['mealLogs']).toHaveLength(1)
  })

  it('KRYTYCZNE: zawiera rekordy usunięte miękko', async () => {
    // Kopia ma odtworzyć stan BAZY, nie stan widoku. Pominięcie rekordów
    // z `deletedAt` sprawiłoby, że scalanie po przywróceniu wskrzesza usunięte
    // wpisy — bo nie ma po nich śladu, że zostały usunięte.
    const entry = await weightRepo.upsert(START, 80)
    await weightRepo.softDelete(entry.id)

    const backup = await exportBackup()
    expect(backup.tables['weightEntries']).toHaveLength(1)
    const row = (backup.tables['weightEntries'] as { deletedAt: string | null }[])[0]
    expect(row?.deletedAt).toBeTruthy()
  })

  it('nazwa pliku zawiera datę', () => {
    expect(backupFileName(new Date('2026-07-29T22:00:00.000Z'))).toBe(
      'fitkonrad-kopia-2026-07-29.json',
    )
  })

  it('countRecords sumuje wszystkie rekordy', async () => {
    await seedEverything()
    const backup = await exportBackup()
    const manual = Object.values(backup.tables).reduce((sum, rows) => sum + rows.length, 0)
    expect(countRecords(backup)).toBe(manual)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Walidacja pliku
// ════════════════════════════════════════════════════════════════════

describe('parseBackup', () => {
  function validFile(patch: Record<string, unknown> = {}): string {
    return JSON.stringify({
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: db.verno,
      exportedAt: '2026-07-29T10:00:00.000Z',
      tables: { profiles: [] },
      ...patch,
    })
  }

  it('przyjmuje poprawny plik', () => {
    const parsed = parseBackup(validFile())
    expect(parsed.schemaVersion).toBe(db.verno)
    expect(parsed.tables['profiles']).toEqual([])
  })

  it('odrzuca plik, który nie jest JSON-em', () => {
    expect(() => parseBackup('to nie json')).toThrow(BackupError)
    expect(() => parseBackup('to nie json')).toThrow(/poprawnym JSON/)
  })

  it('odrzuca JSON, który nie jest obiektem', () => {
    expect(() => parseBackup('[1,2,3]')).toThrow(/obiektu kopii/)
    expect(() => parseBackup('42')).toThrow(/obiektu kopii/)
  })

  it('odrzuca plik z innej aplikacji', () => {
    expect(() => parseBackup(validFile({ format: 'coś-innego' }))).toThrow(
      /nie jest kopia zapasowa FITKonrada/,
    )
  })

  it('odrzuca nowszy format pliku', () => {
    expect(() => parseBackup(validFile({ formatVersion: 99 }))).toThrow(/Zaktualizuj aplikację/)
  })

  it('odrzuca kopię z nowszej wersji schematu bazy', () => {
    // Import do starszego schematu mógłby wczytać pola, których nie ma
    // w indeksach — bezpieczniej odmówić.
    expect(() => parseBackup(validFile({ schemaVersion: db.verno + 1 }))).toThrow(
      /nowszej wersji bazy/,
    )
  })

  it('przyjmuje kopię ze starszej wersji schematu', () => {
    expect(() => parseBackup(validFile({ schemaVersion: 1 }))).not.toThrow()
  })

  it('odrzuca brak sekcji tabel i tabelę, która nie jest listą', () => {
    expect(() => parseBackup(validFile({ tables: undefined }))).toThrow(/sekcji z tabelami/)
    expect(() => parseBackup(validFile({ tables: { profiles: 'nie lista' } }))).toThrow(
      /nie jest listą rekordów/,
    )
  })

  it('eksport i parsowanie tworzą pełny obieg', async () => {
    await seedEverything()
    const exported = await exportBackup()
    const parsed = parseBackup(JSON.stringify(exported))
    expect(countRecords(parsed)).toBe(countRecords(exported))
  })
})

// ════════════════════════════════════════════════════════════════════
//  Przywracanie
// ════════════════════════════════════════════════════════════════════

describe('importBackup — tryb zastąpienia', () => {
  it('odtwarza bazę po całkowitym wyczyszczeniu', async () => {
    await seedEverything()
    const backup = await exportBackup()
    const before = countRecords(backup)

    await clearDb()
    expect(await db.profiles.count()).toBe(0)

    const result = await importBackup(backup, 'replace')
    const imported = Object.values(result.imported).reduce((sum, n) => sum + n, 0)
    expect(imported).toBe(before)

    // Dane muszą być użyteczne przez repozytoria, nie tylko obecne w tabelach.
    const profile = await profileRepo.get()
    expect(profile?.name).toBe('Test')
    expect(await planRepo.active()).toBeDefined()
    expect(await dietRepo.mealsOnDate(START)).toHaveLength(4)
    expect(await weightRepo.all()).toHaveLength(2)
    expect((await mealLogRepo.consumedOn(START)).kcal).toBe(900)
  })

  it('usuwa dane, których nie ma w kopii', async () => {
    const backup = await exportBackup() // pusta baza
    await seedEverything()
    expect(await db.profiles.count()).toBe(1)

    await importBackup(backup, 'replace')
    expect(await db.profiles.count()).toBe(0)
    expect(await db.plannedSessions.count()).toBe(0)
  })

  it('pomija rekordy bez identyfikatora i mówi o tym', async () => {
    const backup: BackupFile = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      schemaVersion: db.verno,
      exportedAt: '2026-07-29T10:00:00.000Z',
      tables: { weightEntries: [{ date: START, weightKg: 80 }, 'śmieć', null] },
    }

    const result = await importBackup(backup, 'replace')
    expect(result.imported['weightEntries']).toBe(0)
    expect(result.skipped['weightEntries']).toBe(3)
    expect(result.warnings.join(' ')).toMatch(/brak identyfikatora/)
  })

  it('ostrzega o nieznanej tabeli, ale nie przerywa przywracania', async () => {
    await seedProfile()
    const backup = await exportBackup()
    backup.tables['jakasStaraTabela'] = [{ id: 'x' }]

    const result = await importBackup(backup, 'replace')
    expect(result.warnings.join(' ')).toMatch(/jakasStaraTabela/)
    expect(await profileRepo.get()).toBeDefined()
  })

  it('ostrzega o tabeli brakującej w kopii', async () => {
    const backup = await exportBackup()
    delete backup.tables['mealLogs']
    const result = await importBackup(backup, 'replace')
    expect(result.warnings.join(' ')).toMatch(/mealLogs/)
  })

  it('przywracanie jest idempotentne', async () => {
    await seedEverything()
    const backup = await exportBackup()

    await importBackup(backup, 'replace')
    const first = await db.plannedSessions.count()
    await importBackup(backup, 'replace')
    const second = await db.plannedSessions.count()

    expect(second).toBe(first)
  })
})

describe('importBackup — tryb scalania', () => {
  it('zostawia nowszą wersję rekordu', async () => {
    const profile = await seedProfile()
    const backup = await exportBackup()

    // Zmiana lokalna PO zrobieniu kopii — musi przeżyć scalanie.
    await profileRepo.patch({ goal: 'bulk' })

    const result = await importBackup(backup, 'merge')
    expect(result.skipped['profiles']).toBe(1)
    expect((await profileRepo.get())?.goal).toBe('bulk')
    expect((await profileRepo.get())?.id).toBe(profile.id)
  })

  it('nadpisuje rekord starszy od tego z kopii', async () => {
    await seedProfile()
    await profileRepo.patch({ goal: 'bulk' })
    const backup = await exportBackup()

    // Cofamy lokalny rekord w czasie — kopia jest teraz nowsza.
    const current = await profileRepo.get()
    await db.profiles.put({ ...(current as Profile), goal: 'cut', updatedAt: '2020-01-01T00:00:00.000Z' })

    const result = await importBackup(backup, 'merge')
    expect(result.imported['profiles']).toBe(1)
    expect((await profileRepo.get())?.goal).toBe('bulk')
  })

  it('dokłada rekordy, których lokalnie nie ma, nie ruszając pozostałych', async () => {
    const profile = await seedProfile()
    await weightRepo.upsert(START, 80)
    const backup = await exportBackup()

    // Nowy pomiar tylko lokalnie.
    await weightRepo.upsert('2026-08-10', 78.5)
    await clearProfileOnly(profile.id)

    const result = await importBackup(backup, 'merge')
    expect(result.imported['profiles']).toBe(1)
    // Lokalny pomiar z 10 sierpnia nie może zniknąć.
    expect((await weightRepo.all()).map((e) => e.date)).toContain('2026-08-10')
  })

  it('nie kasuje danych nieobecnych w kopii', async () => {
    const backup = await exportBackup() // pusta baza
    await seedEverything()
    const before = await db.plannedSessions.count()

    await importBackup(backup, 'merge')
    expect(await db.plannedSessions.count()).toBe(before)
  })
})

async function clearProfileOnly(id: string) {
  await db.profiles.delete(id)
}

// ════════════════════════════════════════════════════════════════════
//  Eksport CSV
// ════════════════════════════════════════════════════════════════════

describe('toCsv', () => {
  it('używa średnika — polski Excel nie rozpoznaje przecinka', () => {
    expect(toCsv(['A', 'B'], [[1, 2]])).toBe('A;B\r\n1;2')
  })

  it('zapisuje liczby z przecinkiem dziesiętnym', () => {
    expect(toCsv(['Masa'], [[79.4]])).toBe('Masa\r\n79,4')
  })

  it('cytuje komórki zawierające separator, cudzysłów lub nową linię', () => {
    expect(toCsv(['A'], [['x;y']])).toBe('A\r\n"x;y"')
    expect(toCsv(['A'], [['on rzekł "tak"']])).toBe('A\r\n"on rzekł ""tak"""')
    expect(toCsv(['A'], [['dwie\nlinie']])).toBe('A\r\n"dwie\nlinie"')
  })

  it('puste wartości zostają puste, nie „null"', () => {
    expect(toCsv(['A', 'B'], [[null, undefined]])).toBe('A;B\r\n;')
  })
})

describe('eksport historii do CSV', () => {
  it('masa ciała zawiera pomiar i trend', async () => {
    await weightRepo.upsert(START, 80)
    await weightRepo.upsert('2026-08-04', 81)

    const csv = weightCsv(await weightRepo.all())
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('Data;Masa [kg];Trend [kg]')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain(START)
    // Trend tłumi skok — nie może być równy surowemu pomiarowi.
    expect(lines[2]).not.toContain(';81;81')
  })

  it('serie treningowe mają nazwy ćwiczeń i policzoną objętość', async () => {
    const log = await sessionLogRepo.record(
      { plannedSessionId: null, date: START, type: 'strength', status: 'done' },
      [{ exerciseId: 'a1-hip-thrust-ze-sztanga', setIndex: 0, reps: 8, weightKg: 80, rpe: 7 }],
    )
    const sets = await sessionLogRepo.setsForSession(log.id)
    const csv = setLogCsv(await sessionLogRepo.all(), sets)

    expect(csv).toContain('Hip Thrust ze sztangą')
    expect(csv).toContain('640') // 8 × 80 kg
  })

  it('cardio ma policzone tempo w formacie min/km', async () => {
    const log = await sessionLogRepo.recordCardio(
      { plannedSessionId: null, date: START, type: 'run', status: 'done' },
      { distanceM: 6000, durationSec: 1980, avgHr: 150 },
    )
    expect(log.id).toBeTruthy()
    const csv = cardioCsv(await sessionLogRepo.all(), await sessionLogRepo.allCardio())
    // 1980 s / 6 km = 330 s/km = 5:30
    expect(csv).toContain('5:30')
  })

  it('posiłki rozróżniają wpisy z planu i odstępstwa', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START))[0]!
    await mealLogRepo.logFromPlan(START, meal.slot, meal.id, meal.computed)
    await mealLogRepo.logManual(START, 'snack', 'pizza', {
      kcal: 900,
      proteinG: 35,
      fatG: 40,
      carbsG: 95,
    })

    const csv = mealLogCsv(await mealLogRepo.byDate(START))
    expect(csv).toContain('z planu')
    expect(csv).toContain('poza planem')
    expect(csv).toContain('pizza')
  })

  it('KRYTYCZNE: kolumny są po polsku, nie kluczami z kodu', async () => {
    /**
     * Nagłówki eksportu są polskie („Posiłek", „Status", „Dyscyplina"), a wartości
     * były surowymi kluczami: `lunch`, `snack`, `other`, `done`, `run`. W arkuszu
     * u użytkownika wyglądało to jak przeciek z kodu — zwłaszcza `other`.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'dinner')!
    await mealLogRepo.logFromPlan(START, meal.slot, meal.id, meal.computed)
    await mealLogRepo.logManual(START, 'other', 'obiad na mieście', {
      kcal: 700,
      proteinG: 30,
      fatG: 30,
      carbsG: 60,
    })

    const meals = mealLogCsv(await mealLogRepo.byDate(START))
    expect(meals).toContain('Kolacja')
    expect(meals).toContain('Poza planem')
    expect(meals).not.toMatch(/;(lunch|afternoon|snack|dinner|other);/)

    await sessionLogRepo.recordCardio(
      { plannedSessionId: null, date: START, type: 'run', status: 'partial' },
      { distanceM: 5000, durationSec: 1800 },
    )
    const cardio = cardioCsv(await sessionLogRepo.all(), await sessionLogRepo.allCardio())
    expect(cardio).toContain('Bieganie')
    expect(cardio).toContain('Częściowo wykonane')
    expect(cardio).not.toMatch(/;(run|swim|strength);/)
  })

  it('pusta historia daje sam nagłówek, nie wyjątek', () => {
    expect(weightCsv([]).split('\r\n')).toHaveLength(1)
    expect(setLogCsv([], []).split('\r\n')).toHaveLength(1)
    expect(cardioCsv([], []).split('\r\n')).toHaveLength(1)
    expect(mealLogCsv([]).split('\r\n')).toHaveLength(1)
  })
})
