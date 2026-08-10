import { beforeEach, describe, expect, it } from 'vitest'
import type { Profile, RunPayload, SetLog, ShoppingList, StrengthPayload } from '@/domain/types'
import { macros } from '@/domain/calc/macros'
import { DEFAULT_PLAN_WEEKS } from '@/domain/training/planGenerator'
import { MissingPlanInputsError } from '@/domain/training/planInputs'
import { addDays, startOfWeek, todayIso } from '@/domain/dates'
import { DIET_CATALOG, WORKOUT_EXERCISES_BY_ID, exercisePlacement } from '@/lib/catalog'
import { normalize } from '@/domain/text'
import { isSeasoning } from '@/domain/shopping/aggregate'
import { canonicalIngredientName, dropFromShoppingList } from '@/domain/shopping/canonical'
import { db, newId, stamp } from './db'
import {
  bodyMeasurementRepo,
  mealLogRepo,
  profileRepo,
  sessionLogRepo,
  weightRepo,
} from './repositories'
import { applyWeekProgression, planRepo, refreshWeekFromHistory, resyncPlan } from './planRepo'
import { DIET_HISTORY_WEEKS, dietRepo } from './dietRepo'
import { shoppingRepo } from './shoppingRepo'

/**
 * Start w SOBOTĘ — tydzień aplikacji zaczyna się w sobotę, więc plan
 * rozpoczęty w środku tygodnia byłby częściowy i liczby sesji przestałyby
 * być wielokrotnością siódemki. To jest właściwość planu, nie testu.
 */
const START = '2026-08-01'
/**
 * Cel testowy w środku zakresu bazy (2750 kcal, ~85 kg).
 *
 * Poza tym zakresem solver dobija do granicy skalowania porcji i traci
 * swobodę — a wtedy testy różnorodności mierzą sufit bazy, nie logikę
 * wykluczeń, którą mają sprawdzać.
 */
const TARGETS = macros({ kcal: 2750, goal: 'bulk', weightKg: 85, heightCm: 180 }).macros

function profileInput(patch: Partial<Profile> = {}) {
  const base = {
    name: 'Test',
    birthYear: 1996,
    sex: 'male' as const,
    heightCm: 180,
    startWeightKg: 80,
    goal: 'cut' as const,
    activityLevel: 'moderate' as const,
    experience: 'intermediate' as const,
    equipment: ['gym', 'dumbbells', 'home', 'running'] as Profile['equipment'],
    availableDays: [1, 2, 4, 5] as Profile['availableDays'],
    emphasis: 'balanced' as const,
    sessionMinutes: 60,
    // Punkt wyjścia w cardio jest warunkiem wygenerowania planu — bez niego
    // `generateAndSave` odmawia (patrz `missingPlanInputs`).
    runBaseline: { distanceM: 6000, paceSecPerKm: 330 },
    swimBaseline: { laps: 20, poolLengthM: 25 as const, stroke: 'freestyle' as const },
    diet: {
      style: 'omnivore' as const,
      allergens: [],
      dislikedTags: [],
      excludedProductIds: [],
    },
    cooking: { weekdayMinutes: 45, prepStyle: 'daily' as const },
    injuries: [] as Profile['injuries'],
    mealSplit: { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 },
    kcalOverride: null,
  }
  return { ...base, ...patch }
}

/**
 * Ciężar startowy z arkusza trenera.
 *
 * Plan NIE startuje już od pustego pola: dopóki nie ma historii, sesja pokazuje
 * ciężar, który wpisał trener („30 kg (Gryf + 2x5kg)"). Testy porównują się więc
 * z arkuszem, a nie z `null` — `null` zostaje tylko tam, gdzie arkusz nie podaje
 * liczby (masa własnego ciała, gryf o nieznanej masie, asysta maszyny).
 */
function sheetWeight(exerciseId: string): number | null {
  return WORKOUT_EXERCISES_BY_ID.get(exerciseId)?.startWeightKg ?? null
}

async function seedProfile(patch: Partial<Profile> = {}): Promise<Profile> {
  return profileRepo.save(profileInput(patch))
}

beforeEach(async () => {
  await db.transaction(
    'rw',
    db.tables,
    async () => {
      for (const table of db.tables) await table.clear()
    },
  )
})

// ════════════════════════════════════════════════════════════════════
//  Profil i pomiary
// ════════════════════════════════════════════════════════════════════

describe('profileRepo', () => {
  it('zapisuje i odczytuje jeden profil', async () => {
    const saved = await seedProfile()
    const loaded = await profileRepo.get()
    expect(loaded?.id).toBe(saved.id)
    expect(loaded?.name).toBe('Test')
  })

  it('kolejny zapis aktualizuje ten sam rekord, nie tworzy drugiego', async () => {
    const first = await seedProfile()
    await profileRepo.save(profileInput({ name: 'Zmienione' }))
    expect(await db.profiles.count()).toBe(1)
    const loaded = await profileRepo.get()
    expect(loaded?.id).toBe(first.id)
    expect(loaded?.name).toBe('Zmienione')
  })

  it('patch podnosi updatedAt', async () => {
    const saved = await seedProfile()
    const patched = await profileRepo.patch({ goal: 'bulk' })
    expect(patched).toBeDefined()
    expect(patched?.goal).toBe('bulk')
    expect((patched as Profile).updatedAt >= saved.updatedAt).toBe(true)
  })
})

describe('weightRepo', () => {
  it('trzyma jeden pomiar na dzień', async () => {
    await weightRepo.upsert('2026-08-03', 80)
    await weightRepo.upsert('2026-08-03', 79.5)
    const all = await weightRepo.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.weightKg).toBe(79.5)
  })

  it('sortuje po dacie', async () => {
    await weightRepo.upsert('2026-08-05', 79)
    await weightRepo.upsert('2026-08-03', 80)
    expect((await weightRepo.all()).map((e) => e.date)).toEqual(['2026-08-03', '2026-08-05'])
  })

  it('usuwa miękko — rekord zostaje w bazie', async () => {
    const entry = await weightRepo.upsert('2026-08-03', 80)
    await weightRepo.softDelete(entry.id)
    expect(await weightRepo.all()).toHaveLength(0)
    expect(await db.weightEntries.count()).toBe(1)
  })

  it('po usunięciu można zapisać ten dzień ponownie', async () => {
    const entry = await weightRepo.upsert('2026-08-03', 80)
    await weightRepo.softDelete(entry.id)
    await weightRepo.upsert('2026-08-03', 78)
    const all = await weightRepo.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.weightKg).toBe(78)
  })

  it('odrzuca niedodatnią wagę', async () => {
    await expect(weightRepo.upsert('2026-08-03', 0)).rejects.toThrow(RangeError)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Plan treningowy — niezmiennik rozdzielenia planu od logu
// ════════════════════════════════════════════════════════════════════

describe('planRepo', () => {
  it('zapisuje plan i wszystkie sesje', async () => {
    const profile = await seedProfile()
    const result = await planRepo.generateAndSave(profile, START, { weeks: 12 })

    expect(result.sessionCount).toBe(12 * 7)
    expect(await db.plannedSessions.count()).toBe(12 * 7)
    expect(result.plan.version).toBe(1)
    expect(result.plan.status).toBe('active')
  })

  it('regeneracja archiwizuje poprzedni plan i podnosi wersję', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const second = await planRepo.generateAndSave(profile, START, { weeks: 4 })

    expect(second.plan.version).toBe(2)
    const active = await planRepo.active()
    expect(active?.id).toBe(second.plan.id)

    const archived = await db.trainingPlans.get(first.plan.id)
    expect(archived?.status).toBe('archived')
    expect(archived?.deletedAt).toBeNull()
  })

  it('KRYTYCZNE: regeneracja planu nie rusza zalogowanych treningów', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const session = (await planRepo.sessionsForWeek(first.plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    expect(session).toBeDefined()

    await sessionLogRepo.record(
      {
        plannedSessionId: session!.id,
        date: session!.date,
        type: 'strength',
        status: 'done',
      },
      [{ exerciseId: 'bench-press', setIndex: 0, reps: 8, weightKg: 80, rpe: 7 }],
    )

    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    const logs = await sessionLogRepo.all()
    expect(logs).toHaveLength(1)
    expect(logs[0]?.plannedSessionId).toBe(session!.id)
    expect(await sessionLogRepo.setsForSession(logs[0]!.id)).toHaveLength(1)
  })

  it('sessionsOnDate zwraca tylko sesje aktywnego planu', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })
    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    const sessions = await planRepo.sessionsOnDate(START)
    const active = await planRepo.active()
    expect(sessions.length).toBeGreaterThan(0)
    expect(sessions.every((s) => s.planId === active?.id)).toBe(true)
  })

  it('nextSession pomija dni odpoczynku', async () => {
    const profile = await seedProfile({ availableDays: [1, 4] })
    await planRepo.generateAndSave(profile, START, { weeks: 4 })
    // 2026-08-05 to środa — dzień wolny przy dniach [pon, czw].
    const next = await planRepo.nextSession('2026-08-05')
    expect(next?.type).not.toBe('rest')
    expect(next?.date).toBe('2026-08-06')
  })

  it('weekIndexOf wskazuje tydzień planu dla daty', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })
    expect(await planRepo.weekIndexOf(START)).toBe(0)
    expect(await planRepo.weekIndexOf(addDays(START, 7))).toBe(1)
    expect(await planRepo.weekIndexOf('2027-01-01')).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════
//  Odnowienie planu — przeniesienie dorobku
// ════════════════════════════════════════════════════════════════════

