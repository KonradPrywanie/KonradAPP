import { describe, expect, it } from 'vitest'
import type {
  BodyMeasurement,
  BodyMetric,
  CardioLog,
  MealLog,
  SessionLog,
  SessionStatus,
  SessionType,
  SetLog,
} from '../types'
import {
  adherence,
  bodyMetricSeries,
  dailyKcal,
  measuredMetrics,
  weeklyDistance,
  weeklyVolume,
  withinRange,
} from './aggregate'

const NOW = '2026-08-01T10:00:00.000Z'

/**
 * Log sesji Z PLANU — `plannedSessionId` jest ustawione.
 * Do treningów poza planem służy `extraLog()`.
 */
function log(
  id: string,
  date: string,
  status: SessionStatus = 'done',
  type: SessionType = 'strength',
  deleted = false,
): SessionLog {
  return {
    id,
    plannedSessionId: `ps-${id}`,
    date,
    type,
    status,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

/** Log treningu dopisanego poza planem. */
function extraLog(
  id: string,
  date: string,
  type: SessionType = 'walk',
  deleted = false,
): SessionLog {
  return { ...log(id, date, 'done', type, deleted), plannedSessionId: null }
}

function set(
  sessionLogId: string,
  exerciseId: string,
  reps: number,
  weightKg: number | null,
  deleted = false,
): SetLog {
  return {
    id: `${sessionLogId}-${exerciseId}-${reps}-${weightKg}`,
    sessionLogId,
    exerciseId,
    setIndex: 0,
    reps,
    weightKg,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

function cardio(sessionLogId: string, distanceM: number, deleted = false): CardioLog {
  return {
    id: `${sessionLogId}-c`,
    sessionLogId,
    distanceM,
    durationSec: 1800,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

function meal(
  date: string,
  kcal: number,
  source: 'plan' | 'manual',
  deleted = false,
): MealLog {
  return {
    id: `${date}-${kcal}-${source}`,
    date,
    slot: 'lunch',
    plannedMealId: source === 'plan' ? 'pm1' : null,
    source,
    macros: { kcal, proteinG: 0, fatG: 0, carbsG: 0 },
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: deleted ? NOW : null,
  }
}

describe('withinRange', () => {
  const items = [
    { date: '2026-08-30' },
    { date: '2026-08-01' },
    { date: '2026-06-01' },
    { date: '2026-09-05' }, // przyszłość
  ]

  it('bierze ostatnie N dni licząc od dziś', () => {
    expect(withinRange(items, '2026-08-30', 30).map((i) => i.date)).toEqual([
      '2026-08-30',
      '2026-08-01',
    ])
  })

  it('null oznacza całą historię', () => {
    expect(withinRange(items, '2026-08-30', null)).toHaveLength(4)
  })

  it('pomija daty z przyszłości', () => {
    expect(withinRange(items, '2026-08-30', 30).map((i) => i.date)).not.toContain('2026-09-05')
  })

  it('zakres 7 dni obejmuje tylko ostatni tydzień', () => {
    expect(withinRange(items, '2026-08-30', 7).map((i) => i.date)).toEqual(['2026-08-30'])
  })
})

describe('weeklyVolume', () => {
  it('sumuje ciężar × powtórzenia w tygodniach od soboty', () => {
    // 2026-08-05 to środa, 2026-08-07 piątek — ten sam tydzień (od soboty
    // 2026-08-01). Piątek jest OSTATNIM dniem tygodnia, nie przedostatnim.
    const logs = [log('l1', '2026-08-05'), log('l2', '2026-08-07')]
    const sets = [
      set('l1', 'bench-press', 8, 80),
      set('l1', 'bench-press', 8, 80),
      set('l2', 'back-squat', 5, 100),
    ]

    const weeks = weeklyVolume(logs, sets)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]?.weekStart).toBe('2026-08-01')
    expect(weeks[0]?.volumeKg).toBe(8 * 80 * 2 + 5 * 100)
    expect(weeks[0]?.sets).toBe(3)
    expect(weeks[0]?.sessions).toBe(2)
  })

  it('uzupełnia tygodnie bez treningu zerami', () => {
    // Przerwa jest informacją; wykres z dziurą kłamałby o ciągłości.
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-24')]
    const sets = [set('l1', 'bench-press', 8, 80), set('l2', 'bench-press', 8, 85)]

    const weeks = weeklyVolume(logs, sets)
    expect(weeks.map((w) => w.weekStart)).toEqual([
      '2026-08-01',
      '2026-08-08',
      '2026-08-15',
      '2026-08-22',
    ])
    expect(weeks[1]?.volumeKg).toBe(0)
    expect(weeks[1]?.sessions).toBe(0)
  })

  it('ćwiczenia z masą własną nie wnoszą kilogramów, ale liczą się jako serie', () => {
    const logs = [log('l1', '2026-08-03')]
    const sets = [set('l1', 'plank', 30, null), set('l1', 'pushup', 20, null)]
    const weeks = weeklyVolume(logs, sets)
    expect(weeks[0]?.volumeKg).toBe(0)
    expect(weeks[0]?.sets).toBe(2)
  })

  it('pomija sesje pominięte i wpisy wycofane', () => {
    const logs = [
      log('l1', '2026-08-03'),
      log('l2', '2026-08-04', 'skipped'),
      log('l3', '2026-08-05', 'done', 'strength', true),
    ]
    const sets = [
      set('l1', 'bench-press', 8, 80),
      set('l2', 'bench-press', 8, 200),
      set('l3', 'bench-press', 8, 300),
      set('l1', 'back-squat', 5, 150, true),
    ]
    const weeks = weeklyVolume(logs, sets)
    expect(weeks[0]?.volumeKg).toBe(640)
    expect(weeks[0]?.sessions).toBe(1)
  })

  it('oznacza tygodnie deloadu przekazane z planu', () => {
    const logs = [log('l1', '2026-08-03'), log('l2', '2026-08-10')]
    const sets = [set('l1', 'bench-press', 8, 80), set('l2', 'bench-press', 8, 70)]
    // Tygodnie deloadu przychodzą z planu, więc też są datowane sobotą.
    const weeks = weeklyVolume(logs, sets, new Set(['2026-08-08']))
    expect(weeks[0]?.isDeload).toBe(false)
    expect(weeks[1]?.isDeload).toBe(true)
  })

  it('brak danych daje pustą listę, nie wyjątek', () => {
    expect(weeklyVolume([], [])).toEqual([])
    expect(weeklyVolume([log('l1', '2026-08-03', 'skipped')], [])).toEqual([])
  })
})

describe('bodyMetricSeries', () => {
  const ALL_METRICS: readonly BodyMetric[] = [
    'waistCm',
    'hipsCm',
    'chestCm',
    'thighCm',
    'armCm',
  ]

  function measurement(
    date: string,
    values: Partial<Record<BodyMetric, number>>,
    deleted = false,
  ): BodyMeasurement {
    return {
      id: `m-${date}`,
      date,
      ...values,
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: deleted ? NOW : null,
    }
  }

  it('sortuje po dacie i liczy zmianę od pierwszego do ostatniego pomiaru', () => {
    const rows = [
      measurement('2026-08-15', { waistCm: 77 }),
      measurement('2026-08-01', { waistCm: 80 }),
      measurement('2026-08-08', { waistCm: 78.5 }),
    ]

    const series = bodyMetricSeries(rows, 'waistCm')
    expect(series.points.map((p) => p.date)).toEqual([
      '2026-08-01',
      '2026-08-08',
      '2026-08-15',
    ])
    expect(series.first).toBe(80)
    expect(series.last).toBe(77)
    expect(series.changeCm).toBe(-3)
  })

  it('KRYTYCZNE: brakujące miary są pomijane, nie zerowane', () => {
    // „Nie mierzyłam talii" to nie „mam zero centymetrów w pasie" — dokładnie
    // ta sama zasada, co przy dniach bez zalogowanych kalorii.
    const rows = [
      measurement('2026-08-01', { waistCm: 80, hipsCm: 100 }),
      measurement('2026-08-08', { hipsCm: 99 }),
    ]

    const waist = bodyMetricSeries(rows, 'waistCm')
    expect(waist.points).toHaveLength(1)
    expect(waist.points.map((p) => p.valueCm)).toEqual([80])
    // Jeden punkt to brak zmiany, nie zmiana o 80 cm.
    expect(waist.changeCm).toBe(0)

    expect(bodyMetricSeries(rows, 'hipsCm').points).toHaveLength(2)
  })

  it('pomija wpisy usunięte miękko', () => {
    const rows = [
      measurement('2026-08-01', { waistCm: 80 }),
      measurement('2026-08-08', { waistCm: 60 }, true),
    ]
    const series = bodyMetricSeries(rows, 'waistCm')
    expect(series.points).toHaveLength(1)
    expect(series.last).toBe(80)
  })

  it('brak danych daje puste punkty i null-e, nie wyjątek', () => {
    const series = bodyMetricSeries([], 'waistCm')
    expect(series.points).toEqual([])
    expect(series.first).toBeNull()
    expect(series.last).toBeNull()
    expect(series.changeCm).toBeNull()
  })

  it('measuredMetrics zwraca tylko miary z pomiarami, w zadanej kolejności', () => {
    const rows = [
      measurement('2026-08-01', { hipsCm: 100 }),
      measurement('2026-08-08', { waistCm: 78 }),
      measurement('2026-08-15', { armCm: 30 }, true), // usunięty nie liczy się
    ]
    expect(measuredMetrics(rows, ALL_METRICS)).toEqual(['waistCm', 'hipsCm'])
    expect(measuredMetrics([], ALL_METRICS)).toEqual([])
  })
})

describe('weeklyDistance', () => {
  it('rozdziela bieganie, pływanie i spacer', () => {
    const logs = [
      log('l1', '2026-08-04', 'done', 'run'),
      log('l2', '2026-08-06', 'done', 'swim'),
      extraLog('l3', '2026-08-07', 'walk'),
    ]
    const entries = [cardio('l1', 6000), cardio('l2', 1200), cardio('l3', 4500)]

    const weeks = weeklyDistance(logs, entries)
    expect(weeks).toHaveLength(1)
    expect(weeks[0]).toMatchObject({
      weekStart: '2026-08-01',
      runM: 6000,
      swimM: 1200,
      walkM: 4500,
    })
  })

  it('KRYTYCZNE: spacer nie wpada do biegania', () => {
    // 6 km marszu z psem i 6 km biegu to inny wysiłek — zliczenie razem
    // zawyżałoby statystykę biegową.
    const logs = [extraLog('l1', '2026-08-04', 'walk')]
    const weeks = weeklyDistance(logs, [cardio('l1', 6000)])
    expect(weeks[0]?.walkM).toBe(6000)
    expect(weeks[0]?.runM).toBe(0)
  })

  it('sumuje kilka sesji w tygodniu', () => {
    const logs = [
      log('l1', '2026-08-04', 'done', 'run'),
      log('l2', '2026-08-06', 'done', 'run'),
    ]
    expect(weeklyDistance(logs, [cardio('l1', 6000), cardio('l2', 4000)])[0]?.runM).toBe(10000)
  })

  it('uzupełnia brakujące tygodnie zerami', () => {
    const logs = [
      log('l1', '2026-08-04', 'done', 'run'),
      log('l2', '2026-08-18', 'done', 'run'),
    ]
    const weeks = weeklyDistance(logs, [cardio('l1', 6000), cardio('l2', 7000)])
    expect(weeks).toHaveLength(3)
    expect(weeks[1]?.runM).toBe(0)
  })

  it('pomija pominięte sesje i wycofane pomiary', () => {
    const logs = [
      log('l1', '2026-08-04', 'skipped', 'run'),
      log('l2', '2026-08-05', 'done', 'run'),
    ]
    const weeks = weeklyDistance(logs, [cardio('l1', 9999), cardio('l2', 5000, true)])
    expect(weeks).toEqual([])
  })

  it('uzupełnia spacer zerem w tygodniach bez spaceru', () => {
    const logs = [log('l1', '2026-08-04', 'done', 'run')]
    expect(weeklyDistance(logs, [cardio('l1', 5000)])[0]?.walkM).toBe(0)
  })
})

describe('dailyKcal', () => {
  it('rozdziela wpisy z planu od odstępstw', () => {
    const logs = [
      meal('2026-08-03', 500, 'plan'),
      meal('2026-08-03', 700, 'plan'),
      meal('2026-08-03', 900, 'manual'),
    ]
    const days = dailyKcal(logs)
    expect(days).toHaveLength(1)
    expect(days[0]).toMatchObject({ date: '2026-08-03', fromPlan: 1200, manual: 900, total: 2100 })
  })

  it('KRYTYCZNE: dni bez logu są pomijane, nie zerowane', () => {
    // „Nie zalogowałem" ≠ „zjadłem zero" — wyzerowanie zafałszowałoby wykres.
    const days = dailyKcal([meal('2026-08-03', 2000, 'plan'), meal('2026-08-10', 2100, 'plan')])
    expect(days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-10'])
  })

  it('sortuje po dacie', () => {
    const days = dailyKcal([meal('2026-08-10', 2000, 'plan'), meal('2026-08-03', 2100, 'plan')])
    expect(days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-10'])
  })

  it('pomija wpisy wycofane', () => {
    const days = dailyKcal([
      meal('2026-08-03', 2000, 'plan'),
      meal('2026-08-03', 900, 'manual', true),
    ])
    expect(days[0]?.total).toBe(2000)
    expect(days[0]?.manual).toBe(0)
  })

  it('pusta historia daje pustą listę', () => {
    expect(dailyKcal([])).toEqual([])
  })
})

describe('adherence', () => {
  it('liczy statusy i udział wykonanych', () => {
    const logs = [
      log('l1', '2026-08-03', 'done'),
      log('l2', '2026-08-04', 'done'),
      log('l3', '2026-08-05', 'partial'),
      log('l4', '2026-08-06', 'skipped'),
    ]
    expect(adherence(logs)).toEqual({
      done: 2,
      partial: 1,
      skipped: 1,
      logged: 4,
      donePct: 50,
      extra: 0,
    })
  })

  it('KRYTYCZNE: treningi poza planem nie wliczają się do realizacji', () => {
    // Spacer z psem w dniu wolnym nie jest wykonaniem zaplanowanej sesji.
    // Wrzucenie go do „wykonanych" zawyżałoby realizację planu.
    const logs = [
      log('l1', '2026-08-03', 'done'),
      log('l2', '2026-08-04', 'skipped'),
      extraLog('e1', '2026-08-05', 'walk'),
      extraLog('e2', '2026-08-06', 'run'),
    ]
    expect(adherence(logs)).toEqual({
      done: 1,
      partial: 0,
      skipped: 1,
      logged: 2,
      donePct: 50,
      extra: 2,
    })
  })

  it('same treningi poza planem dają zerową realizację, ale są policzone', () => {
    const logs = [extraLog('e1', '2026-08-03'), extraLog('e2', '2026-08-04')]
    expect(adherence(logs)).toMatchObject({ logged: 0, donePct: 0, extra: 2 })
  })

  it('pomija wpisy wycofane', () => {
    const logs = [log('l1', '2026-08-03', 'done'), log('l2', '2026-08-04', 'skipped', 'strength', true)]
    expect(adherence(logs)).toMatchObject({ done: 1, skipped: 0, logged: 1, donePct: 100 })
  })

  it('brak danych nie dzieli przez zero', () => {
    expect(adherence([])).toEqual({
      done: 0,
      partial: 0,
      skipped: 0,
      logged: 0,
      donePct: 0,
      extra: 0,
    })
  })
})
