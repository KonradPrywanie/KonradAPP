import { describe, expect, it } from 'vitest'
import type { CardioLog, SessionLog, SessionStatus, SetLog, WorkoutExercise } from '../types'
import { WORKOUT_A, WORKOUT_EXERCISES_BY_ID } from '@/data/workouts'
import { isoWeekday } from '../dates'
import {
  CARDIO_BASELINE_WINDOW_DAYS,
  achievedCardio,
  latestWorkingLoads,
  toWeightMap,
} from './history'
import { weekLoad } from './mesocycle'
import { plannedWorkoutExercise, workoutSession } from './workout'
import { planTimeline, planWeekRange, planWeekRanges } from './planGenerator'
import {
  isRunBaselineComplete,
  isSwimBaselineComplete,
  missingPlanInputs,
} from './planInputs'
import { WEIGHT_STEP_KG } from './progression'

const NOW = '2026-08-01T10:00:00.000Z'

function log(
  id: string,
  date: string,
  status: SessionStatus = 'done',
  deleted = false,
): SessionLog {
  return {
    id,
    plannedSessionId: null,
    date,
    type: 'strength',
    status,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

function set(
  sessionLogId: string,
  exerciseId: string,
  setIndex: number,
  reps: number,
  weightKg: number | null,
  deleted = false,
): SetLog {
  return {
    id: `${sessionLogId}-${exerciseId}-${setIndex}`,
    sessionLogId,
    exerciseId,
    setIndex,
    reps,
    weightKg,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

/** Log sesji cardio o wskazanym typie. */
function cardioLog(
  id: string,
  date: string,
  type: 'run' | 'swim' | 'walk',
  status: SessionStatus = 'done',
): SessionLog {
  return { ...log(id, date, status), type }
}

function cardioEntry(
  sessionLogId: string,
  distanceM: number,
  durationSec: number,
  deleted = false,
): CardioLog {
  return {
    id: `c-${sessionLogId}`,
    sessionLogId,
    distanceM,
    durationSec,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

// ════════════════════════════════════════════════════════════════════
//  Odczyt dorobku z logu
// ════════════════════════════════════════════════════════════════════

describe('achievedCardio', () => {
  const TODAY = '2026-08-29'
  const DECLARED_RUN = { distanceM: 5000, paceSecPerKm: 360 } // 6:00/km
  const DECLARED_SWIM = { laps: 10, poolLengthM: 25 as const, stroke: 'freestyle' as const }

  it('bierze najdłuższy bieg z okna, nie ostatni', () => {
    const logs = [cardioLog('l1', '2026-08-20', 'run'), cardioLog('l2', '2026-08-27', 'run')]
    const entries = [
      cardioEntry('l1', 9000, 9 * 360), // dłuższy, starszy
      cardioEntry('l2', 6000, 6 * 340),
    ]

    const result = achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN })
    expect(result.run?.distanceM).toBe(9000)
  })

  it('KRYTYCZNE: tempo nie może się cofnąć poniżej deklarowanego', () => {
    // Bieg spokojny jest z definicji o 30 s/km wolniejszy od tempa z profilu.
    // Przyjęcie go jako nowej bazy dokładałoby pół minuty przy każdym
    // odnowieniu planu i po kilku cyklach zjechałoby do marszu.
    const logs = [cardioLog('l1', '2026-08-27', 'run')]
    const entries = [cardioEntry('l1', 8000, 8 * 400)] // 6:40/km

    const result = achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN })
    expect(result.run?.distanceM).toBe(8000)
    expect(result.run?.paceSecPerKm).toBe(360)
  })

  it('zapisuje tempo szybsze od deklarowanego', () => {
    const logs = [cardioLog('l1', '2026-08-27', 'run')]
    const entries = [cardioEntry('l1', 8000, 8 * 330)] // 5:30/km

    const result = achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN })
    expect(result.run?.paceSecPerKm).toBe(330)
  })

  it('pomija sesje pominięte, wycofane i spacery', () => {
    const logs = [
      cardioLog('l1', '2026-08-27', 'run', 'skipped'),
      cardioLog('l2', '2026-08-26', 'run', 'partial'),
      cardioLog('l3', '2026-08-25', 'run'),
      cardioLog('l4', '2026-08-24', 'walk'),
    ]
    const entries = [
      cardioEntry('l1', 20000, 7200),
      cardioEntry('l2', 15000, 5400),
      cardioEntry('l3', 12000, 12 * 360, true), // wpis wycofany
      cardioEntry('l4', 14000, 14 * 700), // spacer nie jest dowodem formy biegowej
    ]

    expect(achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN }).run).toBeUndefined()
  })

  it('ignoruje sesje starsze niż okno', () => {
    const old = '2026-06-01'
    const logs = [cardioLog('l1', old, 'run')]
    const entries = [cardioEntry('l1', 12000, 12 * 340)]

    expect(achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN }).run).toBeUndefined()
    // W dłuższym oknie ta sama sesja już się liczy.
    const wide = achievedCardio(logs, entries, TODAY, { run: DECLARED_RUN }, 120)
    expect(wide.run?.distanceM).toBe(12000)
    expect(CARDIO_BASELINE_WINDOW_DAYS).toBe(28)
  })

  it('pływanie odwraca przełożenie sesji na dystans ciągły', () => {
    // Sesja zaplanowana dokładnie z deklaracji (250 m × 2,2 = 550 m) nie
    // podnosi bazy — dopiero przepłynięcie wyraźnie więcej.
    const logs = [cardioLog('l1', '2026-08-27', 'swim')]
    expect(
      achievedCardio(logs, [cardioEntry('l1', 550, 900)], TODAY, { swim: DECLARED_SWIM }).swim,
    ).toBeUndefined()

    // 1100 m w seriach ⇒ ~500 m ciągiem ⇒ 20 długości basenu 25 m.
    const better = achievedCardio(logs, [cardioEntry('l1', 1100, 1800)], TODAY, {
      swim: DECLARED_SWIM,
    })
    expect(better.swim?.laps).toBe(20)
    // Długość basenu i styl zostają z profilu — log ich nie zna.
    expect(better.swim?.poolLengthM).toBe(25)
    expect(better.swim?.stroke).toBe('freestyle')
  })

  it('bez deklaracji pływania nie zgaduje basenu', () => {
    const logs = [cardioLog('l1', '2026-08-27', 'swim')]
    const result = achievedCardio(logs, [cardioEntry('l1', 2000, 2400)], TODAY, {})
    expect(result.swim).toBeUndefined()
  })

  it('brak danych daje pusty wynik, nie wyjątek', () => {
    expect(achievedCardio([], [], TODAY, { run: DECLARED_RUN, swim: DECLARED_SWIM })).toEqual({})
  })
})