describe('odnowienie planu', () => {
  /** Loguje sesję siłową z zadanym ciężarem i zwraca użyte ćwiczenie. */
  async function logStrength(planId: string, weightKg: number, date?: string) {
    const week0 = await planRepo.sessionsForWeek(planId, 0)
    const source = week0.find((s) => s.payload.kind === 'strength')
    expect(source, 'plan nie zawiera sesji siłowej').toBeDefined()

    const exercise = (source!.payload as StrengthPayload).exercises[0]!
    await sessionLogRepo.record(
      {
        plannedSessionId: source!.id,
        date: date ?? source!.date,
        type: 'strength',
        status: 'done',
      },
      exercise.sets.map((set, index) => ({
        exerciseId: exercise.exerciseId,
        setIndex: index,
        reps: set.reps,
        weightKg,
        rpe: 7,
      })),
    )
    return exercise.exerciseId
  }

  async function weightInPlan(planId: string, exerciseId: string): Promise<number | null | undefined> {
    for (let week = 0; week < 4; week++) {
      for (const session of await planRepo.sessionsForWeek(planId, week)) {
        if (session.payload.kind !== 'strength') continue
        const match = session.payload.exercises.find((e) => e.exerciseId === exerciseId)
        if (match) return match.sets[0]?.weightKg
      }
    }
    return undefined
  }

  it('KRYTYCZNE: regeneracja przenosi osiągnięte ciężary', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    expect(first.carriedLoadCount).toBe(0)
    const exerciseId = await logStrength(first.plan.id, 90)

    const second = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    expect(second.carriedLoadCount).toBe(1)
    // Bez tego użytkownik po każdej regeneracji odgaduje ciężary od zera.
    expect(await weightInPlan(second.plan.id, exerciseId)).toBe(90)
  })

  it('achievedLoads czyta aktualny ciężar roboczy z logu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const exerciseId = await logStrength(plan.id, 90)

    const loads = await planRepo.achievedLoads()
    expect(loads.get(exerciseId)).toBe(90)
  })

  it('wycofany log nie przenosi ciężaru', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const exerciseId = await logStrength(first.plan.id, 90)

    const logs = await sessionLogRepo.all()
    await sessionLogRepo.undoLog(logs[0]!.id)

    const second = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    expect(second.carriedLoadCount).toBe(0)
    expect(await weightInPlan(second.plan.id, exerciseId)).toBe(sheetWeight(exerciseId))
  })

  it('carryLoads: false pozwala świadomie zacząć od zera', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const exerciseId = await logStrength(first.plan.id, 90)

    const second = await planRepo.generateAndSave(profile, START, {
      weeks: 4,
      carryLoads: false,
    })
    expect(second.carriedLoadCount).toBe(0)
    // „Od zera" znaczy teraz „od arkusza", nie „bez ciężaru".
    expect(await weightInPlan(second.plan.id, exerciseId)).toBe(sheetWeight(exerciseId))
  })

  it('regeneracja w środku cyklu zachowuje pozycję w mezocyklu', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    // Dwa tygodnie później — użytkownik jest w tygodniu 2 (trzeci akumulacji).
    const second = await planRepo.generateAndSave(profile, addDays(START, 14), { weeks: 4 })
    expect(second.blockOffsetWeeks).toBe(2)

    // Kolejny tydzień nowego planu ma być deloadem, nie trzecim akumulacji.
    const week1 = await planRepo.sessionsForWeek(second.plan.id, 1)
    expect(week1.every((s) => s.phase === 'deload')).toBe(true)
  })

  it('odnowienie po zakończeniu planu startuje od czystego rytmu', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    // Plan czterotygodniowy kończy się 2026-08-30; startujemy dzień później.
    const second = await planRepo.generateAndSave(profile, addDays(START, 28), { weeks: 4 })
    expect(second.blockOffsetWeeks).toBe(0)

    const week0 = await planRepo.sessionsForWeek(second.plan.id, 0)
    expect(week0.every((s) => s.phase === 'accumulation')).toBe(true)
  })

  it('preserveBlockPosition: false wyłącza zachowanie pozycji', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const second = await planRepo.generateAndSave(profile, addDays(START, 14), {
      weeks: 4,
      preserveBlockPosition: false,
    })
    expect(second.blockOffsetWeeks).toBe(0)
  })

  it('timeline rozpoznaje wyczerpany plan', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    expect((await planRepo.timeline(START))?.isFinished).toBe(false)
    expect((await planRepo.timeline(addDays(START, 27)))?.isFinalWeek).toBe(true)
    expect((await planRepo.timeline(addDays(START, 28)))?.isFinished).toBe(true)
  })

  it('timeline zwraca null, gdy nie ma planu', async () => {
    expect(await planRepo.timeline(START)).toBeNull()
  })

  it('odnowienie nie rusza historii treningów', async () => {
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    await logStrength(first.plan.id, 90)

    await planRepo.generateAndSave(profile, addDays(START, 28), { weeks: 4 })

    const logs = await sessionLogRepo.all()
    expect(logs).toHaveLength(1)
    expect(await sessionLogRepo.setsForSession(logs[0]!.id)).not.toHaveLength(0)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Automatyczne dopasowanie po zmianie profilu
// ════════════════════════════════════════════════════════════════════

describe('resyncPlan', () => {
  async function setupWithPlan() {
    const profile = await seedProfile({ equipment: ['gym', 'dumbbells', 'home'] })
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    return { profile, plan }
  }

  it('przelicza sesje niewykonane pod nowe ustawienia', async () => {
    /**
     * Zmieniamy PUNKT WYJŚCIA W BIEGANIU, nie kontuzje.
     *
     * Kontuzje przestały zmieniać sesje siłowe — te są z arkusza trenera
     * i aplikacja nic z nich nie wycina (patrz test „kontuzje nie zmieniają
     * treningu z arkusza" w `training.test.ts`). Korekta profilu nadal jednak
     * musi przeliczyć to, co od profilu zależy: dystanse i tempo cardio.
     */
    // Profil ze sprzętem do biegania — inaczej nie ma sesji, którą zmiana
    // punktu wyjścia mogłaby dotknąć.
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const before = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) => JSON.stringify(s.payload))

    const changed = await profileRepo.patch({
      runBaseline: { distanceM: 9000, paceSecPerKm: 300 },
    })
    const summary = await resyncPlan(changed as Profile, START)

    expect(summary).not.toBeNull()
    expect(summary?.updatedSessions).toBeGreaterThan(0)

    const after = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) => JSON.stringify(s.payload))
    expect(after).not.toEqual(before)
  })

  it('KRYTYCZNE: nie rusza sesji, którą już zalogowano', async () => {
    const { plan } = await setupWithPlan()
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    const target = week0.find((s) => s.payload.kind === 'strength')
    expect(target).toBeDefined()
    const frozen = JSON.stringify(target!.payload)

    await sessionLogRepo.record({
      plannedSessionId: target!.id,
      date: target!.date,
      type: 'strength',
      status: 'done',
    })

    const changed = await profileRepo.patch({ injuries: ['knee', 'lowerBack', 'pelvicFloor'] })
    const summary = await resyncPlan(changed as Profile, START)

    expect(summary?.keptLogged).toBeGreaterThanOrEqual(1)
    const reloaded = await planRepo.byId(target!.id)
    expect(JSON.stringify(reloaded?.payload)).toBe(frozen)
  })

  it('nie rusza sesji z przeszłości', async () => {
    const { plan } = await setupWithPlan()
    const week0 = (await planRepo.sessionsForWeek(plan.id, 0)).map((s) => JSON.stringify(s.payload))

    const changed = await profileRepo.patch({ injuries: ['knee', 'lowerBack', 'pelvicFloor'] })
    // Dopasowanie od trzeciego tygodnia — dwa pierwsze to przeszłość.
    const summary = await resyncPlan(changed as Profile, addDays(START, 14))

    expect(summary?.keptPast).toBeGreaterThan(0)
    const after = (await planRepo.sessionsForWeek(plan.id, 0)).map((s) => JSON.stringify(s.payload))
    expect(after).toEqual(week0)
  })

  it('zachowuje identyfikatory sesji, żeby logi nie straciły powiązania', async () => {
    const { plan } = await setupWithPlan()
    const idsBefore = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) => s.id).sort()

    const changed = await profileRepo.patch({ emphasis: 'lowerBody' })
    await resyncPlan(changed as Profile, START)

    const idsAfter = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) => s.id).sort()
    expect(idsAfter).toEqual(idsBefore)
  })

  it('nie tworzy nowej wersji planu', async () => {
    const { plan } = await setupWithPlan()
    const changed = await profileRepo.patch({ emphasis: 'upperBody' })
    await resyncPlan(changed as Profile, START)

    const active = await planRepo.active()
    expect(active?.id).toBe(plan.id)
    expect(active?.version).toBe(plan.version)
    expect(await db.trainingPlans.count()).toBe(1)
  })

  it('zachowuje rytm bloków po dopasowaniu', async () => {
    const profile = await seedProfile({ equipment: ['gym', 'dumbbells', 'home'] })
    await planRepo.generateAndSave(profile, START, { weeks: 4 })
    // Regeneracja w tygodniu 2 zapisuje przesunięcie rytmu.
    const second = await planRepo.generateAndSave(profile, addDays(START, 14), { weeks: 4 })
    expect(second.blockOffsetWeeks).toBe(2)

    const phasesBefore = (await planRepo.sessionsForWeek(second.plan.id, 1)).map((s) => s.phase)

    const changed = await profileRepo.patch({ emphasis: 'lowerBody' })
    await resyncPlan(changed as Profile, addDays(START, 14))

    const phasesAfter = (await planRepo.sessionsForWeek(second.plan.id, 1)).map((s) => s.phase)
    expect(phasesAfter).toEqual(phasesBefore)
  })

  it('zwraca null, gdy nie ma aktywnego planu', async () => {
    const profile = await seedProfile()
    expect(await resyncPlan(profile, START)).toBeNull()
  })
})

