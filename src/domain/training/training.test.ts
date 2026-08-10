import { describe, expect, it } from 'vitest'
import type {
  PlannedSet,
  Profile,
  SetLog,
  StrengthPayload,
  RunPayload,
  SwimPayload,
  WorkoutExercise,
} from '../types'
import { WORKOUTS, WORKOUT_A, WORKOUT_B, WORKOUT_EXERCISES_BY_ID } from '@/data/workouts'
import { PRESET_PROFILE } from '@/data/presetProfile'
import { isoWeekday } from '../dates'
import { BLOCK_LENGTH_WEEKS, planLoads, weekLoad } from './mesocycle'
import { fixedLayoutApplies, isLegHeavyFocus, spreadIndices, weeklySchedule } from './schedule'
import { derivedWeeklySessions } from './sessionTarget'
import {
  WARMUP_MINUTES,
  exerciseFor,
  plannedWorkoutExercise,
  workoutSession,
} from './workout'
import { runSession, swimSession } from './cardio'
import {
  DEFAULT_PLAN_WEEKS,
  generatePlan,
  nextTrainingSession,
  verifyWeekdayAlignment,
} from './planGenerator'
import {
  DELOAD_LOAD_FACTOR,
  WEIGHT_STEP_KG,
  applyProgression,
  deloadWeight,
  evaluateProgression,
  trainingVolumeKg,
} from './progression'

const NOW = '2026-08-01T10:00:00.000Z'

function profile(patch: Partial<Profile> = {}): Profile {
  return {
    id: 'p1',
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    name: 'Test',
    birthYear: 1996,
    sex: 'male',
    heightCm: 180,
    startWeightKg: 80,
    goal: 'maintain',
    activityLevel: 'moderate',
    experience: 'intermediate',
    equipment: ['gym', 'running'],
    availableDays: [1, 3, 5],
    emphasis: 'balanced',
    sessionMinutes: 60,
    diet: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
    cooking: { weekdayMinutes: 30, prepStyle: 'daily' },
    injuries: [],
    mealSplit: { breakfast: 0.24, lunch: 0.3, afternoon: 0.22, dinner: 0.24 },
    kcalOverride: null,
    ...patch,
  }
}

function setLog(reps: number, weightKg: number | null, rpe?: number): SetLog {
  return {
    id: `s-${Math.abs(reps * 31 + (weightKg ?? 0))}-${rpe ?? 0}`,
    sessionLogId: 'sl1',
    exerciseId: 'bench-press',
    setIndex: 0,
    reps,
    weightKg,
    ...(rpe === undefined ? {} : { rpe }),
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
  }
}

function plannedSets(count: number, reps: number, weightKg: number | null = null): PlannedSet[] {
  return Array.from({ length: count }, () => ({ reps, weightKg, targetRpe: 8 }))
}

// ════════════════════════════════════════════════════════════════════
//  Periodyzacja
// ════════════════════════════════════════════════════════════════════

describe('weekLoad — bloki 3 + 1', () => {
  const loads = planLoads(12, 'maintain')

  it('co czwarty tydzień jest deloadem', () => {
    const deloadWeeks = loads.map((l, i) => ({ i, phase: l.phase })).filter((x) => x.phase === 'deload')
    expect(deloadWeeks.map((x) => x.i)).toEqual([3, 7, 11])
  })

  it('objętość rośnie w obrębie bloku i resetuje się po deloadzie', () => {
    expect(loads[0]?.volumeFactor).toBeLessThan(loads[1]?.volumeFactor as number)
    expect(loads[1]?.volumeFactor).toBeLessThan(loads[2]?.volumeFactor as number)
    expect(loads[3]?.volumeFactor).toBeLessThan(loads[2]?.volumeFactor as number)
    expect(loads[4]?.volumeFactor).toBe(loads[0]?.volumeFactor)
  })

  it('deload obniża objętość znacząco, nie kosmetycznie', () => {
    expect(loads[3]?.volumeFactor).toBeLessThanOrEqual(0.7)
  })

  it('intensywność narasta między blokami i nie cofa się po deloadzie', () => {
    // To sedno periodyzacji: objętość się resetuje, ciężary nie.
    expect(loads[4]?.intensityFactor).toBeGreaterThanOrEqual(loads[2]?.intensityFactor as number)
    expect(loads[8]?.intensityFactor).toBeGreaterThan(loads[4]?.intensityFactor as number)
    expect(loads[10]?.intensityFactor).toBeGreaterThan(loads[2]?.intensityFactor as number)
  })

  it('numeruje bloki i tygodnie w bloku', () => {
    expect(loads[0]).toMatchObject({ blockIndex: 0, weekInBlock: 0 })
    expect(loads[5]).toMatchObject({ blockIndex: 1, weekInBlock: 1 })
    expect(loads[11]).toMatchObject({ blockIndex: 2, weekInBlock: BLOCK_LENGTH_WEEKS - 1 })
  })

  it('cel „zawody" wprowadza tapering w dwóch ostatnich tygodniach', () => {
    const event = planLoads(12, 'event')
    expect(event[10]?.phase).toBe('taper')
    expect(event[11]?.phase).toBe('taper')
    expect(event[11]?.volumeFactor).toBeLessThan(event[10]?.volumeFactor as number)
    // Tapering obniża objętość, ale NIE intensywność.
    expect(event[11]?.intensityFactor).toBeGreaterThanOrEqual(1)
  })

  it('odrzuca tydzień poza planem', () => {
    expect(() => weekLoad(12, 12, 'maintain')).toThrow(RangeError)
    expect(() => weekLoad(-1, 12, 'maintain')).toThrow(RangeError)
  })
})