// ════════════════════════════════════════════════════════════════════
//  Warunki konieczne planu
// ════════════════════════════════════════════════════════════════════

describe('missingPlanInputs', () => {
  const base = {
    equipment: ['gym', 'running', 'pool'],
    runBaseline: { distanceM: 5000, paceSecPerKm: 360 },
    swimBaseline: { laps: 10, poolLengthM: 25, stroke: 'any' },
  } as unknown as Parameters<typeof missingPlanInputs>[0]

  it('komplet danych nie zgłasza braków', () => {
    expect(missingPlanInputs(base)).toEqual([])
  })

  it('zgłasza brak punktu wyjścia dla zgłoszonych dyscyplin', () => {
    expect(missingPlanInputs({ ...base, runBaseline: undefined })).toEqual(['runBaseline'])
    expect(missingPlanInputs({ ...base, swimBaseline: undefined })).toEqual(['swimBaseline'])
    expect(
      missingPlanInputs({ ...base, runBaseline: undefined, swimBaseline: undefined }),
    ).toEqual(['runBaseline', 'swimBaseline'])
  })

  it('nie pyta o dyscypliny, których nie ma w sprzęcie', () => {
    const home = {
      ...base,
      equipment: ['home'],
      runBaseline: undefined,
      swimBaseline: undefined,
    } as typeof base
    expect(missingPlanInputs(home)).toEqual([])
  })

  it('wartości zerowe i ujemne są brakiem, nie danymi', () => {
    expect(isRunBaselineComplete({ distanceM: 0, paceSecPerKm: 360 })).toBe(false)
    expect(isRunBaselineComplete({ distanceM: 5000, paceSecPerKm: 0 })).toBe(false)
    expect(isRunBaselineComplete({ distanceM: 5000, paceSecPerKm: 360 })).toBe(true)
    expect(isSwimBaselineComplete({ laps: 0, poolLengthM: 25, stroke: 'any' })).toBe(false)
    expect(isSwimBaselineComplete({ laps: 10, poolLengthM: 25, stroke: 'any' })).toBe(true)
  })
})