describe('dietRepo.resyncFromDate', () => {
  it('przelicza dni bez zalogowanych posiłków', async () => {
    /**
     * Test był LOSOWY: sprawdzał, że zestaw przepisów się zmienił po zejściu
     * z 2207 na 1800 kcal. Oba cele są powyżej sufitu bazy (trzy posiłki dają
     * najwyżej ~1470 kcal), więc w obu wypadkach optimum jest to samo — ten sam
     * dzień był poprawnym wynikiem. Padał raz na kilka uruchomień, bo ziarno
     * solvera zawiera losowy `profile.id`.
     *
     * Sprawdzamy więc to, co jest gwarantowane: dzień został PRZELICZONY (nowe
     * wpisy zamiast starych) i odpowiada nowemu, wyraźnie niższemu celowi.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const before = await dietRepo.mealsOnDate(START)
    const beforeIds = before.map((m) => m.id).sort().join('|')
    const beforeKcal = before.reduce((sum, m) => sum + m.computed.kcal, 0)

    const changed = await profileRepo.patch({ kcalOverride: 2400 })
    const leanerTargets = macros({ kcal: 2400, goal: 'bulk', weightKg: 85, heightCm: 180 }).macros
    const result = await dietRepo.resyncFromDate(changed as Profile, START, leanerTargets)

    expect(result.updatedDays).toContain(START)
    const after = await dietRepo.mealsOnDate(START)
    expect(after).toHaveLength(4)
    expect(after.map((m) => m.id).sort().join('|')).not.toBe(beforeIds)
    expect(after.reduce((sum, m) => sum + m.computed.kcal, 0)).toBeLessThan(beforeKcal)
  })

  it('KRYTYCZNE: pomija dni, na których cokolwiek zalogowano', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START))[0]
    await mealLogRepo.logFromPlan(START, meal!.slot, meal!.id, meal!.computed)
    const frozen = (await dietRepo.mealsOnDate(START)).map((m) => m.recipeId).join('|')

    const leanerTargets = macros({ kcal: 1800, goal: 'cut', weightKg: 80, heightCm: 180 }).macros
    const result = await dietRepo.resyncFromDate(profile, START, leanerTargets)

    expect(result.keptLoggedDays).toContain(START)
    expect(result.updatedDays).not.toContain(START)
    // Zjedzonego obiadu nie da się zmienić.
    expect((await dietRepo.mealsOnDate(START)).map((m) => m.recipeId).join('|')).toBe(frozen)
  })

  it('nie rusza dni przed podaną datą', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const frozen = (await dietRepo.mealsOnDate(START)).map((m) => m.recipeId).join('|')

    const leanerTargets = macros({ kcal: 1800, goal: 'cut', weightKg: 80, heightCm: 180 }).macros
    const result = await dietRepo.resyncFromDate(profile, addDays(START, 3), leanerTargets)

    expect(result.updatedDays).not.toContain(START)
    expect((await dietRepo.mealsOnDate(START)).map((m) => m.recipeId).join('|')).toBe(frozen)
  })

  it('raportuje tygodnie do przebudowy listy zakupów', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const leanerTargets = macros({ kcal: 1800, goal: 'cut', weightKg: 80, heightCm: 180 }).macros
    const result = await dietRepo.resyncFromDate(profile, START, leanerTargets)
    expect(result.affectedWeeks).toContain(startOfWeek(START))
  })
})

// ════════════════════════════════════════════════════════════════════
//  Pętla progresji — obciążenia z danych, nie z kalendarza
// ════════════════════════════════════════════════════════════════════

describe('applyWeekProgression', () => {
  const BASE_WEIGHT = 80

  async function setup() {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    const source = week0.find((s) => s.payload.kind === 'strength')
    expect(source, 'plan nie zawiera sesji siłowej w pierwszym tygodniu').toBeDefined()

    const exercise = (source!.payload as StrengthPayload).exercises[0]!
    return { plan, source: source!, exercise }
  }

  type SetShape = { reps: number; weightKg: number | null; rpe?: number }

  async function logSession(
    source: Awaited<ReturnType<typeof setup>>['source'],
    exercise: Awaited<ReturnType<typeof setup>>['exercise'],
    make: (plannedReps: number) => SetShape,
  ) {
    const sets: Omit<SetLog, 'id' | 'sessionLogId' | 'createdAt' | 'updatedAt' | 'deletedAt'>[] =
      exercise.sets.map((set, index) => ({
        exerciseId: exercise.exerciseId,
        setIndex: index,
        ...make(set.reps),
      }))

    return sessionLogRepo.record(
      { plannedSessionId: source.id, date: source.date, type: 'strength', status: 'done' },
      sets,
    )
  }

  /** Ciężar tego samego ćwiczenia w kolejnym tygodniu. */
  async function targetWeight(
    planId: string,
    dayOfWeek: number,
    exerciseId: string,
  ): Promise<number | null | undefined> {
    const week1 = await planRepo.sessionsForWeek(planId, 1)
    const target = week1.find((s) => s.dayOfWeek === dayOfWeek)
    if (!target || target.payload.kind !== 'strength') return undefined
    return target.payload.exercises.find((e) => e.exerciseId === exerciseId)?.sets[0]?.weightKg
  }

  it('pełne wykonanie przy niskim RPE dokłada obciążenie', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({ reps, weightKg: BASE_WEIGHT, rpe: 7 }))

    const summary = await applyWeekProgression(plan.id, 1)
    expect(summary.entries.some((e) => e.verdict === 'advance')).toBe(true)

    const weight = await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)
    expect(weight).not.toBeNull()
    expect(weight as number).toBeGreaterThan(BASE_WEIGHT)
    expect((weight as number) % 2.5).toBe(0)
  })

  it('KRYTYCZNE: progresja nie kasuje deloadu — tydzień lżejszy zostaje lżejszy', async () => {
    /**
     * REGRESJA na prawdziwym planie. Plan 4-tygodniowy ma deload w czwartym
     * tygodniu (rytm 3 + 1). Po zalogowaniu tygodnia trzeciego progresja
     * wpisywała do deloadu PODNIESIONY ciężar, więc tydzień, którego jedynym
     * zadaniem jest być lżejszym, wychodził cięższy od poprzedniego.
     */
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })

    const deloadWeek = await planRepo.sessionsForWeek(plan.id, 3)
    expect(deloadWeek.every((s) => s.phase === 'deload'), 'czwarty tydzień nie jest deloadem').toBe(
      true,
    )

    const source = (await planRepo.sessionsForWeek(plan.id, 2)).find(
      (s) => s.payload.kind === 'strength',
    )!
    const exercise = (source.payload as StrengthPayload).exercises[0]!
    const accumulationWeight = exercise.sets[0]?.weightKg as number
    const deloadBefore = (
      deloadWeek.find((s) => s.dayOfWeek === source.dayOfWeek)?.payload as StrengthPayload
    ).exercises.find((e) => e.exerciseId === exercise.exerciseId)?.sets[0]?.weightKg as number
    expect(deloadBefore).toBeLessThan(accumulationWeight)

    // Trzeci tydzień wykonany w pełni przy niskim RPE → progresja w górę.
    await sessionLogRepo.record(
      { plannedSessionId: source.id, date: source.date, type: 'strength', status: 'done' },
      exercise.sets.map((set, index) => ({
        exerciseId: exercise.exerciseId,
        setIndex: index,
        reps: set.reps,
        weightKg: accumulationWeight,
        rpe: 7,
      })),
    )

    const summary = await applyWeekProgression(plan.id, 3)
    expect(summary.entries.some((e) => e.verdict === 'advance')).toBe(true)

    const after = (
      (await planRepo.sessionsForWeek(plan.id, 3)).find((s) => s.dayOfWeek === source.dayOfWeek)
        ?.payload as StrengthPayload
    ).exercises.find((e) => e.exerciseId === exercise.exerciseId)!

    const deloadAfter = after.sets[0]?.weightKg as number
    // Sedno: deload pozostaje LŻEJSZY niż tydzień, który go poprzedza.
    expect(deloadAfter, `deload ${deloadAfter} kg vs akumulacja ${accumulationWeight} kg`)
      .toBeLessThan(accumulationWeight)
    // I nadal nosi sygnał progresji: jest cięższy niż deload policzony ze starego ciężaru.
    expect(deloadAfter).toBeGreaterThanOrEqual(deloadBefore)
    // Deload zdejmuje też serię — to się nie zmienia.
    expect(after.sets.length).toBeLessThan(exercise.sets.length)
  })

  it('plan wykonany przy wysokim RPE zostawia obciążenie bez zmian', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({ reps, weightKg: BASE_WEIGHT, rpe: 9.5 }))

    const summary = await applyWeekProgression(plan.id, 1)
    expect(summary.entries.every((e) => e.verdict === 'hold')).toBe(true)
    expect(await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)).toBe(BASE_WEIGHT)
  })

  it('wyraźny niedobór powtórzeń cofa obciążenie', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({
      reps: Math.max(1, reps - 3),
      weightKg: BASE_WEIGHT,
      rpe: 10,
    }))

    const summary = await applyWeekProgression(plan.id, 1)
    expect(summary.entries.every((e) => e.verdict === 'regress')).toBe(true)
    // 90% z 80 kg = 72 kg → zaokrąglone do kroku 2,5 kg
    expect(await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)).toBe(72.5)
  })

  it('nie zmienia tygodnia źródłowego', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({ reps, weightKg: BASE_WEIGHT, rpe: 7 }))
    await applyWeekProgression(plan.id, 1)

    const reloaded = await planRepo.byId(source.id)
    const sets = (reloaded?.payload as StrengthPayload).exercises[0]?.sets
    expect(sets?.[0]?.weightKg).toBe(exercise.sets[0]?.weightKg ?? null)
  })

  it('bez zalogowanej sesji nic nie zmienia', async () => {
    const { plan, source, exercise } = await setup()
    const summary = await applyWeekProgression(plan.id, 1)
    expect(summary.entries).toHaveLength(0)
    expect(summary.updatedSessions).toBe(0)
    expect(await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)).toBe(
      sheetWeight(exercise.exerciseId),
    )
  })

  it('pierwszy tydzień nie ma z czego progresować', async () => {
    const { plan } = await setup()
    const summary = await applyWeekProgression(plan.id, 0)
    expect(summary.entries).toHaveLength(0)
    expect(summary.updatedSessions).toBe(0)
  })

  it('wycofany log jest ignorowany', async () => {
    const { plan, source, exercise } = await setup()
    const log = await logSession(source, exercise, (reps) => ({
      reps,
      weightKg: BASE_WEIGHT,
      rpe: 7,
    }))
    await sessionLogRepo.undoLog(log.id)

    const summary = await applyWeekProgression(plan.id, 1)
    expect(summary.entries).toHaveLength(0)
    expect(await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)).toBe(
      sheetWeight(exercise.exerciseId),
    )
  })

  it('jest idempotentna dla tych samych danych', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({ reps, weightKg: BASE_WEIGHT, rpe: 7 }))

    await applyWeekProgression(plan.id, 1)
    const first = await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)
    await applyWeekProgression(plan.id, 1)
    const second = await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)

    // Progresja liczy się ze ZALOGOWANEGO tygodnia, nie z bieżącego stanu
    // tygodnia docelowego — powtórne wywołanie nie może kumulować przyrostu.
    expect(second).toBe(first)
  })

  it('z pominięciem zalogowanych nie rusza tygodnia, który już się odbył', async () => {
    const { plan, source, exercise } = await setup()
    await logSession(source, exercise, (reps) => ({ reps, weightKg: BASE_WEIGHT, rpe: 7 }))

    // Sesja docelowa też jest już zalogowana — trening się odbył.
    const week1 = await planRepo.sessionsForWeek(plan.id, 1)
    const target = week1.find((s) => s.dayOfWeek === source.dayOfWeek)
    await sessionLogRepo.record(
      { plannedSessionId: target!.id, date: target!.date, type: 'strength', status: 'done' },
      [],
    )

    const summary = await applyWeekProgression(plan.id, 1, { skipLoggedTargets: true })
    expect(summary.updatedSessions).toBe(0)
    expect(await targetWeight(plan.id, source.dayOfWeek, exercise.exerciseId)).toBe(
      sheetWeight(exercise.exerciseId),
    )
  })
})

// ════════════════════════════════════════════════════════════════════
//  Podmiana ćwiczenia na alternatywę z arkusza
// ════════════════════════════════════════════════════════════════════