describe('derivedWeeklySessions', () => {
  it('daje 3–6 sesji dla każdej kombinacji', () => {
    for (const activity of ['sedentary', 'light', 'moderate', 'high', 'veryHigh'] as const) {
      for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
        const count = derivedWeeklySessions(activity, experience)
        expect(count, `${activity}/${experience}`).toBeGreaterThanOrEqual(3)
        expect(count, `${activity}/${experience}`).toBeLessThanOrEqual(6)
      }
    }
  })

  it('typowe profile dostają 4 albo 5 sesji', () => {
    expect(derivedWeeklySessions('moderate', 'intermediate')).toBe(4)
    expect(derivedWeeklySessions('high', 'intermediate')).toBe(5)
    expect(derivedWeeklySessions('moderate', 'advanced')).toBe(5)
  })

  it('rośnie z aktywnością przy stałym doświadczeniu', () => {
    const levels = ['sedentary', 'light', 'moderate', 'high', 'veryHigh'] as const
    for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
      for (let i = 1; i < levels.length; i++) {
        expect(
          derivedWeeklySessions(levels[i] as (typeof levels)[number], experience),
          `${experience}: ${levels[i - 1]} → ${levels[i]}`,
        ).toBeGreaterThanOrEqual(
          derivedWeeklySessions(levels[i - 1] as (typeof levels)[number], experience),
        )
      }
    }
  })

  it('rośnie z doświadczeniem przy stałej aktywności', () => {
    for (const activity of ['sedentary', 'light', 'moderate', 'high', 'veryHigh'] as const) {
      expect(derivedWeeklySessions(activity, 'advanced')).toBeGreaterThanOrEqual(
        derivedWeeklySessions(activity, 'beginner'),
      )
    }
  })

  it('jest stała dla danego profilu — nie losowana co tydzień', () => {
    // Struktura tygodnia musi być powtarzalna, bo na niej opiera się progresja.
    const first = derivedWeeklySessions('moderate', 'intermediate')
    for (let i = 0; i < 10; i++) {
      expect(derivedWeeklySessions('moderate', 'intermediate')).toBe(first)
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Rozkład tygodnia i reguły kolizji
// ════════════════════════════════════════════════════════════════════

describe('spreadIndices', () => {
  it('rozkłada równomiernie', () => {
    expect(spreadIndices(4, 2)).toEqual([0, 3])
    expect(spreadIndices(5, 3)).toEqual([0, 2, 4])
    expect(spreadIndices(7, 3)).toEqual([0, 3, 6])
  })

  it('gdy pozycji jest tyle co dni, bierze wszystkie', () => {
    expect(spreadIndices(3, 3)).toEqual([0, 1, 2])
    expect(spreadIndices(3, 5)).toEqual([0, 1, 2])
  })

  it('jedną pozycję stawia w środku', () => {
    expect(spreadIndices(5, 1)).toEqual([2])
  })

  it('nie zwraca duplikatów', () => {
    for (let n = 1; n <= 7; n++) {
      for (let k = 0; k <= n; k++) {
        const result = spreadIndices(n, k)
        expect(new Set(result).size, `n=${n} k=${k}`).toBe(result.length)
      }
    }
  })
})

describe('weeklySchedule', () => {
  function scheduleFor(patch: Partial<Profile> = {}) {
    return weeklySchedule(profile(patch))
  }

  it('jest deterministyczny — te same dane dają ten sam rozkład', () => {
    expect(scheduleFor()).toEqual(scheduleFor())
  })

  it('zwraca wpis na każdy dzień tygodnia', () => {
    const schedule = scheduleFor()
    expect(schedule).toHaveLength(7)
    expect(schedule.map((d) => d.dayOfWeek)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })

  it('dni niedostępne są dniami odpoczynku', () => {
    const schedule = scheduleFor({ availableDays: [1, 3, 5] })
    for (const day of schedule) {
      if (![1, 3, 5].includes(day.dayOfWeek)) {
        expect(day.type, `dzień ${day.dayOfWeek}`).toBe('rest')
      }
    }
  })

  it('nie przekracza limitu sesji siłowych dla poziomu', () => {
    const beginner = scheduleFor({ experience: 'beginner', availableDays: [1, 2, 3, 4, 5, 6] })
    const strengthDays = beginner.filter((d) => d.type === 'strength')
    expect(strengthDays.length).toBeLessThanOrEqual(3)
  })

  it('REGUŁA: nie ma trzech wymagających dni z rzędu (tydzień cyklicznie)', () => {
    const variants: Partial<Profile>[] = [
      { availableDays: [1, 2, 3, 4, 5] },
      { availableDays: [1, 2, 3, 4, 5, 6, 7] },
      { availableDays: [1, 2, 3, 4, 5, 6], experience: 'advanced' },
      { availableDays: [1, 2, 3], goal: 'conditioning', equipment: ['gym', 'running', 'pool'] },
      { availableDays: [2, 3, 4, 5, 6], goal: 'cut', experience: 'advanced' },
      { availableDays: [1, 2, 4, 5, 6, 7], goal: 'event', experience: 'advanced' },
    ]

    for (const patch of variants) {
      const schedule = scheduleFor(patch)
      for (let i = 0; i < 7; i++) {
        const a = schedule[i]
        const b = schedule[(i + 1) % 7]
        const c = schedule[(i + 2) % 7]
        expect(
          a?.hard && b?.hard && c?.hard,
          `${JSON.stringify(patch)} → dni ${a?.dayOfWeek}/${b?.dayOfWeek}/${c?.dayOfWeek}`,
        ).toBeFalsy()
      }
    }
  })

  it('REGUŁA: mocny bieg nie stoi dzień po sesji obciążającej nogi', () => {
    const variants: Partial<Profile>[] = [
      { availableDays: [1, 2, 3, 4, 5] },
      { availableDays: [1, 2, 3, 4, 5, 6], experience: 'advanced' },
      { availableDays: [1, 2, 3, 4, 5], goal: 'conditioning', experience: 'advanced' },
    ]

    for (const patch of variants) {
      const schedule = scheduleFor(patch)
      for (let i = 0; i < 7; i++) {
        const day = schedule[i]
        if (day?.type !== 'run' || day.runVariant !== 'intervals') continue
        const previous = schedule[(i - 1 + 7) % 7]
        const violation = previous?.type === 'strength' && isLegHeavyFocus(previous.focus)
        expect(violation, `${JSON.stringify(patch)} → dzień ${day.dayOfWeek}`).toBe(false)
      }
    }
  })

  it('REGUŁA: siedem dostępnych dni zostawia dzień odpoczynku', () => {
    const schedule = scheduleFor({ availableDays: [1, 2, 3, 4, 5, 6, 7] })
    expect(schedule.filter((d) => d.type === 'rest').length).toBeGreaterThanOrEqual(1)
  })

  it('liczbę sesji bierze z aktywności i doświadczenia, nie z osobnego pola', () => {
    // Wolna cały tydzień; liczba treningów wynika z profilu.
    const week = [1, 2, 3, 4, 5, 6, 7] as Profile['availableDays']

    const moderate = scheduleFor({
      availableDays: week,
      activityLevel: 'moderate',
      experience: 'intermediate',
    })
    expect(moderate.filter((d) => d.type !== 'rest')).toHaveLength(
      derivedWeeklySessions('moderate', 'intermediate'),
    )

    const high = scheduleFor({
      availableDays: week,
      activityLevel: 'high',
      experience: 'intermediate',
    })
    expect(high.filter((d) => d.type !== 'rest')).toHaveLength(
      derivedWeeklySessions('high', 'intermediate'),
    )

    // Wyższa aktywność daje więcej sesji — czasem 4, czasem 5.
    expect(high.filter((d) => d.type !== 'rest').length).toBeGreaterThan(
      moderate.filter((d) => d.type !== 'rest').length,
    )
  })

  it('gdy wyliczona liczba przekracza dostępne dni, wygrywa kalendarz', () => {
    const schedule = scheduleFor({
      availableDays: [1, 4],
      activityLevel: 'veryHigh',
      experience: 'advanced',
    })
    expect(schedule.filter((d) => d.type !== 'rest')).toHaveLength(2)
  })

  it('rozstawia wybrane dni równomiernie, nie bierze pierwszych z rzędu', () => {
    const schedule = scheduleFor({
      availableDays: [1, 2, 3, 4, 5, 6, 7],
      activityLevel: 'sedentary',
      experience: 'beginner', // 3 sesje
    })
    const trainingDays = schedule.filter((d) => d.type !== 'rest').map((d) => d.dayOfWeek)
    expect(trainingDays).toEqual([1, 4, 7])
  })

  it('nigdy nie planuje siedmiu dni treningowych', () => {
    const schedule = scheduleFor({
      availableDays: [1, 2, 3, 4, 5, 6, 7],
      activityLevel: 'veryHigh',
      experience: 'advanced', // 6 sesji
    })
    expect(schedule.filter((d) => d.type !== 'rest').length).toBeLessThanOrEqual(6)
    expect(schedule.filter((d) => d.type === 'rest').length).toBeGreaterThanOrEqual(1)
  })

  it('KRYTYCZNE: siłownia dostaje najwyżej dwie sesje, gdy jest cardio', () => {
    // Reszta dni idzie na bieganie i pływanie, żeby obie dyscypliny wchodziły
    // w każdym tygodniu.
    for (const activityLevel of ['moderate', 'high', 'veryHigh'] as const) {
      for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
        const schedule = scheduleFor({
          availableDays: [1, 2, 3, 4, 5, 6],
          activityLevel,
          experience,
          equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
        })
        expect(
          schedule.filter((d) => d.type === 'strength').length,
          `${activityLevel}/${experience}`,
        ).toBeLessThanOrEqual(2)
      }
    }
  })

  it('KRYTYCZNE: bieganie i basen wchodzą w KAŻDYM tygodniu', () => {
    for (const activityLevel of ['sedentary', 'light', 'moderate', 'high', 'veryHigh'] as const) {
      for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
        for (const goal of ['cut', 'maintain', 'bulk', 'conditioning'] as const) {
          const schedule = scheduleFor({
            availableDays: [1, 2, 3, 4, 5, 6],
            activityLevel,
            experience,
            goal,
            equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
          })
          const label = `${activityLevel}/${experience}/${goal}`
          expect(schedule.filter((d) => d.type === 'run').length, label).toBeGreaterThanOrEqual(1)
          expect(schedule.filter((d) => d.type === 'swim').length, label).toBeGreaterThanOrEqual(1)
        }
      }
    }
  })

  /**
   * ŚWIADOMA UTRATA ZDOLNOŚCI: `emphasis` nie zmienia już rozkładu tygodnia.
   *
   * Wcześniej pole sterowało podziałem sesji (dzień dolny, górny, pośladkowy),
   * bo aplikacja komponowała sesje z katalogu. Teraz dni siłowe dostają Trening
   * A i B z arkusza — a te są FBW, czyli obejmują całe ciało. Nacisk na taśmę
   * tylną jest w nich wpisany przez trenera (Hip Thrust, RDL, zakroki), tylko
   * nie przez pole w profilu.
   */
  it('KRYTYCZNE: dni siłowe to FBW — nacisk z profilu nie zmienia sesji', () => {
    const days = { availableDays: [1, 2, 4, 5] as Profile['availableDays'] }
    const equipment: Profile['equipment'] = ['gym', 'dumbbells', 'home', 'running', 'pool']

    for (const emphasis of ['balanced', 'lowerBody', 'upperBody'] as const) {
      const schedule = scheduleFor({ emphasis, equipment, ...days })
      const strength = schedule.filter((d) => d.type === 'strength')
      expect(strength.map((d) => d.focus), emphasis).toEqual(['full', 'full'])
      // Pierwszy dzień siłowy to Trening A, drugi B — zawsze w tej kolejności.
      expect(strength.map((d) => d.workoutId), emphasis).toEqual(['A', 'B'])
    }
  })

  it('ograniczenie dna miednicy wyklucza interwały biegowe', () => {
    // Interwały to bieg o wysokim wpływie.
    const schedule = scheduleFor({
      injuries: ['pelvicFloor'],
      experience: 'advanced',
      activityLevel: 'veryHigh',
      goal: 'conditioning',
      availableDays: [1, 2, 3, 4, 5],
      equipment: ['gym', 'running'],
    })
    for (const day of schedule) {
      if (day.type === 'run') expect(day.runVariant).toBe('easy')
    }
  })

  it('cel „kondycja" daje więcej cardio niż siłowni', () => {
    const schedule = scheduleFor({
      goal: 'conditioning',
      availableDays: [1, 2, 3, 4, 5],
      equipment: ['gym', 'running', 'pool'],
    })
    const strength = schedule.filter((d) => d.type === 'strength').length
    const cardio = schedule.filter((d) => d.type === 'run' || d.type === 'swim').length
    expect(cardio).toBeGreaterThan(strength)
  })

  it('mając sprzęt do cardio, zawsze dostaje przynajmniej jeden dzień cardio', () => {
    const variants: Partial<Profile>[] = [
      { availableDays: [1, 2, 4, 5], goal: 'cut', experience: 'intermediate' },
      { availableDays: [1, 2, 3, 4, 5], goal: 'bulk', experience: 'advanced' },
      { availableDays: [1, 2, 3, 4, 5, 6], goal: 'maintain', experience: 'advanced' },
      { availableDays: [1, 3, 5], goal: 'cut', experience: 'beginner' },
    ]

    for (const patch of variants) {
      const schedule = scheduleFor({ equipment: ['gym', 'running'], ...patch })
      const cardio = schedule.filter((d) => d.type === 'run' || d.type === 'swim')
      expect(cardio.length, JSON.stringify(patch)).toBeGreaterThanOrEqual(1)
    }
  })

  it('przy dwóch dniach cardio ma pierwszeństwo nad drugą sesją siłową', () => {
    // Gwarancja cardio w każdym tygodniu jest silniejsza niż druga sesja siłowa.
    const schedule = scheduleFor({ availableDays: [2, 5], equipment: ['gym', 'running'] })
    expect(schedule.filter((d) => d.type === 'strength')).toHaveLength(1)
    expect(schedule.filter((d) => d.type === 'run')).toHaveLength(1)
  })

  it('bez sprzętu do cardio wszystkie dni idą na siłownię', () => {
    const schedule = scheduleFor({ equipment: ['gym'], availableDays: [1, 3, 5] })
    const trainingDays = schedule.filter((d) => d.type !== 'rest')
    expect(trainingDays.every((d) => d.type === 'strength')).toBe(true)
  })

  it('mając basen i bieganie, przeplata dyscypliny', () => {
    const schedule = scheduleFor({
      goal: 'conditioning',
      equipment: ['running', 'pool'],
      availableDays: [1, 2, 3, 4],
    })
    const types = new Set(schedule.filter((d) => d.type !== 'rest').map((d) => d.type))
    expect(types.has('run')).toBe(true)
    expect(types.has('swim')).toBe(true)
  })

  it('REGRESJA: basen wchodzi do planu także przy celu sylwetkowym', () => {
    // Wcześniej licznik cardio startował od zera przy warunku `% 2 === 1`,
    // więc pierwszy dzień cardio ZAWSZE był bieganiem — a przy jednym dniu
    // cardio pływanie nie wchodziło nigdy, mimo zaznaczonego basenu.
    for (const goal of ['cut', 'maintain', 'bulk'] as const) {
      for (const days of [[1, 3, 5], [1, 2, 4, 5], [1, 2, 3, 5, 6]]) {
        const schedule = scheduleFor({
          goal,
          equipment: ['gym', 'running', 'pool'],
          availableDays: days as Profile['availableDays'],
        })
        const swims = schedule.filter((d) => d.type === 'swim').length
        expect(swims, `${goal}, dni ${days.join(',')}`).toBeGreaterThanOrEqual(1)
      }
    }
  })

  it('typowy tydzień to 2 siłownia + bieg + basen', () => {
    // To układ, o który poprosił użytkownik.
    const schedule = scheduleFor({
      goal: 'cut',
      equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
      availableDays: [1, 2, 4, 5],
      activityLevel: 'moderate',
      experience: 'intermediate', // 4 sesje
    })
    expect(schedule.filter((d) => d.type === 'strength')).toHaveLength(2)
    expect(schedule.filter((d) => d.type === 'run')).toHaveLength(1)
    expect(schedule.filter((d) => d.type === 'swim')).toHaveLength(1)
    expect(schedule.filter((d) => d.type === 'rest')).toHaveLength(3)
  })

  it('piąta sesja idzie na cardio, nie na trzecią siłownię', () => {
    const schedule = scheduleFor({
      goal: 'cut',
      equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
      availableDays: [1, 2, 3, 5, 6],
      activityLevel: 'high',
      experience: 'intermediate', // 5 sesji
    })
    expect(schedule.filter((d) => d.type === 'strength')).toHaveLength(2)
    expect(schedule.filter((d) => d.type === 'run' || d.type === 'swim')).toHaveLength(3)
  })

  it('sam basen bez biegania daje wyłącznie pływanie', () => {
    const schedule = scheduleFor({
      goal: 'cut',
      equipment: ['gym', 'pool'],
      availableDays: [1, 3, 5],
    })
    expect(schedule.filter((d) => d.type === 'run')).toHaveLength(0)
    expect(schedule.filter((d) => d.type === 'swim').length).toBeGreaterThanOrEqual(1)
    expect(schedule.filter((d) => d.type === 'strength')).toHaveLength(2)
  })

  it('początkującemu nie planuje interwałów', () => {
    const schedule = scheduleFor({
      experience: 'beginner',
      availableDays: [1, 2, 3, 4, 5],
      equipment: ['home', 'running'],
    })
    for (const day of schedule) {
      if (day.type === 'run') expect(day.runVariant).toBe('easy')
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Stały rozkład tygodnia
// ════════════════════════════════════════════════════════════════════

describe('FIXED_WEEK_LAYOUT — dni wskazane przez użytkownika', () => {
  /** Profil, który układ unosi: siłownia + bieganie + basen, wszystkie dni układu. */
  function full(patch: Partial<Profile> = {}): Profile {
    return profile({
      equipment: ['gym', 'running', 'pool'],
      availableDays: [1, 2, 3, 4, 5, 6, 7],
      ...patch,
    })
  }

  it('KRYTYCZNE: poniedziałek bieg, wtorek i czwartek siłownia, sobota basen', () => {
    const schedule = weeklySchedule(full())
    const byDay = new Map(schedule.map((day) => [day.dayOfWeek, day]))

    expect(byDay.get(1)?.type).toBe('run')
    expect(byDay.get(2)?.type).toBe('strength')
    expect(byDay.get(4)?.type).toBe('strength')
    expect(byDay.get(6)?.type).toBe('swim')
    // Pozostałe dni są wolne — także wtedy, gdy profil ma zaznaczony cały tydzień.
    for (const day of [3, 5, 7] as const) {
      expect(byDay.get(day)?.type, `dzień ${day}`).toBe('rest')
    }
  })

  it('liczba sesji NIE zależy już od aktywności i doświadczenia', () => {
    for (const activityLevel of ['sedentary', 'moderate', 'veryHigh'] as const) {
      for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
        const schedule = weeklySchedule(full({ activityLevel, experience }))
        expect(
          schedule.filter((day) => day.type !== 'rest'),
          `${activityLevel}/${experience}`,
        ).toHaveLength(4)
      }
    }
  })

  it('preset profilu daje dokładnie ten rozkład', () => {
    const schedule = weeklySchedule(
      profile({
        equipment: [...PRESET_PROFILE.equipment],
        availableDays: [...PRESET_PROFILE.availableDays],
        emphasis: PRESET_PROFILE.emphasis,
        experience: PRESET_PROFILE.experience,
        activityLevel: PRESET_PROFILE.activityLevel,
        goal: PRESET_PROFILE.goal,
      }),
    )
    expect(schedule.filter((day) => day.type === 'strength').map((d) => d.dayOfWeek)).toEqual([2, 4])
    expect(schedule.filter((day) => day.type === 'run').map((d) => d.dayOfWeek)).toEqual([1])
    expect(schedule.filter((day) => day.type === 'swim').map((d) => d.dayOfWeek)).toEqual([6])
  })

  it('wtorek to Trening A, czwartek Trening B', () => {
    const schedule = weeklySchedule(full())
    const strength = schedule.filter((day) => day.type === 'strength')
    expect(strength.map((day) => day.dayOfWeek)).toEqual([2, 4])
    expect(strength.map((day) => day.workoutId)).toEqual(['A', 'B'])
    expect(strength.map((day) => day.focus)).toEqual(['full', 'full'])
  })

  it('reguły kolizji nadal obowiązują: nie ma trzech wymagających dni z rzędu', () => {
    for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
      for (const goal of ['cut', 'conditioning'] as const) {
        const schedule = weeklySchedule(full({ experience, goal }))
        for (let i = 0; i < 7; i++) {
          const a = schedule[i]
          const b = schedule[(i + 1) % 7]
          const c = schedule[(i + 2) % 7]
          expect(a?.hard && b?.hard && c?.hard, `${experience}/${goal} od dnia ${a?.dayOfWeek}`)
            .toBeFalsy()
        }
      }
    }
  })

  it('nie obowiązuje, gdy któregoś dnia układu nie ma wśród dostępnych', () => {
    // Bez soboty rozkład wraca do wyliczania z profilu.
    expect(fixedLayoutApplies(full({ availableDays: [1, 2, 3, 4, 5] }))).toBe(false)
    const schedule = weeklySchedule(full({ availableDays: [1, 2, 3, 4, 5] }))
    expect(schedule.find((day) => day.dayOfWeek === 6)?.type).toBe('rest')
  })

  it('nie obowiązuje bez sprzętu na którąś dyscyplinę układu', () => {
    expect(fixedLayoutApplies(full({ equipment: ['gym', 'running'] }))).toBe(false)
    expect(fixedLayoutApplies(full({ equipment: ['gym', 'pool'] }))).toBe(false)
    expect(fixedLayoutApplies(full({ equipment: ['running', 'pool'] }))).toBe(false)
    expect(fixedLayoutApplies(full({ equipment: ['dumbbells', 'running', 'pool'] }))).toBe(true)
  })

  it('da się wyłączyć wprost — algorytm z dostępnych dni żyje dalej', () => {
    const derived = weeklySchedule(
      full({ activityLevel: 'sedentary', experience: 'beginner' }),
      null,
    )
    // Trzy sesje rozstawione równomiernie po całym tygodniu, jak przed zmianą.
    expect(derived.filter((day) => day.type !== 'rest').map((day) => day.dayOfWeek)).toEqual([
      1, 4, 7,
    ])
  })

  it('plan bierze dni z układu i nie ostrzega o liczbie sesji', () => {
    const result = generatePlan({
      profile: full({ activityLevel: 'veryHigh', experience: 'advanced' }),
      startDate: '2026-08-01',
      workouts: WORKOUTS,
      weeks: 2,
    })

    const weekdays = new Set(result.sessions.filter((s) => s.type !== 'rest').map((s) => s.dayOfWeek))
    expect([...weekdays].sort()).toEqual([1, 2, 4, 6])
    // „Zaplanowano 4 z 6 sesji" byłoby tu nieprawdą o planie, nie ostrzeżeniem.
    for (const warning of result.warnings) {
      expect(warning).not.toContain('sesji w tygodniu')
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Sesje siłowe z arkusza
// ════════════════════════════════════════════════════════════════════

describe('workoutSession', () => {
  it('wstawia WSZYSTKIE ćwiczenia treningu, w kolejności z arkusza', () => {
    const payload = workoutSession({ workout: WORKOUT_A, load: weekLoad(0, 2, 'cut') })
    expect(payload.workoutId).toBe('A')
    expect(payload.focus).toBe('full')
    expect(payload.exercises.map((e) => e.exerciseId)).toEqual(
      WORKOUT_A.slots.map((slot) => slot.main.id),
    )
  })

  it('serie, powtórzenia i przerwy są z arkusza, nie z szablonu aplikacji', () => {
    const payload = workoutSession({ workout: WORKOUT_A, load: weekLoad(0, 2, 'cut') })
    for (const [index, planned] of payload.exercises.entries()) {
      const source = WORKOUT_A.slots[index]?.main as WorkoutExercise
      expect(planned.sets, source.id).toHaveLength(source.sets)
      expect(planned.sets[0]?.reps, source.id).toBe(source.reps)
      expect(planned.restSec, source.id).toBe(source.restSec)
      expect(planned.sets[0]?.weightKg, source.id).toBe(source.startWeightKg)
    }
  })

  it('KRYTYCZNE: deload zdejmuje jedną serię i 10% ciężaru', () => {
    // To jedyne, co aplikacja zmienia w zapisie trenera — i tylko w tygodniu
    // deloadu, bo taki jest jego sens.
    const normal = workoutSession({ workout: WORKOUT_A, load: weekLoad(0, 4, 'cut') })
    const deload = workoutSession({ workout: WORKOUT_A, load: weekLoad(3, 4, 'cut') })

    expect(weekLoad(3, 4, 'cut').phase).toBe('deload')
    for (const [index, exercise] of deload.exercises.entries()) {
      const before = normal.exercises[index] as (typeof deload.exercises)[number]
      expect(exercise.sets.length, exercise.exerciseId).toBe(
        Math.max(2, before.sets.length - 1),
      )
      const weightBefore = before.sets[0]?.weightKg
      const weightAfter = exercise.sets[0]?.weightKg
      if (weightBefore !== null && weightBefore !== undefined) {
        // Nie ostra nierówność: przy 5 kg dziesięć procent to 0,5 kg, a krok
        // obciążenia wynosi 2,5 kg — zaokrąglenie zostawia tę samą liczbę.
        expect(weightAfter as number, exercise.exerciseId).toBeLessThanOrEqual(weightBefore)
      } else {
        expect(weightAfter, exercise.exerciseId).toBeNull()
      }
    }

    // Przynajmniej najcięższe ćwiczenie musi faktycznie zejść w dół.
    const heaviest = normal.exercises.findIndex((e) => (e.sets[0]?.weightKg ?? 0) >= 20)
    expect(heaviest).toBeGreaterThanOrEqual(0)
    expect(deload.exercises[heaviest]?.sets[0]?.weightKg as number).toBeLessThan(
      normal.exercises[heaviest]?.sets[0]?.weightKg as number,
    )
  })

  it('powtórzeń i tempa deload NIE rusza', () => {
    const deload = workoutSession({ workout: WORKOUT_B, load: weekLoad(3, 4, 'cut') })
    for (const [index, exercise] of deload.exercises.entries()) {
      const source = WORKOUT_B.slots[index]?.main as WorkoutExercise
      expect(exercise.sets[0]?.reps, source.id).toBe(source.reps)
    }
  })

  it('ciężar z logu wygrywa z ciężarem startowym z arkusza', () => {
    const first = WORKOUT_A.slots[0]?.main as WorkoutExercise
    const payload = workoutSession({
      workout: WORKOUT_A,
      load: weekLoad(0, 2, 'cut'),
      knownLoads: new Map([[first.id, 45]]),
    })
    expect(payload.exercises[0]?.sets[0]?.weightKg).toBe(45)
  })

  it('ćwiczenie bez ciężaru w arkuszu zostaje bez ciężaru', () => {
    // Masa własnego ciała i „Gryf + …" — plan nie ma tu czego wpisać, a wpisanie
    // zera albo zgadniętej liczby byłoby daniem użytkownikowi fałszywej wartości.
    const bodyweight = [...WORKOUT_EXERCISES_BY_ID.values()].filter(
      (e) => e.startWeightKg === null,
    )
    expect(bodyweight.length).toBeGreaterThan(0)
    for (const exercise of bodyweight) {
      const planned = plannedWorkoutExercise(exercise)
      expect(planned.sets.every((s) => s.weightKg === null), exercise.id).toBe(true)
    }
  })

  it('alternatywa wchodzi z WŁASNYMI parametrami', () => {
    const slot = WORKOUT_A.slots[0] as (typeof WORKOUT_A.slots)[number]
    const alternative = slot.alternatives[0] as WorkoutExercise
    const planned = plannedWorkoutExercise(alternative)

    expect(planned.exerciseId).toBe(alternative.id)
    expect(planned.sets).toHaveLength(alternative.sets)
    expect(planned.sets[0]?.reps).toBe(alternative.reps)
    expect(planned.sets[0]?.weightKg).toBe(alternative.startWeightKg)
    // Nie odziedziczyła ciężaru ćwiczenia głównego — Glute Bridge nie robi się
    // na 30 kg, bo tyle wychodziło na Hip Thruście.
    expect(planned.sets[0]?.weightKg).not.toBe(slot.main.startWeightKg)
  })

  it('exerciseFor wybiera wariant, a bez wyboru ćwiczenie główne', () => {
    const slot = WORKOUT_B.slots[1] as (typeof WORKOUT_B.slots)[number]
    expect(exerciseFor(slot).id).toBe(slot.main.id)
    expect(exerciseFor(slot, slot.alternatives[1]?.id).id).toBe(slot.alternatives[1]?.id)
    // Nieznany identyfikator nie wywala sesji — wraca ćwiczenie główne.
    expect(exerciseFor(slot, 'nie-ma-takiego').id).toBe(slot.main.id)
  })

  it('szacowany czas obejmuje rozgrzewkę i mieści się w godzinie z sensem', () => {
    for (const workout of [WORKOUT_A, WORKOUT_B]) {
      const payload = workoutSession({ workout, load: weekLoad(0, 2, 'cut') })
      expect(payload.estimatedMinutes, workout.id).toBeGreaterThan(WARMUP_MINUTES)
      expect(payload.estimatedMinutes, workout.id).toBeLessThan(120)
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Cardio
// ════════════════════════════════════════════════════════════════════

describe('runSession', () => {
  it('bieg spokojny to strefa 2 bez interwałów', () => {
    const easy = runSession('intermediate', weekLoad(0, 12, 'maintain'), 'easy')
    expect(easy.zone).toBe(2)
    expect(easy.intervals).toBeNull()
  })

  it('interwały to strefa 4 z opisem odcinków', () => {
    const intervals = runSession('intermediate', weekLoad(0, 12, 'maintain'), 'intervals')
    expect(intervals.zone).toBe(4)
    expect(intervals.intervals).toMatch(/\d+×400 m/)
    expect(intervals.targetPaceSecPerKm).toBeLessThan(
      runSession('intermediate', weekLoad(0, 12, 'maintain'), 'easy').targetPaceSecPerKm,
    )
  })

  it('dystanse są zaokrąglone do 100 m', () => {
    for (let week = 0; week < 12; week++) {
      for (const variant of ['easy', 'intervals'] as const) {
        const session = runSession('advanced', weekLoad(week, 12, 'maintain'), variant)
        expect(session.distanceM % 100, `tydzień ${week} ${variant}`).toBe(0)
      }
    }
  })

  it('deload skraca bieg', () => {
    const hard = runSession('intermediate', weekLoad(2, 12, 'maintain'), 'easy')
    const deload = runSession('intermediate', weekLoad(3, 12, 'maintain'), 'easy')
    expect(deload.distanceM).toBeLessThan(hard.distanceM)
  })

  it('dystans narasta między blokami', () => {
    const block0 = runSession('intermediate', weekLoad(0, 12, 'maintain'), 'easy')
    const block2 = runSession('intermediate', weekLoad(8, 12, 'maintain'), 'easy')
    expect(block2.distanceM).toBeGreaterThan(block0.distanceM)
  })

  it('tempo poprawia się przy wyższej intensywności (mniej sekund na km)', () => {
    const early = runSession('intermediate', weekLoad(0, 12, 'maintain'), 'easy')
    const late = runSession('intermediate', weekLoad(10, 12, 'maintain'), 'easy')
    expect(late.targetPaceSecPerKm).toBeLessThan(early.targetPaceSecPerKm)
  })

  it('czas trwania zgadza się z dystansem i tempem', () => {
    const easy = runSession('advanced', weekLoad(0, 12, 'maintain'), 'easy')
    expect(easy.durationSec).toBe(Math.round((easy.distanceM / 1000) * easy.targetPaceSecPerKm))
  })

  it('początkujący biega krócej niż zaawansowany', () => {
    const load = weekLoad(0, 12, 'maintain')
    expect(runSession('beginner', load, 'easy').distanceM).toBeLessThan(
      runSession('advanced', load, 'easy').distanceM,
    )
  })
})

describe('runSession z punktem wyjścia użytkownika', () => {
  const load = weekLoad(0, 12, 'maintain')
  // Biega 5 km w tempie 6:30/km.
  const baseline = { distanceM: 5000, paceSecPerKm: 390 }

  it('bierze dystans z podanych danych, nie z presetu doświadczenia', () => {
    const withBaseline = runSession('advanced', load, 'easy', baseline)
    const preset = runSession('advanced', load, 'easy')
    expect(withBaseline.distanceM).toBe(5000)
    expect(withBaseline.distanceM).not.toBe(preset.distanceM)
  })

  it('bieg spokojny jest WOLNIEJSZY od podanego tempa', () => {
    // Podane tempo to tempo z wysiłkiem. Strefa 2 musi być od niego wolniejsza,
    // inaczej „spokojny" bieg byłby co tydzień biegiem na czas.
    const easy = runSession('intermediate', load, 'easy', baseline)
    expect(easy.targetPaceSecPerKm).toBeGreaterThan(baseline.paceSecPerKm)
    expect(easy.zone).toBe(2)
  })

  it('interwały są SZYBSZE od podanego tempa', () => {
    const intervals = runSession('intermediate', load, 'intervals', baseline)
    expect(intervals.targetPaceSecPerKm).toBeLessThan(baseline.paceSecPerKm)
    expect(intervals.zone).toBe(4)
  })

  it('tempo poprawia się w kolejnych blokach', () => {
    const early = runSession('intermediate', weekLoad(0, 12, 'maintain'), 'easy', baseline)
    const late = runSession('intermediate', weekLoad(10, 12, 'maintain'), 'easy', baseline)
    expect(late.targetPaceSecPerKm).toBeLessThan(early.targetPaceSecPerKm)
  })
})

describe('swimSession z punktem wyjścia użytkownika', () => {
  const load = weekLoad(0, 12, 'maintain')
  // Przepływa 10 długości basenu 25 m = 250 m ciągiem, klasykiem.
  const baseline = { laps: 10, poolLengthM: 25 as const, stroke: 'breaststroke' as const }

  it('dystans sesji wynika z tego, ile przepływa ciągiem', () => {
    const session = swimSession('beginner', load, baseline)
    // Praca w seriach pozwala pokryć więcej niż bez przerwy.
    expect(session.distanceM).toBeGreaterThan(250)
    expect(session.distanceM % 50).toBe(0)
  })

  it('używa stylu, który podała — nie zgaduje z doświadczenia', () => {
    expect(swimSession('advanced', load, baseline).stroke).toBe('breaststroke')
    // Bez danych wraca do presetu.
    expect(swimSession('advanced', load).stroke).toBe('freestyle')
  })

  it('serie to długości „tam i z powrotem"', () => {
    const session = swimSession('intermediate', load, baseline)
    expect(session.sets).toBe(Math.round(session.distanceM / (baseline.poolLengthM * 2)))
  })

  it('basen 50 m daje dwa razy większy dystans przy tej samej liczbie długości', () => {
    const short = swimSession('intermediate', load, { ...baseline, poolLengthM: 25 })
    const long = swimSession('intermediate', load, { ...baseline, poolLengthM: 50 })
    expect(long.distanceM).toBeGreaterThan(short.distanceM * 1.8)
  })

  it('deload skraca dystans także przy własnych danych', () => {
    expect(swimSession('intermediate', weekLoad(3, 12, 'maintain'), baseline).distanceM).toBeLessThan(
      swimSession('intermediate', weekLoad(2, 12, 'maintain'), baseline).distanceM,
    )
  })
})

describe('swimSession', () => {
  it('dystans jest wielokrotnością długości basenu', () => {
    // Wielokrotność długości basenu, nie okrągłych 50 m: w basenie 25 m
    // dystans 825 m jest wykonalny, a wymuszanie kroku 50 m nie ma sensu.
    for (let week = 0; week < 12; week++) {
      const short = swimSession('intermediate', weekLoad(week, 12, 'maintain'), {
        laps: 20,
        poolLengthM: 25,
        stroke: 'freestyle',
      })
      expect(short.distanceM % 25, `25 m, tydzień ${week}`).toBe(0)

      const long = swimSession('intermediate', weekLoad(week, 12, 'maintain'), {
        laps: 10,
        poolLengthM: 50,
        stroke: 'freestyle',
      })
      expect(long.distanceM % 50, `50 m, tydzień ${week}`).toBe(0)
    }
  })

  it('początkujący dostaje dowolny styl, wyżej kraul', () => {
    const load = weekLoad(0, 12, 'maintain')
    expect(swimSession('beginner', load).stroke).toBe('any')
    expect(swimSession('advanced', load).stroke).toBe('freestyle')
  })

  it('deload skraca dystans', () => {
    expect(swimSession('intermediate', weekLoad(3, 12, 'maintain')).distanceM).toBeLessThan(
      swimSession('intermediate', weekLoad(2, 12, 'maintain')).distanceM,
    )
  })

  it('liczba serii mieści się w rozsądnym zakresie', () => {
    for (const experience of ['beginner', 'intermediate', 'advanced'] as const) {
      for (let week = 0; week < 12; week++) {
        const session = swimSession(experience, weekLoad(week, 12, 'maintain'))
        expect(session.sets, `${experience} tydzień ${week}`).toBeGreaterThanOrEqual(4)
        expect(session.sets, `${experience} tydzień ${week}`).toBeLessThanOrEqual(16)
      }
    }
  })

  it('KRYTYCZNE: dystans dzieli się na serie bez reszty, w całych długościach', () => {
    // Dwie regresje naraz: (1) przycięcie serii dawało „2200 m, 20 serii
    // po 50 m" = 1000 m; (2) dzielenie zaokrąglonego dystansu dawało 170 m
    // na serię, czyli 6,8 długości basenu — odcinek niewykonalny.
    for (const poolLengthM of [25, 50] as const) {
      for (const laps of [6, 10, 20, 40]) {
        for (let week = 0; week < 12; week++) {
          const session = swimSession('intermediate', weekLoad(week, 12, 'maintain'), {
            laps,
            poolLengthM,
            stroke: 'freestyle',
          })
          const label = `basen ${poolLengthM} m, ${laps} dł., tydzień ${week}`
          const perSet = session.distanceM / session.sets
          expect(Number.isInteger(perSet), `${label}: ${perSet} m na serię`).toBe(true)
          expect(perSet % poolLengthM, `${label}: ${perSet} m na serię`).toBe(0)
          expect(session.sets, label).toBeGreaterThanOrEqual(4)
          expect(session.sets, label).toBeLessThanOrEqual(16)
        }
      }
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Generator planu
// ════════════════════════════════════════════════════════════════════

describe('generatePlan', () => {
  // 2026-08-01 to SOBOTA, czyli pierwszy dzień tygodnia w tej aplikacji —
  // plan nie ma wtedy częściowego pierwszego tygodnia.
  const START = '2026-08-01'

  function plan(patch: Partial<Profile> = {}, weeks?: number) {
    return generatePlan({
      profile: profile({ equipment: ['gym', 'dumbbells', 'home', 'running'], ...patch }),
      startDate: START,
      workouts: WORKOUTS,
      ...(weeks === undefined ? {} : { weeks }),
      seed: 'plan-test',
    })
  }

  it('domyślnie generuje dwa pełne tygodnie', () => {
    // Dwa tygodnie, bo dalsze i tak wynikają z tego, co zostanie zalogowane —
    // dłuższy horyzont byłby wydrukiem założeń, nie planem.
    const result = plan()
    expect(DEFAULT_PLAN_WEEKS).toBe(2)
    expect(result.weeks).toBe(DEFAULT_PLAN_WEEKS)
    expect(result.sessions).toHaveLength(DEFAULT_PLAN_WEEKS * 7)
  })

  it('pierwszym dniem tygodnia planu jest sobota', () => {
    const result = plan({}, 4)
    for (const weekIndex of [0, 1, 2, 3]) {
      const week = result.sessions.filter((s) => s.weekIndex === weekIndex)
      const first = week.reduce((earliest, s) => (s.date < earliest.date ? s : earliest), week[0]!)
      expect(isoWeekday(first.date), `tydzień ${weekIndex}`).toBe(6)
    }
  })

  it('dzień tygodnia każdej sesji zgadza się z jej datą', () => {
    const result = plan()
    expect(verifyWeekdayAlignment(result)).toBe(true)
    for (const session of result.sessions) {
      expect(isoWeekday(session.date)).toBe(session.dayOfWeek)
    }
  })

  it('nie tworzy sesji przed datą startu', () => {
    // Środa — pierwszy tydzień musi być częściowy.
    const partial = generatePlan({
      profile: profile({ equipment: ['gym', 'running'], availableDays: [1, 3, 5] }),
      startDate: '2026-08-05',
      workouts: WORKOUTS,
      seed: 'partial',
    })
    expect(partial.sessions.every((s) => s.date >= '2026-08-05')).toBe(true)
    expect(partial.sessions.length).toBeLessThan(DEFAULT_PLAN_WEEKS * 7)
  })

  it('zawiera tygodnie deloadu', () => {
    // Deload wypada w co czwartym tygodniu, więc widać go dopiero na planie
    // dłuższym niż domyślne dwa tygodnie. W planach dwutygodniowych rytm
    // podtrzymuje `blockOffsetWeeks` przy odnowieniu — patrz `planRepo`.
    const phases = new Set(plan({}, 12).sessions.map((s) => s.phase))
    expect(phases.has('accumulation')).toBe(true)
    expect(phases.has('deload')).toBe(true)
  })

  /**
   * ŚWIADOMA UTRATA ZDOLNOŚCI: plan nie filtruje ćwiczeń po kontuzjach.
   *
   * Poprzednia wersja dobierała ćwiczenia z katalogu i wykluczała te
   * z przeciwwskazaniem do zgłoszonej kontuzji (kolano, dno miednicy…).
   * Trening A i B są napisane przez trenera dla konkretnej osoby — z uwagami
   * fizjoterapeutycznymi przy każdym ćwiczeniu — więc aplikacja nie ma czego
   * ani prawa z nich wycinać. Zgłoszone kontuzje wpływają nadal na CARDIO
   * (przy `pelvicFloor` nie ma interwałów biegowych).
   *
   * Test pilnuje, żeby nikt nie założył filtrowania, którego nie ma: profil
   * z kontuzjami dostaje ten sam trening co profil bez nich.
   */
  it('KRYTYCZNE: kontuzje nie zmieniają treningu z arkusza — zmieniają cardio', () => {
    const healthy = plan({ equipment: ['gym', 'running'], availableDays: [1, 2, 4, 6] })
    const injured = plan({
      injuries: ['knee', 'pelvicFloor'],
      equipment: ['gym', 'running'],
      availableDays: [1, 2, 4, 6],
    })

    const strengthIds = (result: typeof healthy) =>
      result.sessions
        .filter((s) => s.payload.kind === 'strength')
        .flatMap((s) => (s.payload as StrengthPayload).exercises.map((e) => e.exerciseId))

    expect(strengthIds(injured)).toEqual(strengthIds(healthy))
    expect(strengthIds(injured).length).toBeGreaterThan(0)

    // Cardio nadal reaguje: przy ograniczeniu dna miednicy nie ma interwałów.
    const runs = injured.sessions.filter((s) => s.payload.kind === 'run')
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      expect((run.payload as RunPayload).intervals).toBeNull()
    }
  })

  it('sesja siłowa to komplet ćwiczeń z arkusza, nie docięty do budżetu czasu', () => {
    // Docinanie do `sessionMinutes` zniknęło razem z generatorem: wycinanie
    // ćwiczeń, które trener wpisał świadomie, byłoby cichą zmianą planu.
    const result = plan({ sessionMinutes: 30, equipment: ['gym'], availableDays: [1, 2, 4, 6] })
    const strength = result.sessions.find((s) => s.payload.kind === 'strength')
    expect((strength?.payload as StrengthPayload).exercises).toHaveLength(5)
    // Zamiast ciąć — ostrzega, że sesja nie mieści się w budżecie.
    expect(result.warnings.join(' ')).toMatch(/minut, a w profilu masz 30 min/)
  })

  it('ostrzega, gdy reguła odstępów odebrała zaplanowaną sesję', () => {
    // Pięć dni pod rząd bez sprzętu cardio: reguła „max 2 ciężkie z rzędu"
    // musi odebrać sesje — i powiedzieć o tym wprost.
    const result = plan({
      availableDays: [1, 2, 3, 4, 5],
      activityLevel: 'high',
      experience: 'intermediate', // 5 sesji
      equipment: ['gym', 'dumbbells', 'home'],
    })
    expect(result.warnings.join(' ')).toMatch(/Zaplanowano \d+ z 5 sesji/)
  })

  it('nie ostrzega o cardio, gdy obie dyscypliny weszły', () => {
    const result = plan({
      equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
      availableDays: [1, 2, 4, 5],
    })
    expect(result.warnings.join(' ')).not.toMatch(/nie weszło do planu/)
  })

  it('ostrzega, gdy zaznaczonych dni jest mniej niż wyliczonych sesji', () => {
    const result = plan({
      availableDays: [1, 4],
      activityLevel: 'veryHigh',
      experience: 'advanced', // 6 sesji
      equipment: ['gym', 'dumbbells', 'home', 'running'],
    })
    expect(result.warnings.join(' ')).toMatch(
      /daje 6 sesji w tygodniu, ale w profilu masz zaznaczone 2 dni/,
    )
  })

  it('nie ostrzega, gdy wszystkie zaplanowane sesje weszły do planu', () => {
    const result = plan({
      availableDays: [1, 2, 4, 5],
      equipment: ['gym', 'dumbbells', 'home', 'running'],
    })
    expect(result.warnings.join(' ')).not.toMatch(/Zaplanowano/)
  })

  it('bez dostępnych ćwiczeń zamienia sesje siłowe na odpoczynek i ostrzega', () => {
    const result = generatePlan({
      profile: profile({ equipment: ['running'], availableDays: [1, 3, 5] }),
      startDate: START,
      workouts: WORKOUTS,
      seed: 'no-gear',
    })
    expect(result.sessions.some((s) => s.type === 'strength')).toBe(false)
    expect(result.sessions.some((s) => s.type === 'run')).toBe(true)
  })

  it('struktura tygodnia jest stała przez cały plan', () => {
    // Bez tego nie da się śledzić progresji na tych samych ćwiczeniach.
    const result = plan({}, 12)
    const week0 = result.sessions.filter((s) => s.weekIndex === 0)
    const week5 = result.sessions.filter((s) => s.weekIndex === 5)
    expect(week5.map((s) => `${s.dayOfWeek}:${s.type}`)).toEqual(
      week0.map((s) => `${s.dayOfWeek}:${s.type}`),
    )
  })

  it('te same ćwiczenia wracają w kolejnych tygodniach', () => {
    const result = plan({}, 12)
    const idsFor = (week: number) =>
      result.sessions
        .filter((s) => s.weekIndex === week && s.payload.kind === 'strength')
        .flatMap((s) => (s.payload as StrengthPayload).exercises.map((e) => e.exerciseId))
    expect(idsFor(4)).toEqual(idsFor(0))
  })

  it('cel „zawody" liczy długość planu wstecz od daty startu', () => {
    const result = generatePlan({
      profile: profile({
        goal: 'event',
        eventDate: '2026-10-05', // 65 dni od soboty 2026-08-01 → 10 tygodni
        equipment: ['gym', 'running'],
      }),
      startDate: START,
      workouts: WORKOUTS,
      seed: 'event',
    })
    expect(result.weeks).toBe(10)
    const lastWeekPhases = result.sessions
      .filter((s) => s.weekIndex === result.weeks - 1)
      .map((s) => s.phase)
    expect(new Set(lastWeekPhases)).toEqual(new Set(['taper']))
  })

  it('ostrzega o dacie zawodów w przeszłości', () => {
    const result = generatePlan({
      profile: profile({ goal: 'event', eventDate: '2026-01-01', equipment: ['gym'] }),
      startDate: START,
      workouts: WORKOUTS,
      seed: 'past-event',
    })
    expect(result.weeks).toBe(DEFAULT_PLAN_WEEKS)
    expect(result.warnings.join(' ')).toContain('przeszłości')
  })

  it('jest deterministyczny dla tego samego ziarna', () => {
    const a = plan()
    const b = plan()
    expect(JSON.stringify(a.sessions)).toBe(JSON.stringify(b.sessions))
  })

  it('nextTrainingSession pomija dni odpoczynku', () => {
    const result = plan({ availableDays: [1, 3, 5] })
    // 2026-08-04 to wtorek — dzień wolny w tym rozkładzie.
    const next = nextTrainingSession(result, '2026-08-04')
    expect(next).not.toBeNull()
    expect(next?.type).not.toBe('rest')
    expect(next?.date).toBe('2026-08-05')
  })

  it('sesje cardio mają poprawny typ payloadu', () => {
    const result = plan({ equipment: ['gym', 'running', 'pool'], goal: 'conditioning' })
    for (const session of result.sessions) {
      if (session.type === 'run') expect((session.payload as RunPayload).kind).toBe('run')
      if (session.type === 'swim') expect((session.payload as SwimPayload).kind).toBe('swim')
      if (session.type === 'rest') expect(session.payload.kind).toBe('rest')
    }
  })
})

// ════════════════════════════════════════════════════════════════════
//  Progresja z danych
// ════════════════════════════════════════════════════════════════════

describe('evaluateProgression', () => {
  it('plan wykonany przy RPE ≤ 8 → dokładamy obciążenie', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 80),
      logged: [setLog(8, 80, 7), setLog(8, 80, 7.5), setLog(8, 80, 8), setLog(8, 80, 8)],
      pattern: 'horizontalPush',
    })
    expect(result.verdict).toBe('advance')
    expect(result.suggestedWeightKg).toBe(82.5)
  })

  it('dolne partie dostają skok procentowy, nie stały', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 6, 140),
      logged: [setLog(6, 140, 7), setLog(6, 140, 7), setLog(6, 140, 8), setLog(6, 140, 8)],
      pattern: 'squat',
    })
    // 5% z 140 kg = 7 kg → zaokrąglone do 7,5 kg
    expect(result.verdict).toBe('advance')
    expect(result.suggestedWeightKg).toBe(147.5)
  })

  it('plan wykonany, ale przy zbyt wysokim RPE → powtarzamy tydzień', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 80),
      logged: [setLog(8, 80, 9), setLog(8, 80, 9.5), setLog(8, 80, 9.5), setLog(8, 80, 10)],
      pattern: 'horizontalPush',
    })
    expect(result.verdict).toBe('hold')
    expect(result.suggestedWeightKg).toBe(80)
  })

  it('niepełna liczba serii → powtarzamy tydzień', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 80),
      logged: [setLog(8, 80, 7), setLog(8, 80, 7)],
      pattern: 'horizontalPush',
    })
    expect(result.verdict).toBe('hold')
    expect(result.reason).toContain('2 z 4')
  })

  it('powtórzenia poniżej zakresu → cofamy obciążenie', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 100),
      logged: [setLog(8, 100, 9), setLog(6, 100, 10), setLog(4, 100, 10), setLog(4, 100, 10)],
      pattern: 'horizontalPush',
    })
    expect(result.verdict).toBe('regress')
    expect(result.suggestedWeightKg).toBe(90)
  })

  it('brak logów → nic nie zmieniamy', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 80),
      logged: [],
      pattern: 'squat',
    })
    expect(result.verdict).toBe('hold')
    expect(result.suggestedWeightKg).toBeNull()
  })

  it('brak RPE w logach nie blokuje progresji', () => {
    const result = evaluateProgression({
      planned: plannedSets(3, 10, 60),
      logged: [setLog(10, 60), setLog(10, 60), setLog(10, 60)],
      pattern: 'horizontalPull',
    })
    expect(result.verdict).toBe('advance')
    expect(result.suggestedWeightKg).toBe(62.5)
  })

  it('masa własna: progresja idzie w powtórzenia, nie w kilogramy', () => {
    const result = evaluateProgression({
      planned: plannedSets(3, 12, null),
      logged: [setLog(12, null, 7), setLog(12, null, 7), setLog(12, null, 8)],
      pattern: 'core',
    })
    expect(result.verdict).toBe('advance')
    expect(result.suggestedWeightKg).toBeNull()

    const next = applyProgression(plannedSets(3, 12, null), result)
    expect(next.every((s) => s.reps === 13)).toBe(true)
    expect(next.every((s) => s.weightKg === null)).toBe(true)
  })

  it('sugerowany ciężar jest zawsze wielokrotnością kroku', () => {
    for (const weight of [37, 52.5, 61, 103, 137]) {
      const result = evaluateProgression({
        planned: plannedSets(3, 8, weight),
        logged: [setLog(8, weight, 7), setLog(8, weight, 7), setLog(8, weight, 7)],
        pattern: 'squat',
      })
      const suggested = result.suggestedWeightKg as number
      expect(suggested % WEIGHT_STEP_KG, `${weight} kg → ${suggested}`).toBe(0)
    }
  })

  it('applyProgression nakłada ciężar na wszystkie serie', () => {
    const result = evaluateProgression({
      planned: plannedSets(4, 8, 80),
      logged: [setLog(8, 80, 7), setLog(8, 80, 7), setLog(8, 80, 7), setLog(8, 80, 7)],
      pattern: 'horizontalPush',
    })
    const next = applyProgression(plannedSets(4, 8, 80), result)
    expect(next.every((s) => s.weightKg === 82.5)).toBe(true)
  })

  it('KRYTYCZNE: w deloadzie progresja wchodzi OBNIŻONA, nie podniesiona', () => {
    /**
     * REGRESJA. Progresja wpisywała podniesiony ciężar także w tydzień deloadu,
     * więc „tydzień lżejszy" wychodził CIĘŻSZY od poprzedniego: przy 40 kg
     * i skoku 2,5 kg deload dostawał 42,5 kg zamiast 35 kg. Zostawała mu jedna
     * seria mniej — a to nie deload, tylko krótszy trening z rekordowym ciężarem.
     * Rytm 3 + 1 przestawał wtedy istnieć, choć plan nadal go pokazywał.
     */
    const result = evaluateProgression({
      planned: plannedSets(3, 8, 40),
      logged: [setLog(8, 40, 7), setLog(8, 40, 7), setLog(8, 40, 7)],
      pattern: 'hinge',
    })
    expect(result.verdict).toBe('advance')
    const progressed = result.suggestedWeightKg as number
    expect(progressed).toBeGreaterThan(40)

    const accumulation = applyProgression(plannedSets(3, 8, 40), result)
    const deload = applyProgression(plannedSets(2, 8, 35), result, { deload: true })

    // Deload jest lżejszy i od akumulacji, i od tego, co dyktuje progresja.
    expect(deload[0]?.weightKg).toBe(deloadWeight(progressed))
    expect(deload[0]?.weightKg as number).toBeLessThan(accumulation[0]?.weightKg as number)
    expect(deload[0]?.weightKg as number).toBeLessThan(40)
    // Wszystkie serie tak samo — nie tylko pierwsza.
    expect(deload.every((s) => s.weightKg === deloadWeight(progressed))).toBe(true)
  })

  it('w deloadzie nie dokładamy też powtórzeń przy masie własnej', () => {
    // Ćwiczenie bez ciężaru: postęp zapisuje się powtórzeniem. W deloadzie
    // dokładanie powtórzeń jest tym samym błędem, co dokładanie kilogramów.
    const result = evaluateProgression({
      planned: plannedSets(3, 12, null),
      logged: [setLog(12, null, 7), setLog(12, null, 7), setLog(12, null, 7)],
      pattern: 'core',
    })
    expect(result.verdict).toBe('advance')
    expect(result.suggestedWeightKg).toBeNull()

    expect(applyProgression(plannedSets(3, 12, null), result)[0]?.reps).toBe(13)
    expect(applyProgression(plannedSets(2, 12, null), result, { deload: true })[0]?.reps).toBe(12)
  })

  it('deloadWeight zdejmuje 10% i trzyma się kroku obciążenia', () => {
    expect(DELOAD_LOAD_FACTOR).toBe(0.9)
    for (const weight of [20, 40, 42.5, 62.5, 100]) {
      const reduced = deloadWeight(weight)
      expect(reduced, `${weight} kg`).toBeLessThan(weight)
      expect(reduced % WEIGHT_STEP_KG, `${weight} kg → ${reduced}`).toBe(0)
      // Zaokrąglenie W DÓŁ: nigdy powyżej dokładnych 90% i nie dalej niż o krok.
      expect(reduced).toBeLessThanOrEqual(weight * DELOAD_LOAD_FACTOR)
      expect(reduced).toBeGreaterThan(weight * DELOAD_LOAD_FACTOR - WEIGHT_STEP_KG)
    }
  })
})

describe('trainingVolumeKg', () => {
  it('sumuje ciężar × powtórzenia', () => {
    expect(trainingVolumeKg([setLog(8, 80), setLog(8, 80), setLog(6, 90)])).toBe(8 * 80 * 2 + 6 * 90)
  })

  it('ćwiczenia z masą własną nie wnoszą objętości w kilogramach', () => {
    expect(trainingVolumeKg([setLog(12, null), setLog(12, null)])).toBe(0)
  })
})