// ════════════════════════════════════════════════════════════════════
//  Zakresy tygodni planu
// ════════════════════════════════════════════════════════════════════

describe('planWeekRange', () => {
  it('tydzień planu trwa od soboty do piątku', () => {
    // Plan zaczęty w środę i tak jest wyrównany do soboty 2026-08-01.
    const first = planWeekRange('2026-08-05', 0)
    expect(first.start).toBe('2026-08-01')
    expect(first.end).toBe('2026-08-07')
    expect(isoWeekday(first.start)).toBe(6)
    expect(isoWeekday(first.end)).toBe(5)
  })

  it('kolejne tygodnie idą co siedem dni bez luk', () => {
    const ranges = planWeekRanges('2026-08-01', 3)
    expect(ranges.map((r) => r.start)).toEqual(['2026-08-01', '2026-08-08', '2026-08-15'])
    expect(ranges.map((r) => r.end)).toEqual(['2026-08-07', '2026-08-14', '2026-08-21'])
  })

  it('odrzuca tydzień poza planem', () => {
    expect(() => planWeekRange('2026-08-01', 2, 2)).toThrow(RangeError)
    expect(() => planWeekRange('2026-08-01', -1)).toThrow(RangeError)
  })
})

describe('latestWorkingLoads', () => {
  it('bierze najcięższą serię z najnowszej sesji', () => {
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-10')]
    const sets = [
      set('l1', 'bench-press', 0, 8, 100), // starsza sesja, cięższa
      set('l2', 'bench-press', 0, 8, 80),
      set('l2', 'bench-press', 1, 6, 85), // najnowsza sesja, najcięższa w niej
    ]

    const loads = latestWorkingLoads(logs, sets)
    // Rekord życiowy sprzed tygodnia nie jest ciężarem, od którego da się dziś zacząć.
    expect(loads.get('bench-press')?.weightKg).toBe(85)
    expect(loads.get('bench-press')?.date).toBe('2026-08-10')
    expect(loads.get('bench-press')?.reps).toBe(6)
  })

  it('rozdziela ćwiczenia niezależnie', () => {
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-10')]
    const sets = [
      set('l1', 'back-squat', 0, 5, 140),
      set('l2', 'bench-press', 0, 8, 85),
    ]
    const loads = latestWorkingLoads(logs, sets)
    expect(loads.get('back-squat')?.weightKg).toBe(140)
    expect(loads.get('bench-press')?.weightKg).toBe(85)
  })

  it('pomija sesje oznaczone jako pominięte — nie odbyły się', () => {
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-10', 'skipped')]
    const sets = [set('l1', 'bench-press', 0, 8, 80), set('l2', 'bench-press', 0, 8, 200)]
    expect(latestWorkingLoads(logs, sets).get('bench-press')?.weightKg).toBe(80)
  })

  it('uwzględnia sesje częściowo wykonane', () => {
    const logs = [log('l1', '2026-08-10', 'partial')]
    const sets = [set('l1', 'bench-press', 0, 6, 80)]
    expect(latestWorkingLoads(logs, sets).get('bench-press')?.weightKg).toBe(80)
  })

  it('pomija wycofane logi i wycofane serie', () => {
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-10', 'done', true)]
    const sets = [
      set('l1', 'bench-press', 0, 8, 80),
      set('l2', 'bench-press', 0, 8, 200), // log wycofany
      set('l1', 'back-squat', 0, 5, 150, true), // seria wycofana
    ]
    const loads = latestWorkingLoads(logs, sets)
    expect(loads.get('bench-press')?.weightKg).toBe(80)
    expect(loads.has('back-squat')).toBe(false)
  })

  it('pomija ćwiczenia z masą własną', () => {
    const logs = [log('l1', '2026-08-10')]
    const sets = [set('l1', 'plank', 0, 30, null), set('l1', 'pushup', 0, 20, 0)]
    expect(latestWorkingLoads(logs, sets).size).toBe(0)
  })

  it('pomija serie bez pasującego logu', () => {
    const sets = [set('sierotka', 'bench-press', 0, 8, 80)]
    expect(latestWorkingLoads([], sets).size).toBe(0)
  })

  it('pusta historia daje pustą mapę', () => {
    expect(latestWorkingLoads([], []).size).toBe(0)
    expect(toWeightMap(new Map()).size).toBe(0)
  })

  it('toWeightMap zostawia sam ciężar', () => {
    const logs = [log('l1', '2026-08-10')]
    const sets = [set('l1', 'bench-press', 0, 8, 85)]
    expect(toWeightMap(latestWorkingLoads(logs, sets))).toEqual(new Map([['bench-press', 85]]))
  })
})