describe('planRepo.swapExercise', () => {
  async function setup() {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 2 })
    const session = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    expect(session, 'plan nie ma sesji siłowej').toBeDefined()
    const payload = session!.payload as StrengthPayload
    const placement = exercisePlacement(payload.exercises[0]!.exerciseId)
    expect(placement, 'ćwiczenie nie ma miejsca w treningu').toBeDefined()
    return { profile, plan, session: session!, payload, placement: placement! }
  }

  it('KRYTYCZNE: wariant wchodzi do planu z własnymi parametrami', async () => {
    const { session, placement } = await setup()
    const alternative = placement.slot.alternatives[0]!

    const updated = await planRepo.swapExercise(session.id, alternative.id)
    const payload = updated?.payload as StrengthPayload

    expect(payload.exercises[0]?.exerciseId).toBe(alternative.id)
    expect(payload.exercises[0]?.sets).toHaveLength(alternative.sets)
    expect(payload.exercises[0]?.sets[0]?.reps).toBe(alternative.reps)
    expect(payload.exercises[0]?.restSec).toBe(alternative.restSec)
    expect(payload.exercises[0]?.sets[0]?.weightKg).toBe(alternative.startWeightKg)
  })

  it('podmienia TYLKO swoje miejsce w treningu', async () => {
    const { session, payload, placement } = await setup()
    const before = payload.exercises.slice(1).map((e) => e.exerciseId)

    const updated = await planRepo.swapExercise(session.id, placement.slot.alternatives[1]!.id)
    const after = (updated?.payload as StrengthPayload).exercises.slice(1).map((e) => e.exerciseId)

    expect(after).toEqual(before)
  })

  it('przelicza szacowany czas sesji', async () => {
    const { session, payload, placement } = await setup()
    const updated = await planRepo.swapExercise(session.id, placement.slot.alternatives[0]!.id)
    const after = updated?.payload as StrengthPayload
    expect(after.estimatedMinutes).toBeGreaterThan(0)
    // Alternatywa ma inne serie i przerwy, więc czas nie musi być ten sam,
    // ale musi być policzony od nowa, a nie przepisany.
    expect(typeof after.estimatedMinutes).toBe('number')
    expect(after.exercises).toHaveLength(payload.exercises.length)
  })

  it('powrót do ćwiczenia głównego działa tak samo', async () => {
    const { session, placement } = await setup()
    await planRepo.swapExercise(session.id, placement.slot.alternatives[0]!.id)
    const back = await planRepo.swapExercise(session.id, placement.slot.main.id)
    expect((back?.payload as StrengthPayload).exercises[0]?.exerciseId).toBe(
      placement.slot.main.id,
    )
  })

  it('ciężar z logu wygrywa z ciężarem startowym wariantu', async () => {
    const { session, placement } = await setup()
    const alternative = placement.slot.alternatives[0]!

    // Wariant był już kiedyś robiony — plan ma o tym wiedzieć.
    const log = await sessionLogRepo.record(
      { plannedSessionId: null, date: START, type: 'strength', status: 'done' },
      [{ exerciseId: alternative.id, setIndex: 0, reps: 10, weightKg: 24, rpe: 8 }],
    )
    expect(log.id).toBeTruthy()

    const updated = await planRepo.swapExercise(session.id, alternative.id)
    expect((updated?.payload as StrengthPayload).exercises[0]?.sets[0]?.weightKg).toBe(24)
  })

  it('nieznane ćwiczenie i sesja cardio nic nie zmieniają', async () => {
    const { session } = await setup()
    expect(await planRepo.swapExercise(session.id, 'nie-ma-takiego')).toBeUndefined()

    const profile = await profileRepo.get()
    const plan = await planRepo.active()
    const cardio = (await planRepo.sessionsForWeek(plan!.id, 0)).find(
      (s) => s.payload.kind === 'run',
    )
    expect(profile).toBeDefined()
    if (cardio) {
      const placement = exercisePlacement(
        (
          (await planRepo.sessionsForWeek(plan!.id, 0)).find((s) => s.payload.kind === 'strength')!
            .payload as StrengthPayload
        ).exercises[0]!.exerciseId,
      )!
      expect(await planRepo.swapExercise(cardio.id, placement.slot.main.id)).toBeUndefined()
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Dopisywanie kolejnych tygodni
// ════════════════════════════════════════════════════════════════════

describe('planRepo.extendOrGenerate', () => {
  /** Sobota tygodnia, w którym testy biegną — plan musi obejmować „dziś". */
  const thisWeek = () => startOfWeek(todayIso())

  it('KRYTYCZNE: dopisuje kolejne dwa tygodnie do tego samego planu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, thisWeek())
    expect(plan.weeks).toBe(DEFAULT_PLAN_WEEKS)

    const result = await planRepo.extendOrGenerate(profile, todayIso())

    expect(result.mode).toBe('extended')
    expect(result.plan.id).toBe(plan.id)
    expect(result.plan.version).toBe(plan.version)
    expect(result.plan.status).toBe('active')
    expect(result.plan.weeks).toBe(4)
    expect(result.firstWeekIndex).toBe(2)
    expect(result.firstWeekStart).toBe(addDays(thisWeek(), 14))

    // Nowe tygodnie mają sesje, stare zostały nietknięte.
    expect(await planRepo.sessionsForWeek(plan.id, 2)).not.toHaveLength(0)
    expect(await planRepo.sessionsForWeek(plan.id, 3)).not.toHaveLength(0)
    expect(await db.trainingPlans.count()).toBe(1)
  })

  it('KRYTYCZNE: drugie kliknięcie dokłada NASTĘPNE dwa tygodnie', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, thisWeek())

    const first = await planRepo.extendOrGenerate(profile, todayIso())
    const second = await planRepo.extendOrGenerate(profile, todayIso())

    expect(first.plan.weeks).toBe(4)
    expect(second.plan.weeks).toBe(6)
    expect(second.firstWeekIndex).toBe(4)
    expect(second.firstWeekStart).toBe(addDays(thisWeek(), 28))
    // Numeracja tygodni jest ciągła — każdy tydzień ma swoje sesje.
    for (const week of [0, 1, 2, 3, 4, 5]) {
      expect(await planRepo.sessionsForWeek(second.plan.id, week), `tydzień ${week}`).not.toHaveLength(
        0,
      )
    }
  })

  it('daty dopisanych tygodni idą bez przerwy za poprzednimi', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, thisWeek())
    const before = await planRepo.sessionsForWeek(plan.id, 1)
    const lastDate = before.map((s) => s.date).sort()[before.length - 1] as string

    await planRepo.extendOrGenerate(profile, todayIso())
    const after = await planRepo.sessionsForWeek(plan.id, 2)
    const firstDate = after.map((s) => s.date).sort()[0] as string

    expect(firstDate > lastDate).toBe(true)
    expect(firstDate < addDays(lastDate, 8)).toBe(true)
  })

  it('nie rusza zalogowanych treningów ani sesji z poprzednich tygodni', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, thisWeek())
    const session = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )
    await sessionLogRepo.record(
      { plannedSessionId: session!.id, date: session!.date, type: 'strength', status: 'done' },
      [],
    )

    await planRepo.extendOrGenerate(profile, todayIso())

    const reloaded = await planRepo.byId(session!.id)
    expect(reloaded).toBeDefined()
    expect(reloaded?.payload).toEqual(session!.payload)
    expect(await db.sessionLogs.count()).toBe(1)
  })

  it('rytm bloków 3 + 1 biegnie dalej — deload wypada w czwartym tygodniu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, thisWeek())
    const result = await planRepo.extendOrGenerate(profile, todayIso())

    const phaseOf = async (week: number) =>
      (await planRepo.sessionsForWeek(plan.id, week))[0]?.phase

    expect(await phaseOf(0)).toBe('accumulation')
    expect(await phaseOf(1)).toBe('accumulation')
    expect(await phaseOf(2)).toBe('accumulation')
    expect(await phaseOf(3)).toBe('deload')
    expect(result.blockOffsetWeeks).toBe(2)
  })

  it('bez aktywnego planu po prostu generuje plan od dziś', async () => {
    const profile = await seedProfile()
    const result = await planRepo.extendOrGenerate(profile, todayIso())

    expect(result.mode).toBe('created')
    expect(result.plan.weeks).toBe(DEFAULT_PLAN_WEEKS)
    expect(result.plan.version).toBe(1)
  })

  it('gdy plan skończył się przed bieżącym tygodniem, tworzy nowy zamiast dopisywać w przeszłość', async () => {
    const profile = await seedProfile()
    // Plan sprzed czterech tygodni, długość 2 → skończył się dwa tygodnie temu.
    const old = await planRepo.generateAndSave(profile, addDays(thisWeek(), -28))

    const result = await planRepo.extendOrGenerate(profile, todayIso())

    expect(result.mode).toBe('created')
    expect(result.plan.id).not.toBe(old.plan.id)
    expect(result.plan.version).toBe(2)
    // Poprzedni plan trafia do archiwum — to robi `generateAndSave`.
    expect((await db.trainingPlans.get(old.plan.id))?.status).toBe('archived')
  })

  it('odmawia, gdy w profilu brakuje punktu wyjścia w cardio', async () => {
    const profile = await seedProfile({ runBaseline: undefined })
    await expect(planRepo.extendOrGenerate(profile, todayIso())).rejects.toBeInstanceOf(
      MissingPlanInputsError,
    )
  })
})

// ════════════════════════════════════════════════════════════════════
//  Aktualizacja tygodnia z historii
// ════════════════════════════════════════════════════════════════════

describe('refreshWeekFromHistory', () => {
  const BASE_WEIGHT = 80

  async function setupWithLog(rpe: number) {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const source = (await planRepo.sessionsForWeek(plan.id, 0)).find(
      (s) => s.payload.kind === 'strength',
    )!
    const exercise = (source.payload as StrengthPayload).exercises[0]!

    await sessionLogRepo.record(
      { plannedSessionId: source.id, date: source.date, type: 'strength', status: 'done' },
      exercise.sets.map((set, index) => ({
        exerciseId: exercise.exerciseId,
        setIndex: index,
        reps: set.reps,
        weightKg: BASE_WEIGHT,
        rpe,
      })),
    )

    return { profile, plan, source, exercise }
  }

  async function weightIn(planId: string, week: number, dayOfWeek: number, exerciseId: string) {
    const target = (await planRepo.sessionsForWeek(planId, week)).find(
      (s) => s.dayOfWeek === dayOfWeek,
    )
    if (!target || target.payload.kind !== 'strength') return undefined
    return target.payload.exercises.find((e) => e.exerciseId === exerciseId)?.sets[0]?.weightKg
  }

  it('KRYTYCZNE: aktualizacja z historii też nie kasuje deloadu', async () => {
    /**
     * Ta sama pomyłka, druga droga: przycisk „zaktualizuj tydzień z historii"
     * wpisywał pełny ciężar roboczy w tydzień deloadu.
     */
    const { profile, plan, exercise } = await setupWithLog(7)

    const deloadWeek = await planRepo.sessionsForWeek(plan.id, 3)
    expect(deloadWeek.every((s) => s.phase === 'deload')).toBe(true)
    const day = deloadWeek.find((s) => s.payload.kind === 'strength')!.dayOfWeek

    const summary = await refreshWeekFromHistory(profile, 3)
    expect(summary, 'brak podsumowania — tydzień poza planem?').not.toBeNull()
    const weight = (await weightIn(plan.id, 3, day, exercise.exerciseId)) as number

    expect(weight).toBeLessThan(BASE_WEIGHT)
    // Podsumowanie pokazuje ciężar FAKTYCZNIE wpisany, nie ten z historii.
    for (const carried of summary!.carried) {
      if (carried.exerciseId !== exercise.exerciseId) continue
      expect(carried.weightKg).toBe(weight)
    }
  })

  it('KRYTYCZNE: przenosi progresję z poprzedniego tygodnia na wskazany', async () => {
    const { profile, plan, source, exercise } = await setupWithLog(7)

    const summary = await refreshWeekFromHistory(profile, 1)

    expect(summary).not.toBeNull()
    expect(summary?.sourceWeekIndex).toBe(0)
    expect(summary?.progression.some((e) => e.verdict === 'advance')).toBe(true)
    const weight = await weightIn(plan.id, 1, source.dayOfWeek, exercise.exerciseId)
    expect(weight as number).toBeGreaterThan(BASE_WEIGHT)
  })

  it('ustawia ciężary z historii także w tygodniu bez poprzednika', async () => {
    // Tydzień pierwszy planu nie ma z czego progresować, ale historia zna
    // ciężar roboczy — bez tego kroku sesja zostałaby z pustym ciężarem.
    const { profile, plan, source, exercise } = await setupWithLog(7)
    // Przed przeliczeniem tydzień ma ciężar z arkusza, nie z logu.
    expect(await weightIn(plan.id, 2, source.dayOfWeek, exercise.exerciseId)).toBe(
      sheetWeight(exercise.exerciseId),
    )

    const summary = await refreshWeekFromHistory(profile, 2)

    expect(summary?.sourceWeekIndex).toBe(1)
    expect(summary?.carried.map((c) => c.exerciseId)).toContain(exercise.exerciseId)
    expect(await weightIn(plan.id, 2, source.dayOfWeek, exercise.exerciseId)).toBe(BASE_WEIGHT)
  })

  it('KRYTYCZNE: nie rusza sesji, która ma już zapisany trening', async () => {
    const { profile, plan, source, exercise } = await setupWithLog(7)
    const target = (await planRepo.sessionsForWeek(plan.id, 1)).find(
      (s) => s.dayOfWeek === source.dayOfWeek,
    )!
    await sessionLogRepo.record(
      { plannedSessionId: target.id, date: target.date, type: 'strength', status: 'done' },
      [],
    )

    const summary = await refreshWeekFromHistory(profile, 1)

    expect(summary?.keptLogged).toBeGreaterThan(0)
    expect(await weightIn(plan.id, 1, source.dayOfWeek, exercise.exerciseId)).toBe(
      sheetWeight(exercise.exerciseId),
    )
  })

  it('bez historii nie ma czego przeliczać', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 4 })

    const summary = await refreshWeekFromHistory(profile, 1)

    expect(summary?.updatedSessions).toBe(0)
    expect(summary?.progression).toHaveLength(0)
    expect(summary?.carried).toHaveLength(0)
  })

  it('tydzień poza planem daje null, nie wyjątek', async () => {
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START, { weeks: 2 })

    expect(await refreshWeekFromHistory(profile, 9)).toBeNull()
    expect(await refreshWeekFromHistory(profile, -1)).toBeNull()
  })

  it('bez planu daje null', async () => {
    const profile = await seedProfile()
    expect(await refreshWeekFromHistory(profile, 0)).toBeNull()
  })

  it('podnosi dystans biegu, gdy log pobił deklarację z profilu', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const run = (await planRepo.sessionsForWeek(plan.id, 1)).find((s) => s.payload.kind === 'run')
    expect(run, 'plan nie zawiera biegu w drugim tygodniu').toBeDefined()
    const plannedDistance = (run!.payload as RunPayload).distanceM

    // Odbyta sesja dłuższa niż punkt wyjścia z profilu (6000 m).
    await sessionLogRepo.recordCardio(
      { plannedSessionId: null, date: addDays(START, 1), type: 'run', status: 'done' },
      { distanceM: 9000, durationSec: 3000 },
    )

    const summary = await refreshWeekFromHistory(profile, 1)

    expect(summary?.cardioFromLogs.run?.distanceM).toBe(9000)
    expect(summary?.cardioSessions).toBeGreaterThan(0)
    const after = (await planRepo.sessionsForWeek(plan.id, 1)).find(
      (s) => s.id === run!.id,
    )
    expect((after?.payload as RunPayload).distanceM).toBeGreaterThan(plannedDistance)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Jadłospis
// ════════════════════════════════════════════════════════════════════

describe('dietRepo', () => {
  it('zapisuje 28 posiłków na tydzień — 7 dni × 4 posiłki', async () => {
    const profile = await seedProfile()
    const result = await dietRepo.generateWeek(profile, START, TARGETS)
    expect(result.saved).toBe(28)
    expect(result.failedDates).toEqual([])
    expect(await dietRepo.mealsOnDate(START)).toHaveLength(4)
  })

  /**
   * Cel osiągalny dla bazy z arkusza — wyliczony tak, jak liczy go aplikacja.
   *
   * Cel musi zostawiać solverowi SWOBODĘ. Przy celu przy granicy skalowania
   * porcji solver bierze codziennie najcięższe dania i obiady powtarzają się
   * SAME z siebie — na tym nie da się odróżnić gotowania na zapas od zbiegu
   * okoliczności. 2500 kcal przy 75 kg leży w środku zakresu bazy.
   */
  const BATCH_TARGETS = macros({ kcal: 2500, goal: 'bulk', weightKg: 75, heightCm: 180 }).macros

  /** Ile par kolejnych dni dzieli ten sam obiad. */
  async function identicalLunchPairs(): Promise<number> {
    const lunchOn = async (offset: number) =>
      (await dietRepo.mealsOnDate(addDays(START, offset))).find((m) => m.slot === 'lunch')

    let pairs = 0
    for (const [first, second] of [
      [0, 1],
      [2, 3],
      [4, 5],
    ]) {
      const a = await lunchOn(first as number)
      const b = await lunchOn(second as number)
      if (a && b && a.recipeId === b.recipeId) pairs++
    }
    return pairs
  }

  it('KRYTYCZNE: przy gotowaniu na zapas obiad powtarza się przez dwa dni', async () => {
    const profile = await seedProfile({ cooking: { weekdayMinutes: 90, prepStyle: 'batch' } })
    await dietRepo.generateWeek(profile, START, BATCH_TARGETS)

    expect(await identicalLunchPairs()).toBe(3)

    // Ta sama porcja co do grama — inaczej nie da się ugotować raz na dwa dni.
    const first = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'lunch')
    const second = (await dietRepo.mealsOnDate(addDays(START, 1))).find((m) => m.slot === 'lunch')
    expect(second?.ingredients).toEqual(first?.ingredients)
    expect(second?.computed).toEqual(first?.computed)
  })

  it('KRYTYCZNE: bez gotowania na zapas obiady się nie powtarzają', async () => {
    // Ten sam cel i ta sama baza — różni się WYŁĄCZNIE `prepStyle`, więc każda
    // różnica w wyniku bierze się z tego pola. Bez tego testu wiązanie
    // `prepStyle` → powtarzanie obiadu można usunąć i nic nie zaprotestuje.
    const profile = await seedProfile({ cooking: { weekdayMinutes: 90, prepStyle: 'daily' } })
    await dietRepo.generateWeek(profile, START, BATCH_TARGETS)

    expect(await identicalLunchPairs()).toBeLessThan(3)
  })

  it('każdy posiłek ma zamrożone gramatury i makro', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    for (const meal of await dietRepo.mealsOnDate(START)) {
      expect(meal.ingredients.length).toBeGreaterThan(0)
      expect(meal.computed.kcal).toBeGreaterThan(0)
      for (const ing of meal.ingredients) {
        expect(ing.name, meal.recipeId).toBeTruthy()
        if (ing.amount !== null) expect(ing.amount, ing.name).toBeGreaterThan(0)
      }
    }
  })

  it('regeneracja tygodnia usuwa poprzednie posiłki miękko', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    await dietRepo.generateWeek(profile, START, TARGETS)

    expect(await dietRepo.mealsForWeek(START)).toHaveLength(28)
    expect(await db.plannedMeals.count()).toBe(56) // 28 aktywnych + 28 usuniętych
  })

  it('mealsForWeek nie łapie posiłków z innego tygodnia', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    await dietRepo.generateWeek(profile, addDays(START, 7), TARGETS)

    expect(await dietRepo.mealsForWeek(START)).toHaveLength(28)
    expect(await dietRepo.mealsForWeek(addDays(START, 7))).toHaveLength(28)
  })

  it('zamiennik podmienia posiłek zachowując slot i datę', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)

    const before = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'lunch')
    expect(before).toBeDefined()

    const options = await dietRepo.substitutesFor(profile, START, 'lunch', TARGETS)
    expect(options.length).toBeGreaterThan(0)

    const updated = await dietRepo.replaceMeal(before!.id, options[0]!)
    expect(updated?.slot).toBe('lunch')
    expect(updated?.date).toBe(START)
    expect(updated?.recipeId).toBe(options[0]!.recipeId)
    expect(updated?.recipeId).not.toBe(before!.recipeId)
    expect(updated?.ingredients).toEqual(options[0]!.ingredients)
  })

  it('można wygenerować jadłospis na następny tydzień, nie tylko bieżący', async () => {
    const profile = await seedProfile()
    const nextWeek = addDays(START, 7)

    await dietRepo.generateWeek(profile, START, TARGETS)
    await dietRepo.generateWeek(profile, nextWeek, TARGETS)

    expect(await dietRepo.hasWeek(START)).toBe(true)
    expect(await dietRepo.hasWeek(nextWeek)).toBe(true)

    /**
     * Tygodnie porównujemy JAKO CAŁOŚĆ, nie dzień w dzień.
     *
     * Pojedynczy dzień może wyjść identycznie i to nie jest błąd: przy trzech
     * posiłkach i niewielkim katalogu solver ma po kilka opcji na slot, więc
     * czasem trafia w to samo optimum. Kopią byłby dopiero cały tydzień taki
     * sam — to by znaczyło, że ziarno nie działa. (Powtarzalność menu przy małej
     * bazie przepisów jest znanym długiem, patrz PROGRESS.md.)
     */
    const signature = async (weekStart: string) =>
      (await dietRepo.mealsForWeek(weekStart)).map((m) => `${m.date}:${m.recipeId}`).join('|')

    const thisWeek = await signature(START)
    const other = await signature(nextWeek)
    expect(other.replaceAll(nextWeek.slice(0, 7), '')).not.toBe(
      thisWeek.replaceAll(START.slice(0, 7), ''),
    )
  })

  it('KRYTYCZNE: zamienniki to PEŁNA lista przepisów dla slotu, nie pierwsza piątka', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)

    const options = await dietRepo.substitutesFor(profile, START, 'lunch', TARGETS)

    // Ile przepisów katalogu w ogóle pasuje do obiadu, pomijając ten zaplanowany.
    const current = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'lunch')
    const eligible = DIET_CATALOG.recipes.filter(
      (r) => r.slot === 'lunch' && r.id !== current?.recipeId,
    )

    expect(eligible.length).toBeGreaterThan(5)
    expect(options).toHaveLength(eligible.length)
    // Jeden wariant porcji na przepis — lista jest do wyboru dania, nie gramatury.
    expect(new Set(options.map((o) => o.recipeId)).size).toBe(options.length)
    // Ranking zostaje: pierwsza pozycja to nadal najlepszy zamiennik.
    const capped = await dietRepo.substitutesFor(profile, START, 'lunch', TARGETS, 5)
    expect(capped).toHaveLength(5)
    expect(capped[0]?.recipeId).toBe(options[0]?.recipeId)
  })

  it('KRYTYCZNE: lista zakupów nadąża za zamianą posiłku', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const before = await shoppingRepo.build(START)

    const meal = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'lunch')
    const options = await dietRepo.substitutesFor(profile, START, 'lunch', TARGETS)
    expect(options.length).toBeGreaterThan(0)

    await dietRepo.replaceMeal(meal!.id, options[0]!)
    const after = await shoppingRepo.build(START)

    // Ta sama lista (to samo id), ale zawartość odpowiada nowemu jadłospisowi.
    expect(after.id).toBe(before.id)
    const signature = (list: typeof after) =>
      list.items
        .map((i) => `${i.name}:${i.amount}`)
        .sort()
        .join('|')
    expect(signature(after)).not.toBe(signature(before))

    // I zgadza się co do grama z tym, co jest w zapisanych posiłkach.
    // Klucz po nazwie KANONICZNEJ, bo lista sumuje „Banan" z „Banan dojrzały"
    // i „Oliwę" z „Oliwą z oliwek" — patrz `domain/shopping/canonical.ts`.
    const expected = new Map<string, number | null>()
    for (const m of await dietRepo.mealsForWeek(START)) {
      for (const ing of m.ingredients) {
        if (dropFromShoppingList(ing)) continue
        const key = `${normalize(canonicalIngredientName(ing.name))}|${ing.unit}`
        const current = expected.get(key)
        if (ing.amount === null) {
          if (!expected.has(key)) expected.set(key, null)
        } else {
          expected.set(key, (current ?? 0) + ing.amount)
        }
      }
    }
    for (const item of after.items) {
      const key = `${normalize(item.name)}|${item.unit}`
      expect(item.amount, item.name).toBeCloseTo(expected.get(key) as number, 1)
    }
  })

  it('KRYTYCZNE: cztery tygodnie z rzędu to nie dwa tygodnie w kółko', async () => {
    /**
     * ZGŁOSZENIE: „znów plan zakłada ciągle to samo na obiad".
     *
     * Historia sięgała JEDNEGO tygodnia wstecz, więc tydzień 3 nie wiedział
     * o tygodniu 1 i wracał do jego optimum. Zmierzone: osiem różnych obiadów
     * na 28 dni, każdy po cztery razy — dwa tygodnie na przemian, w nieskończoność.
     * Teraz okno to ±`DIET_HISTORY_WEEKS`.
     */
    const profile = await seedProfile({ cooking: { weekdayMinutes: 90, prepStyle: 'batch' } })
    const weeks = [0, 1, 2, 3].map((i) => addDays(START, i * 7))
    for (const week of weeks) {
      await dietRepo.generateWeek(profile, week, TARGETS)
    }

    const lunches: string[] = []
    for (const week of weeks) {
      const meals = await dietRepo.mealsForWeek(week)
      lunches.push(...meals.filter((m) => m.slot === 'lunch').map((m) => m.recipeId))
    }

    expect(lunches).toHaveLength(28)
    // Gotowanie na zapas daje 16 porcji gotowania na 28 dni; tyle różnych dań
    // jest maksimum. Poniżej dwunastu jadłospis znów zaczyna stać na kilku daniach.
    const distinct = new Set(lunches).size
    expect(distinct, `różnych obiadów: ${distinct}/28 dni`).toBeGreaterThanOrEqual(12)

    // Żaden tydzień nie jest kopią innego.
    const signatures = await Promise.all(
      weeks.map(async (week) =>
        (await dietRepo.mealsForWeek(week))
          .map((m) => m.recipeId)
          .sort()
          .join('|'),
      ),
    )
    expect(new Set(signatures).size, 'któryś tydzień powtarza inny co do przepisu').toBe(4)
  })

  it('KRYTYCZNE: ponowne generowanie tego samego tygodnia daje INNY jadłospis', async () => {
    /**
     * Kto klika „wygeneruj" drugi raz, robi to dlatego, że nie chce tego samego.
     * Wcześniej dostawał identyczny tydzień: solver dostaje to samo zadanie
     * i wraca do tego samego minimum, a ziarno zmienia tylko punkty startowe
     * spadku współrzędnych, nie wynik. Porzucone podejścia wchodzą teraz
     * do wykluczeń.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const first = (await dietRepo.mealsForWeek(START)).map((m) => m.recipeId)

    await dietRepo.generateWeek(profile, START, TARGETS)
    const second = (await dietRepo.mealsForWeek(START)).map((m) => m.recipeId)

    expect(second).toHaveLength(first.length)
    expect(second.join('|')).not.toBe(first.join('|'))
    // I nie jest to przetasowanie tych samych dań — większość jest nowa.
    const fresh = second.filter((id) => !first.includes(id))
    expect(fresh.length, `nowych dań: ${fresh.length}/${second.length}`).toBeGreaterThan(
      second.length / 2,
    )
  })

  it('po miesiącu danie może wrócić — okno historii nie jest wieczne', async () => {
    // Wykluczanie wszystkiego na zawsze wyczerpałoby bazę (~40 przepisów na slot)
    // i wpadło w awaryjny powrót do pełnej listy, czyli w to samo, co naprawiamy.
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const old = (await dietRepo.mealsForWeek(START)).map((m) => m.recipeId)

    const farAway = addDays(START, (DIET_HISTORY_WEEKS + 1) * 7)
    const excluded = await dietRepo.recentRecipeIds(farAway)
    for (const id of old) {
      expect(excluded, `${id} nadal wykluczony po ${DIET_HISTORY_WEEKS + 1} tygodniach`).not.toContain(id)
    }

    // A tydzień w oknie — owszem, wykluczony.
    const nearby = await dietRepo.recentRecipeIds(addDays(START, 7))
    expect(old.every((id) => nearby.includes(id))).toBe(true)
  })

  it('KRYTYCZNE: usunięcie posiłku zdejmuje jego składniki z listy zakupów', async () => {
    /**
     * Bez tego idziesz do sklepu po składniki dania, którego nie ma już w planie.
     * Lista jest materializowana (odhaczenia muszą przeżyć zamknięcie aplikacji),
     * więc musi ją przebudować ktoś, kto wie o zmianie — `rebuildIfExists`.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const before = await shoppingRepo.build(START)

    const meal = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'dinner')!
    const own = meal.ingredients.map((i) => i.name)
    expect(own.length).toBeGreaterThan(0)

    expect(await dietRepo.removeMeal(meal.id)).toBe(true)
    const after = await shoppingRepo.rebuildIfExists(START)

    // Ta sama lista, mniejsze ilości.
    expect(after?.id).toBe(before.id)
    expect(await dietRepo.mealsOnDate(START)).toHaveLength(3)

    // Składnik używany TYLKO w usuniętym posiłku znika; wspólny maleje.
    const rest = await dietRepo.mealsForWeek(START)
    const stillUsed = new Set(
      rest.flatMap((m) => m.ingredients.map((i) => normalize(canonicalIngredientName(i.name)))),
    )
    for (const name of own) {
      const key = normalize(canonicalIngredientName(name))
      const item = after?.items.find((i) => normalize(i.name) === key)
      if (stillUsed.has(key)) continue
      expect(item, `${name} został na liście po usunięciu posiłku`).toBeUndefined()
    }
    const total = (list: typeof before | undefined) =>
      (list?.items ?? []).filter((i) => i.unit === 'g').reduce((sum, i) => sum + (i.amount ?? 0), 0)
    expect(total(after)).toBeLessThan(total(before))
  })

  it('KRYTYCZNE: nie usuwa posiłku, który jest już zjedzony', async () => {
    /**
     * Log jest nienaruszalny i wlicza się do bilansu dnia. Po skasowaniu planu
     * kalorie nadal by się liczyły, tylko nie byłoby ich przy czym pokazać.
     * Kolejność jest naturalna: najpierw „Cofnij", potem „Usuń".
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START))[0]!
    const log = await mealLogRepo.logFromPlan(START, meal.slot, meal.id, meal.computed)

    expect(await dietRepo.removeMeal(meal.id)).toBe(false)
    expect((await dietRepo.mealsOnDate(START)).some((m) => m.id === meal.id)).toBe(true)

    // Po cofnięciu wpisu usunięcie przechodzi.
    await mealLogRepo.softDelete(log.id)
    expect(await dietRepo.removeMeal(meal.id)).toBe(true)
    expect((await dietRepo.mealsOnDate(START)).some((m) => m.id === meal.id)).toBe(false)
  })

  it('wstawia posiłek w pusty slot i nie rusza zajętego', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START)).find((m) => m.slot === 'lunch')!
    await dietRepo.removeMeal(meal.id)

    // Propozycje działają też dla dnia z dziurą — to jedyna droga powrotna.
    const options = await dietRepo.substitutesFor(profile, START, 'lunch', TARGETS)
    expect(options.length).toBeGreaterThan(0)

    const added = await dietRepo.addMeal(START, 'lunch', options[0]!)
    expect(added?.slot).toBe('lunch')
    expect(added?.recipeId).toBe(options[0]!.recipeId)
    expect(await dietRepo.mealsOnDate(START)).toHaveLength(4)

    // Zajęty slot zostaje nietknięty — dwa posiłki w jednym slocie rozjechałyby
    // sumy dnia i listę zakupów.
    expect(await dietRepo.addMeal(START, 'lunch', options[1]!)).toBeUndefined()
    expect(await dietRepo.mealsOnDate(START)).toHaveLength(4)
  })

  it('usunięcie wszystkich posiłków dnia zostawia resztę tygodnia', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    for (const meal of await dietRepo.mealsOnDate(START)) {
      expect(await dietRepo.removeMeal(meal.id)).toBe(true)
    }

    expect(await dietRepo.mealsOnDate(START)).toHaveLength(0)
    expect(await dietRepo.hasWeek(START)).toBe(true)
    expect((await dietRepo.mealsForWeek(START)).length).toBeGreaterThan(0)
  })

  it('raportuje dni bez rozwiązania zamiast rzucać wyjątkiem', async () => {
    // Wegańskie śniadania i przekąski opierają się na chlebie i tofu.
    const profile = await seedProfile({
      diet: {
        style: 'vegan',
        allergens: ['gluten', 'soy'],
        dislikedTags: [],
        excludedProductIds: [],
      },
    })
    const result = await dietRepo.generateWeek(profile, START, TARGETS)
    expect(result.saved).toBe(0)
    expect(result.failedDates).toHaveLength(7)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Log posiłków
// ════════════════════════════════════════════════════════════════════

describe('mealLogRepo', () => {
  it('loguje posiłek z planu z jego makro', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const meal = (await dietRepo.mealsOnDate(START))[0]!

    await mealLogRepo.logFromPlan(START, meal.slot, meal.id, meal.computed)
    const logs = await mealLogRepo.byDate(START)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.source).toBe('plan')
    expect(logs[0]?.plannedMealId).toBe(meal.id)
    expect(logs[0]?.macros).toEqual(meal.computed)
  })

  it('loguje odstępstwo od planu jako wpis ręczny', async () => {
    await mealLogRepo.logManual(START, 'snack', 'pizza', {
      kcal: 900,
      proteinG: 35,
      fatG: 40,
      carbsG: 95,
    })
    const logs = await mealLogRepo.byDate(START)
    expect(logs[0]?.source).toBe('manual')
    expect(logs[0]?.label).toBe('pizza')
    expect(logs[0]?.plannedMealId).toBeNull()
  })

  it('sumuje spożycie z planu i z odstępstw razem', async () => {
    await mealLogRepo.logManual(START, 'afternoon', 'a', {
      kcal: 400,
      proteinG: 20,
      fatG: 10,
      carbsG: 50,
    })
    await mealLogRepo.logManual(START, 'lunch', 'b', {
      kcal: 600,
      proteinG: 30,
      fatG: 20,
      carbsG: 60,
    })
    const consumed = await mealLogRepo.consumedOn(START)
    expect(consumed.kcal).toBe(1000)
    expect(consumed.proteinG).toBe(50)
  })

  it('dailyIntake agreguje po dniach i sortuje — wejście adaptacyjnego TDEE', async () => {
    await mealLogRepo.logManual('2026-08-04', 'lunch', 'b', {
      kcal: 600,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
    })
    await mealLogRepo.logManual('2026-08-03', 'lunch', 'a', {
      kcal: 500,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
    })
    await mealLogRepo.logManual('2026-08-03', 'dinner', 'c', {
      kcal: 700,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
    })

    expect(await mealLogRepo.dailyIntake()).toEqual([
      { date: '2026-08-03', kcal: 1200 },
      { date: '2026-08-04', kcal: 600 },
    ])
  })

  it('usunięty log nie wlicza się do spożycia, ale zostaje w bazie', async () => {
    const log = await mealLogRepo.logManual(START, 'snack', 'x', {
      kcal: 300,
      proteinG: 0,
      fatG: 0,
      carbsG: 0,
    })
    await mealLogRepo.softDelete(log.id)
    expect((await mealLogRepo.consumedOn(START)).kcal).toBe(0)
    expect(await db.mealLogs.count()).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Log treningów
// ════════════════════════════════════════════════════════════════════

describe('sessionLogRepo', () => {
  it('zapisuje serie per seria, nie per ćwiczenie', async () => {
    const log = await sessionLogRepo.record(
      { plannedSessionId: null, date: START, type: 'strength', status: 'done' },
      [
        { exerciseId: 'bench-press', setIndex: 0, reps: 8, weightKg: 80, rpe: 7 },
        { exerciseId: 'bench-press', setIndex: 1, reps: 8, weightKg: 80, rpe: 8 },
        { exerciseId: 'bench-press', setIndex: 2, reps: 7, weightKg: 80, rpe: 9 },
      ],
    )
    const sets = await sessionLogRepo.setsForSession(log.id)
    expect(sets).toHaveLength(3)
    expect(sets.map((s) => s.setIndex).sort()).toEqual([0, 1, 2])
    expect(sets.find((s) => s.setIndex === 2)?.reps).toBe(7)
  })

  it('zapisuje sesję cardio wraz z pomiarem dystansu', async () => {
    const log = await sessionLogRepo.recordCardio(
      { plannedSessionId: null, date: START, type: 'run', status: 'done', durationMin: 32 },
      { distanceM: 6200, durationSec: 1920, avgHr: 152 },
    )
    const cardio = await sessionLogRepo.cardioForSession(log.id)
    expect(cardio?.distanceM).toBe(6200)
    expect(cardio?.avgHr).toBe(152)
  })

  it('markStatus tworzy log, a powtórne wywołanie go aktualizuje', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })
    const session = (await planRepo.sessionsForWeek(plan.id, 0)).find((s) => s.type !== 'rest')!

    await sessionLogRepo.markStatus(session.id, session.date, session.type, 'skipped')
    await sessionLogRepo.markStatus(session.id, session.date, session.type, 'done')

    const logs = await sessionLogRepo.byDate(session.date)
    expect(logs).toHaveLength(1)
    expect(logs[0]?.status).toBe('done')
  })

  it('undoLog wycofuje wpis wraz z seriami, ale nic nie kasuje twardo', async () => {
    const log = await sessionLogRepo.record(
      { plannedSessionId: null, date: START, type: 'strength', status: 'done' },
      [{ exerciseId: 'bench-press', setIndex: 0, reps: 8, weightKg: 80 }],
    )
    await sessionLogRepo.undoLog(log.id)

    expect(await sessionLogRepo.byDate(START)).toHaveLength(0)
    expect(await sessionLogRepo.setsForSession(log.id)).toHaveLength(0)
    expect(await db.sessionLogs.count()).toBe(1)
    expect(await db.setLogs.count()).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Lista zakupów
// ════════════════════════════════════════════════════════════════════

describe('shoppingRepo', () => {
  it('buduje listę z zapisanego jadłospisu', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const list = await shoppingRepo.build(START)

    expect(list.weekStart).toBe(startOfWeek(START))
    expect(list.items.length).toBeGreaterThan(0)
    // Przypraw na liście nie ma — zostały w karcie posiłku.
    expect(list.items.every((i) => !isSeasoning(i.name))).toBe(true)
  })

  it('przebudowa zachowuje odhaczone pozycje', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const list = await shoppingRepo.build(START)
    const target = list.items[0]!

    await shoppingRepo.toggleItem(list.id, target, true)
    const rebuilt = await shoppingRepo.build(START)

    expect(rebuilt.id).toBe(list.id)
    expect(rebuilt.items.find((i) => i.name === target.name)?.checked).toBe(true)
  })

  it('KRYTYCZNE: odhaczenie trafia w jedną pozycję, nie we wszystkie o tej nazwie', async () => {
    /**
     * Ten sam składnik potrafi stać na liście dwa razy w różnych jednostkach —
     * arkusz podaje czosnek i „do smaku", i w ząbkach. Przy kluczu z samej
     * nazwy odhaczenie jednej pozycji odhaczało obie, a lista renderowała dwa
     * wiersze o tym samym `key` w Reakcie: po przebudowie zostawał na ekranie
     * duch pozycji, której już nie było w bazie.
     */
    const now = stamp()
    const list: ShoppingList = {
      id: newId(),
      weekStart: startOfWeek(START),
      items: [
        { name: 'Czosnek', amount: null, unit: 'g', category: 'Owoce i warzywa', checked: false },
        { name: 'Czosnek', amount: 2, unit: 'piece', category: 'Owoce i warzywa', checked: false },
      ],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    await db.shoppingLists.put(list)

    await shoppingRepo.toggleItem(list.id, { name: 'Czosnek', unit: 'piece' }, true)

    const after = await shoppingRepo.forWeek(START)
    expect(after?.items.find((i) => i.unit === 'piece')?.checked).toBe(true)
    expect(after?.items.find((i) => i.unit === 'g')?.checked).toBe(false)
  })

  it('KRYTYCZNE: rebuildIfExists nie TWORZY listy, której nie było', async () => {
    /**
     * Tą drogą idą zmiany jadłospisu (usunięcie posiłku, podmiana, zapis
     * profilu). Gdyby budowała listę od zera, edycja dnia zakładałaby listę
     * zakupów komuś, kto nigdy o nią nie poprosił — i pojawiłaby się na ekranie
     * jako rzecz do odhaczania.
     */
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)

    expect(await shoppingRepo.forWeek(START)).toBeUndefined()
    expect(await shoppingRepo.rebuildIfExists(START)).toBeUndefined()
    expect(await shoppingRepo.forWeek(START)).toBeUndefined()

    // Gdy lista istnieje, przebudowuje TĘ SAMĄ (to samo id, zachowane odhaczenia).
    const built = await shoppingRepo.build(START)
    await shoppingRepo.toggleItem(built.id, built.items[0]!, true)
    const rebuilt = await shoppingRepo.rebuildIfExists(START)
    expect(rebuilt?.id).toBe(built.id)
    expect(rebuilt?.items.find((i) => i.name === built.items[0]!.name)?.checked).toBe(true)
  })

  it('odznaczenie wszystkiego czyści stan', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const list = await shoppingRepo.build(START)
    await shoppingRepo.toggleItem(list.id, list.items[0]!, true)
    await shoppingRepo.clearChecks(list.id)

    const after = await shoppingRepo.forWeek(START)
    expect(after?.items.every((i) => !i.checked)).toBe(true)
  })

  it('ensure nie buduje listy, gdy nie ma jadłospisu', async () => {
    expect(await shoppingRepo.ensure(START)).toBeUndefined()
  })

  it('ensure buduje listę raz i potem ją zwraca', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    const first = await shoppingRepo.ensure(START)
    const second = await shoppingRepo.ensure(START)
    expect(first?.id).toBe(second?.id)
    expect(await db.shoppingLists.count()).toBe(1)
  })

  it('tydzień zakupowy zaczyna się w sobotę', async () => {
    const profile = await seedProfile()
    await dietRepo.generateWeek(profile, START, TARGETS)
    await shoppingRepo.build(START)
    // Wtorek trafia do listy z poprzedzającej go soboty, nie z poniedziałku.
    const list = await shoppingRepo.forWeek('2026-08-04')
    expect(list?.weekStart).toBe('2026-08-01')
    // Piątek to jeszcze ten sam tydzień, kolejna sobota to już następny.
    expect((await shoppingRepo.forWeek('2026-08-07'))?.weekStart).toBe('2026-08-01')
    expect(await shoppingRepo.forWeek('2026-08-08')).toBeUndefined()
  })
})