// ════════════════════════════════════════════════════════════════════
//  Zachowanie pozycji w mezocyklu
// ════════════════════════════════════════════════════════════════════

describe('weekLoad z przesunięciem bloków', () => {
  it('bez przesunięcia zachowuje dotychczasowe zachowanie', () => {
    expect(weekLoad(0, 12, 'maintain', 0)).toEqual(weekLoad(0, 12, 'maintain'))
  })

  it('przesunięcie 2 sprawia, że plan startuje w trzecim tygodniu akumulacji', () => {
    const first = weekLoad(0, 12, 'maintain', 2)
    expect(first.phase).toBe('accumulation')
    expect(first.weekInBlock).toBe(2)
    // Ten sam profil obciążenia, co tydzień 2 planu bez przesunięcia.
    expect(first.volumeFactor).toBe(weekLoad(2, 12, 'maintain').volumeFactor)
  })

  it('deload wypada w swoim terminie, nie trzy tygodnie później', () => {
    // Regeneracja w tygodniu 2 cyklu: deload ma przyjść już w kolejnym tygodniu.
    expect(weekLoad(1, 12, 'maintain', 2).phase).toBe('deload')
    // Bez przesunięcia deload byłby dopiero w tygodniu 3 nowego planu.
    expect(weekLoad(1, 12, 'maintain', 0).phase).toBe('accumulation')
  })

  it('rytm bloków biegnie dalej po deloadzie', () => {
    const afterDeload = weekLoad(2, 12, 'maintain', 2)
    expect(afterDeload.phase).toBe('accumulation')
    expect(afterDeload.blockIndex).toBe(1)
    expect(afterDeload.weekInBlock).toBe(0)
  })

  it('tapering liczy się od KOŃCA planu, nie od rytmu bloków', () => {
    // Inaczej przesunięcie mogłoby wypchnąć tapering poza plan.
    for (const offset of [0, 1, 2, 3]) {
      expect(weekLoad(10, 12, 'event', offset).phase).toBe('taper')
      expect(weekLoad(11, 12, 'event', offset).phase).toBe('taper')
      expect(weekLoad(9, 12, 'event', offset).phase).not.toBe('taper')
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Zasilanie ciężarów w sesji
// ════════════════════════════════════════════════════════════════════

describe('ciężary z historii w sesji z arkusza', () => {
  const first = WORKOUT_A.slots[0]?.main as WorkoutExercise
  const bodyweight = [...WORKOUT_EXERCISES_BY_ID.values()].find((e) => e.startWeightKg === null) as WorkoutExercise

  it('bez historii ciężar jest ten z arkusza, nie zgadnięty', () => {
    const session = workoutSession({ workout: WORKOUT_A, load: weekLoad(0, 12, 'maintain') })
    for (const [index, exercise] of session.exercises.entries()) {
      const source = WORKOUT_A.slots[index]?.main as WorkoutExercise
      for (const s of exercise.sets) expect(s.weightKg, source.id).toBe(source.startWeightKg)
    }
  })

  it('ćwiczenie z masą własnego ciała zostaje bez ciężaru', () => {
    expect(bodyweight).toBeDefined()
    const planned = plannedWorkoutExercise(bodyweight)
    for (const s of planned.sets) expect(s.weightKg).toBeNull()
  })

  it('sadza ciężar z historii jako punkt startowy', () => {
    const session = workoutSession({
      workout: WORKOUT_A,
      load: weekLoad(0, 12, 'maintain'),
      knownLoads: new Map([[first.id, 47.5]]),
    })
    expect(session.exercises[0]?.sets[0]?.weightKg).toBe(47.5)
  })

  it('ten sam ciężar trafia do wszystkich tygodni akumulacji', () => {
    // Plan nie zgaduje, o ile użytkownik urośnie — podniesie to progresja
    // z faktycznie zalogowanych serii.
    const known = new Map([[first.id, 40]])
    for (const week of [0, 1, 2, 4, 8]) {
      const load = weekLoad(week, 12, 'maintain')
      const session = workoutSession({ workout: WORKOUT_A, load, knownLoads: known })
      const weight = session.exercises[0]?.sets[0]?.weightKg
      if (load.phase === 'deload') expect(weight, `tydzień ${week}`).toBeLessThan(40)
      else expect(weight, `tydzień ${week}`).toBe(40)
    }
  })

  it('deload obniża obciążenie o 10%, zaokrąglone do kroku', () => {
    const session = workoutSession({
      workout: WORKOUT_A,
      load: weekLoad(3, 12, 'maintain'),
      knownLoads: new Map([[first.id, 100]]),
    })
    expect(session.exercises[0]?.sets[0]?.weightKg).toBe(90)
    for (const exercise of session.exercises) {
      for (const s of exercise.sets) {
        if (s.weightKg !== null) expect(s.weightKg % WEIGHT_STEP_KG).toBe(0)
      }
    }
  })

  it('tapering utrzymuje obciążenie — obniża się objętość, nie ciężar', () => {
    const session = workoutSession({
      workout: WORKOUT_A,
      load: weekLoad(11, 12, 'event'),
      knownLoads: new Map([[first.id, 100]]),
    })
    expect(session.exercises[0]?.sets[0]?.weightKg).toBe(100)
  })
})

describe('planTimeline', () => {
  // Start w środę — plan jest wyrównany do tygodnia aplikacji, a ten zaczyna
  // się w SOBOTĘ, więc liczy się od 2026-08-01. Ostatni dzień: +83 dni.
  const START = '2026-08-05'
  const WEEKS = 12

  it('wyrównuje początek do soboty i liczy ostatni dzień', () => {
    const timeline = planTimeline(START, WEEKS, START)
    expect(timeline.weekStart).toBe('2026-08-01')
    expect(timeline.lastDate).toBe('2026-10-23')
  })

  it('wskazuje bieżący tydzień planu', () => {
    expect(planTimeline(START, WEEKS, '2026-08-05').currentWeekIndex).toBe(0)
    expect(planTimeline(START, WEEKS, '2026-08-10').currentWeekIndex).toBe(1)
    expect(planTimeline(START, WEEKS, '2026-09-07').currentWeekIndex).toBe(5)
  })

  it('rozpoznaje, że plan jeszcze się nie zaczął', () => {
    const timeline = planTimeline(START, WEEKS, '2026-08-04')
    expect(timeline.notStarted).toBe(true)
    expect(timeline.currentWeekIndex).toBeNull()
    expect(timeline.isFinished).toBe(false)
  })

  it('rozpoznaje ostatni tydzień planu', () => {
    const timeline = planTimeline(START, WEEKS, '2026-10-23')
    expect(timeline.isFinalWeek).toBe(true)
    expect(timeline.isFinished).toBe(false)
    expect(timeline.daysRemaining).toBe(0)
    expect(timeline.currentWeekIndex).toBe(WEEKS - 1)
  })

  it('KRYTYCZNE: rozpoznaje plan wyczerpany', () => {
    // Bez tego plan kończył się w ciszy — ekran „Dziś" pokazywał puste
    // miejsce zamiast propozycji odnowienia.
    const timeline = planTimeline(START, WEEKS, '2026-10-26')
    expect(timeline.isFinished).toBe(true)
    expect(timeline.currentWeekIndex).toBeNull()
    expect(timeline.daysRemaining).toBeLessThan(0)
    expect(timeline.isFinalWeek).toBe(false)
  })

  it('plan czterotygodniowy kończy się po 28 dniach', () => {
    // Liczone od soboty 2026-08-01, więc ostatni dzień to 2026-08-28.
    expect(planTimeline('2026-08-03', 4, '2026-08-28').isFinished).toBe(false)
    expect(planTimeline('2026-08-03', 4, '2026-08-29').isFinished).toBe(true)
  })
})