// ════════════════════════════════════════════════════════════════════
//  Punkt wyjścia w cardio — warunek konieczny i progresja z logu
// ════════════════════════════════════════════════════════════════════

describe('bramka danych wejściowych planu', () => {
  it('KRYTYCZNE: bez punktu wyjścia w bieganiu plan się nie tworzy', async () => {
    const profile = await seedProfile({ runBaseline: undefined })
    await expect(planRepo.generateAndSave(profile, START)).rejects.toThrow(MissingPlanInputsError)
    // Odmowa musi być czysta: żadnego planu ani sesji w bazie.
    expect(await db.trainingPlans.count()).toBe(0)
    expect(await db.plannedSessions.count()).toBe(0)
  })

  it('bez liczby długości basenu plan też się nie tworzy', async () => {
    const profile = await seedProfile({
      equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
      swimBaseline: undefined,
    })
    await expect(planRepo.generateAndSave(profile, START)).rejects.toThrow(MissingPlanInputsError)
  })

  it('wymaga tylko tych dyscyplin, które użytkownik zgłosił', async () => {
    // Sam dom i hantle — pytanie o tempo biegu byłoby absurdem.
    const profile = await seedProfile({
      equipment: ['home', 'dumbbells'],
      runBaseline: undefined,
      swimBaseline: undefined,
    })
    const result = await planRepo.generateAndSave(profile, START)
    expect(result.plan.weeks).toBe(DEFAULT_PLAN_WEEKS)
  })

  it('resyncPlan zostawia plan w spokoju, gdy dane wejściowe zniknęły', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START)
    const before = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) =>
      JSON.stringify(s.payload),
    )

    const broken = await profileRepo.patch({ runBaseline: undefined })
    expect(await resyncPlan(broken as Profile, START)).toBeNull()

    const after = (await planRepo.sessionsForWeek(plan.id, 1)).map((s) => JSON.stringify(s.payload))
    expect(after).toEqual(before)
  })
})

describe('plan na dwa tygodnie z odbytych treningów', () => {
  it('domyślny horyzont to dwa tygodnie', async () => {
    const profile = await seedProfile()
    const result = await planRepo.generateAndSave(profile, START)
    expect(result.plan.weeks).toBe(2)
    expect(result.sessionCount).toBe(2 * 7)
  })

  it('KRYTYCZNE: rytm 3 + 1 biegnie dalej przez kolejne dwutygodniowe plany', async () => {
    // Regresja: przesunięcie liczone z pozycji w POPRZEDNIM planie dawało zero
    // po jego zakończeniu, więc każdy nowy plan startował od akumulacji,
    // a deload nie wypadał nigdy.
    const profile = await seedProfile()
    await planRepo.generateAndSave(profile, START)

    const second = await planRepo.generateAndSave(profile, addDays(START, 14))
    expect(second.blockOffsetWeeks).toBe(2)
    expect((await planRepo.sessionsForWeek(second.plan.id, 0))[0]?.phase).toBe('accumulation')
    // Czwarty tydzień treningu, licząc od początku, jest deloadem.
    expect((await planRepo.sessionsForWeek(second.plan.id, 1))[0]?.phase).toBe('deload')

    // Trzeci plan otwiera nowy blok akumulacji.
    const third = await planRepo.generateAndSave(profile, addDays(START, 28))
    expect(third.blockOffsetWeeks).toBe(0)
    expect((await planRepo.sessionsForWeek(third.plan.id, 0))[0]?.phase).toBe('accumulation')
  })

  it('dystans biegu bierze się z najdłuższej odbytej sesji', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START)
    const run = (await planRepo.sessionsForWeek(plan.id, 0)).find((s) => s.type === 'run')
    expect(run, 'plan nie zawiera biegu').toBeDefined()

    // 9 km w 54 min = 6:00/km, wyraźnie więcej niż 6 km z profilu.
    await sessionLogRepo.recordCardio(
      { plannedSessionId: run!.id, date: run!.date, type: 'run', status: 'done' },
      { distanceM: 9000, durationSec: 54 * 60 },
    )

    const next = await planRepo.generateAndSave(profile, addDays(START, 14))
    expect(next.cardioFromLogs.run?.distanceM).toBe(9000)
    // Tempo nie może się cofnąć poniżej deklarowanego: bieg spokojny jest
    // z definicji wolniejszy, więc przyjęcie go dokładałoby pół minuty
    // przy każdym odnowieniu planu.
    expect(next.cardioFromLogs.run?.paceSecPerKm).toBe(330)

    const nextRun = (await planRepo.sessionsForWeek(next.plan.id, 0)).find(
      (s) => s.payload.kind === 'run',
    )
    expect((nextRun?.payload as RunPayload).distanceM).toBeGreaterThan(6000)
  })

  it('pominięta sesja nie podnosi punktu wyjścia', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START)
    const run = (await planRepo.sessionsForWeek(plan.id, 0)).find((s) => s.type === 'run')

    await sessionLogRepo.recordCardio(
      { plannedSessionId: run!.id, date: run!.date, type: 'run', status: 'skipped' },
      { distanceM: 20000, durationSec: 60 * 60 },
    )

    const next = await planRepo.generateAndSave(profile, addDays(START, 14))
    expect(next.cardioFromLogs.run).toBeUndefined()
  })

  it('słabsza sesja nie obniża punktu wyjścia', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START)
    const run = (await planRepo.sessionsForWeek(plan.id, 0)).find((s) => s.type === 'run')

    // 3 km zamiast 6 km z profilu — jedna gorsza sesja nie jest nową formą.
    await sessionLogRepo.recordCardio(
      { plannedSessionId: run!.id, date: run!.date, type: 'run', status: 'done' },
      { distanceM: 3000, durationSec: 21 * 60 },
    )

    const next = await planRepo.generateAndSave(profile, addDays(START, 14))
    expect(next.cardioFromLogs.run).toBeUndefined()
  })
})

describe('planRepo.deleteWeek', () => {
  it('usuwa zaplanowane sesje jednego tygodnia, nie ruszając pozostałych', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 4 })

    const summary = await planRepo.deleteWeek(plan.id, 1)
    expect(summary.removed).toBe(7)
    expect(summary.keptLogged).toBe(0)

    expect(await planRepo.sessionsForWeek(plan.id, 1)).toHaveLength(0)
    expect(await planRepo.sessionsForWeek(plan.id, 0)).toHaveLength(7)
    expect(await planRepo.sessionsForWeek(plan.id, 2)).toHaveLength(7)
  })

  it('usuwa MIĘKKO — rekordy zostają w bazie', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 2 })
    await planRepo.deleteWeek(plan.id, 0)

    expect(await planRepo.sessionsForWeek(plan.id, 0)).toHaveLength(0)
    expect(await db.plannedSessions.count()).toBe(2 * 7)
  })

  it('KRYTYCZNE: nie usuwa sesji, do której istnieje log', async () => {
    // Trening, który się odbył, nie przestaje być faktem tylko dlatego, że
    // reszta tygodnia wypada. Log wskazuje na `plannedSessionId`, więc usunięcie
    // sesji zerwałoby powiązanie z historią.
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 2 })
    const week0 = await planRepo.sessionsForWeek(plan.id, 0)
    const logged = week0.find((s) => s.type !== 'rest') as (typeof week0)[number]

    await sessionLogRepo.record({
      plannedSessionId: logged.id,
      date: logged.date,
      type: logged.type,
      status: 'done',
    })

    const summary = await planRepo.deleteWeek(plan.id, 0)
    expect(summary.keptLogged).toBe(1)
    expect(summary.removed).toBe(6)
    expect((await planRepo.sessionsForWeek(plan.id, 0)).map((s) => s.id)).toEqual([logged.id])
  })

  it('pusty tydzień nie jest błędem', async () => {
    const profile = await seedProfile()
    const { plan } = await planRepo.generateAndSave(profile, START, { weeks: 2 })
    await planRepo.deleteWeek(plan.id, 0)
    expect(await planRepo.deleteWeek(plan.id, 0)).toEqual({ removed: 0, keptLogged: 0 })
  })
})

describe('stałość dni i ćwiczeń między planami', () => {
  it('KRYTYCZNE: siłownia, basen i bieganie wypadają w tych samych dniach', async () => {
    const profile = await seedProfile({
      equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
      availableDays: [1, 2, 3, 4, 5, 6, 7],
    })
    const first = await planRepo.generateAndSave(profile, START)
    const second = await planRepo.generateAndSave(profile, addDays(START, 14))

    const shape = async (planId: string, week: number) =>
      (await planRepo.sessionsForWeek(planId, week)).map((s) => `${s.dayOfWeek}:${s.type}`)

    expect(await shape(second.plan.id, 0)).toEqual(await shape(first.plan.id, 0))
  })

  it('KRYTYCZNE: odnowienie planu nie tasuje ćwiczeń', async () => {
    // Rotacja ćwiczeń co dwa tygodnie uniemożliwiłaby ocenę postępu: nie da się
    // porównać, czy przysiad idzie w górę, jeśli przysiadu już nie ma w planie.
    const profile = await seedProfile()
    const first = await planRepo.generateAndSave(profile, START)
    const second = await planRepo.generateAndSave(profile, addDays(START, 14))

    const exerciseIds = async (planId: string) =>
      new Set(
        (await planRepo.sessionsForWeek(planId, 0))
          .filter((s) => s.payload.kind === 'strength')
          .flatMap((s) => (s.payload as StrengthPayload).exercises.map((e) => e.exerciseId)),
      )

    const before = await exerciseIds(first.plan.id)
    const after = await exerciseIds(second.plan.id)
    expect(before.size).toBeGreaterThan(0)
    expect(after.size).toBeGreaterThan(0)

    /**
     * Porównujemy ZBIORY, nie listy: dobór ćwiczeń jest stały, ale ich LICZBA
     * w sesji zależy od budżetu czasowego i fazy mezocyklu — w tygodniu
     * o wyższej objętości mniej ćwiczeń mieści się w 60 minutach. Żadne NOWE
     * ćwiczenie nie może się jednak pojawić, bo to właśnie byłoby przetasowanie.
     */
    for (const id of after) expect([...before], id).toContain(id)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Obwody ciała
// ════════════════════════════════════════════════════════════════════

describe('bodyMeasurementRepo', () => {
  it('trzyma jeden pomiar na dzień', async () => {
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78 })
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 77.5, hipsCm: 100 })

    const all = await bodyMeasurementRepo.all()
    expect(all).toHaveLength(1)
    expect(all[0]?.waistCm).toBe(77.5)
    expect(all[0]?.hipsCm).toBe(100)
  })

  it('nadpisanie czyści miarę pominiętą w formularzu', async () => {
    // Bez tego omyłkowego wpisu nie dałoby się skasować, tylko zmienić.
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78, armCm: 30 })
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78 })

    expect((await bodyMeasurementRepo.onDate('2026-08-01'))?.armCm).toBeUndefined()
  })

  it('odrzuca pusty pomiar', async () => {
    await expect(bodyMeasurementRepo.upsert('2026-08-01', {})).rejects.toThrow(RangeError)
    await expect(bodyMeasurementRepo.upsert('2026-08-01', { waistCm: null })).rejects.toThrow(
      RangeError,
    )
    expect(await bodyMeasurementRepo.all()).toHaveLength(0)
  })

  it('odrzuca niedodatni obwód', async () => {
    await expect(bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 0 })).rejects.toThrow(
      RangeError,
    )
  })

  it('usuwa miękko — rekord zostaje w bazie', async () => {
    const entry = await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78 })
    await bodyMeasurementRepo.softDelete(entry.id)
    expect(await bodyMeasurementRepo.all()).toHaveLength(0)
    expect(await db.bodyMeasurements.count()).toBe(1)
  })

  it('inRange wykrywa pomiar w tygodniu zaczynającym się w sobotę', async () => {
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78 }) // sobota
    const weekStart = startOfWeek('2026-08-05') // środa → sobota 2026-08-01
    expect(await bodyMeasurementRepo.inRange(weekStart, addDays(weekStart, 6))).toHaveLength(1)

    const previousWeek = addDays(weekStart, -7)
    expect(
      await bodyMeasurementRepo.inRange(previousWeek, addDays(previousWeek, 6)),
    ).toHaveLength(0)
  })

  it('sortuje po dacie, latest zwraca najnowszy', async () => {
    await bodyMeasurementRepo.upsert('2026-08-08', { waistCm: 77 })
    await bodyMeasurementRepo.upsert('2026-08-01', { waistCm: 78 })
    expect((await bodyMeasurementRepo.all()).map((r) => r.date)).toEqual([
      '2026-08-01',
      '2026-08-08',
    ])
    expect((await bodyMeasurementRepo.latest())?.waistCm).toBe(77)
  })
})
