import type { Experience, Profile, SessionFocus, SessionType, Weekday, Workout } from '../types'
import { derivedWeeklySessions } from './sessionTarget'

export type RunVariant = 'easy' | 'intervals'

/** Górna granica sesji w tygodniu — siódmy dzień zostaje wolny (reguła R3). */
export const MAX_TRAINING_DAYS = 6

/**
 * Ile najwyżej sesji siłowych w tygodniu, gdy dostępne jest cardio.
 *
 * Dwie. Reszta dni idzie na bieganie i pływanie, żeby obie dyscypliny
 * wchodziły do planu w KAŻDYM tygodniu — przy większej liczbie sesji siłowych
 * jedna z nich systematycznie wypadała. Bez sprzętu do cardio limit nie
 * obowiązuje: wtedy siła bierze wszystkie dostępne dni.
 */
export const MAX_STRENGTH_DAYS_WITH_CARDIO = 2

export interface ScheduledDay {
  dayOfWeek: Weekday
  type: SessionType
  focus?: SessionFocus
  /** Który trening z arkusza (A/B) wypada w tym dniu. Tylko dla `strength`. */
  workoutId?: Workout['id']
  runVariant?: RunVariant
  /** Dzień wymagający — wejście do reguły „maksymalnie dwa z rzędu". */
  hard: boolean
}

/**
 * Kolejność treningów w tygodniu: pierwszy dzień siłowy to A, drugi B.
 *
 * Arkusz zakłada dwa treningi FBW z minimum 48 h przerwy — dokładnie tak, jak
 * stoją w stałym układzie (wtorek i czwartek). Przy trzech dniach siłowych
 * rotacja wraca do A, bo trzeciego treningu w arkuszu nie ma i aplikacja nie
 * będzie go wymyślać.
 */
const WORKOUT_ROTATION: readonly Workout['id'][] = ['A', 'B']

/** Jeden dzień stałego rozkładu. Dni poza układem są dniami odpoczynku. */
export interface WeekLayoutDay {
  dayOfWeek: Weekday
  type: Extract<SessionType, 'strength' | 'run' | 'swim'>
}

export type WeekLayout = readonly WeekLayoutDay[]

/**
 * STAŁY ROZKŁAD TYGODNIA — dni wskazane przez użytkownika, nie wynik algorytmu.
 *
 * Poniedziałek bieganie, wtorek i czwartek siłownia, sobota basen.
 *
 * Dlaczego jako DOMYŚLNY PARAMETR, a nie pole w profilu: to samo rozróżnienie,
 * co przy `BANNED_INGREDIENT_TERMS` w katalogu diety. Pola profilu dotyczą
 * tylko nowo zakładanych profili, a ta reguła ma obowiązywać od zaraz — także
 * dla profilu zapisanego już w przeglądarce, którego nikt nie będzie edytował.
 * Domena zostaje przy tym generyczna: `weeklySchedule` przyjmuje układ jako
 * argument, więc algorytm wyliczany z dostępnych dni żyje dalej (i jest
 * testowany) — wystarczy podać `null`.
 *
 * Układ obowiązuje tylko wtedy, gdy profil go UNIESIE: dni muszą być wśród
 * dostępnych, a każda dyscyplina musi mieć sprzęt (patrz `fixedLayoutApplies`).
 * Inaczej rozkład wraca do wyliczania z profilu — bo plan z basenem dla kogoś,
 * kto nie ma basenu, byłby planem do wyrzucenia.
 */
export const FIXED_WEEK_LAYOUT: WeekLayout = [
  { dayOfWeek: 1, type: 'run' },
  { dayOfWeek: 2, type: 'strength' },
  { dayOfWeek: 4, type: 'strength' },
  { dayOfWeek: 6, type: 'swim' },
]

const ALL_WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5, 6, 7]

/** Sesje obciążające nogi. Po nich nie stawiamy mocnego biegu. */
const LEG_HEAVY: readonly SessionFocus[] = ['lower', 'legs', 'glutes', 'full']

/** Ile sesji siłowych ma sens przy danym doświadczeniu. */
const MAX_STRENGTH_DAYS: Record<Experience, number> = {
  beginner: 3,
  intermediate: 4,
  advanced: 5,
}

/**
 * Rozkład tygodnia na typy sesji.
 *
 * Dwa źródła rozkładu, w tej kolejności:
 *  1. **stały układ** (`FIXED_WEEK_LAYOUT`) — dni podane wprost, gdy profil
 *     je uniesie. Tego chce użytkownik: poniedziałek bieg, wtorek i czwartek
 *     siłownia, sobota basen.
 *  2. **wyliczenie z profilu** — dostępne dni, aktywność, doświadczenie.
 *     Ścieżka dla każdego innego profilu; `weeklySchedule(profile, null)`
 *     wymusza ją wprost.
 *
 * Reguły kolizji, których naiwny generator nie ma i dlatego produkuje plany
 * niewykonalne w praktyce:
 *
 *  R1. Mocny bieg nie stoi dzień po sesji obciążającej nogi.
 *  R2. Nie ma trzech wymagających dni z rzędu (tydzień traktujemy cyklicznie —
 *      niedziela sąsiaduje z poniedziałkiem następnego tygodnia).
 *  R3. W tygodniu jest przynajmniej jeden dzień odpoczynku.
 *
 * Rozkład jest stały przez cały plan. To celowe: progresję da się śledzić
 * tylko wtedy, gdy te same ćwiczenia wracają w tym samym dniu tygodnia.
 * Zmienia się obciążenie, nie struktura.
 *
 * Funkcja jest w pełni deterministyczna — nie przyjmuje generatora losowego.
 * Rozstawienie sesji wynika z równomiernego podziału dostępnych dni, a nie
 * z losowania: losowy rozkład bywałby gorszy (dwie sesje nóg pod rząd),
 * a przy regeneracji planu przetasowałby cały tydzień bez powodu.
 * Losowość dotyczy wyłącznie doboru ćwiczeń — patrz `selectForPatterns`.
 */
export function weeklySchedule(
  profile: Profile,
  layout: WeekLayout | null = FIXED_WEEK_LAYOUT,
): ScheduledDay[] {
  const days =
    layout && fixedLayoutApplies(profile, layout)
      ? daysFromLayout(profile, layout)
      : derivedDays(profile)

  const schedule = ALL_WEEKDAYS.map(
    (dayOfWeek) => days.get(dayOfWeek) ?? { dayOfWeek, type: 'rest' as SessionType, hard: false },
  )

  // Reguły kolizji obowiązują OBA źródła rozkładu. Stały układ ich dziś nie
  // narusza, ale niezmiennik ma trzymać niezależnie od tego, skąd wziął się
  // rozkład — inaczej zmiana jednego dnia w układzie mogłaby go po cichu złamać.
  applyLegRunConflict(schedule)
  applyHardStreakLimit(schedule)
  return schedule
}

/**
 * Minimum, jakie trzeba wiedzieć o profilu, żeby rozstrzygnąć układ tygodnia.
 *
 * Wąski typ, bo pytają o to także ekrany trzymające PROJEKT profilu (kreator,
 * edycja, ekran startowy z presetem) — a te nie mają jeszcze pełnego rekordu
 * z bazy. Bez tego każdy z nich musiałby podrabiać `Profile`.
 */
export type WeekLayoutProbe = Pick<Profile, 'availableDays' | 'equipment'>

/** Czy stały układ tygodnia da się zrealizować przy tym profilu. */
export function fixedLayoutApplies(
  profile: WeekLayoutProbe,
  layout: WeekLayout | null = FIXED_WEEK_LAYOUT,
): boolean {
  if (!layout || layout.length === 0) return false

  const available = new Set(profile.availableDays)
  if (!layout.every((day) => available.has(day.dayOfWeek))) return false

  const canStrength = profile.equipment.some((e) => e === 'gym' || e === 'dumbbells' || e === 'home')
  return layout.every((day) => {
    if (day.type === 'strength') return canStrength
    if (day.type === 'run') return profile.equipment.includes('running')
    return profile.equipment.includes('pool')
  })
}

/**
 * Rozkład ze stałego układu.
 *
 * Z profilu bierzemy tylko to, co układu nie dotyczy: podział sesji siłowych
 * (ukierunkowanie i doświadczenie) oraz wariant biegu. Liczba sesji NIE wynika
 * już z `derivedWeeklySessions` — dni są podane wprost i to one wygrywają.
 */
function daysFromLayout(profile: Profile, layout: WeekLayout): Map<Weekday, ScheduledDay> {
  const ordered = [...layout].sort((a, b) => a.dayOfWeek - b.dayOfWeek)

  const days = new Map<Weekday, ScheduledDay>()
  let strengthCursor = 0
  let cardioCursor = 0

  for (const { dayOfWeek, type } of ordered) {
    if (type === 'strength') {
      // Dni siłowe biorą kolejno Trening A i Trening B z arkusza. FBW obejmuje
      // całe ciało, więc `focus` jest zawsze `full` — a to znaczy „dzień nóg",
      // czyli reguła „mocny bieg nie po dniu nóg" nadal obowiązuje.
      days.set(dayOfWeek, {
        dayOfWeek,
        type: 'strength',
        focus: 'full',
        workoutId: WORKOUT_ROTATION[strengthCursor % WORKOUT_ROTATION.length] as 'A' | 'B',
        hard: true,
      })
      strengthCursor++
      continue
    }

    cardioCursor++
    if (type === 'swim') {
      days.set(dayOfWeek, { dayOfWeek, type: 'swim', hard: false })
      continue
    }

    const variant = runVariantFor(profile, cardioCursor)
    days.set(dayOfWeek, { dayOfWeek, type: 'run', runVariant: variant, hard: variant === 'intervals' })
  }

  return days
}

/**
 * Ile dni tygodnia poświęcamy na trening, gdy dni NIE są podane wprost.
 *
 * Liczba wynika z poziomu aktywności i doświadczenia (patrz
 * `derivedWeeklySessions`), a nie z osobnego pola w profilu — trzy spójne ze sobą
 * wartości dawałyby trzy okazje do sprzeczności. Gdy wyliczona liczba przekracza
 * liczbę zaznaczonych dni, wygrywa kalendarz; R3 zostawia dzień wolny.
 */
function derivedDayCount(
  profile: WeekLayoutProbe & Pick<Profile, 'activityLevel' | 'experience'>,
): number {
  const available = new Set(profile.availableDays).size
  const target = derivedWeeklySessions(profile.activityLevel, profile.experience)
  return Math.min(available, Math.max(1, target), MAX_TRAINING_DAYS)
}

/**
 * Ile sesji ułoży plan — do pokazania w profilu i w kreatorze.
 *
 * Przy stałym układzie odpowiedź daje ON, nie wyliczenie z aktywności: dni są
 * podane wprost, więc „plan ułoży 5 sesji" byłoby nieprawdą o planie, który
 * ułoży cztery. Reguła kolizji może jeszcze odebrać sesję przy dniach pod rząd —
 * plan mówi o tym własnym ostrzeżeniem.
 */
export function plannedWeeklySessions(
  profile: WeekLayoutProbe & Pick<Profile, 'activityLevel' | 'experience'>,
  layout: WeekLayout | null = FIXED_WEEK_LAYOUT,
): number {
  if (layout && fixedLayoutApplies(profile, layout)) return layout.length
  return derivedDayCount(profile)
}

/** Rozkład wyliczony z dostępnych dni, aktywności i doświadczenia. */
function derivedDays(profile: Profile): Map<Weekday, ScheduledDay> {
  const available = [...new Set(profile.availableDays)].sort((a, b) => a - b)
  const canStrength = profile.equipment.some((e) => e === 'gym' || e === 'dumbbells' || e === 'home')
  const canRun = profile.equipment.includes('running')
  const canSwim = profile.equipment.includes('pool')
  const canCardio = canRun || canSwim

  const dayCount = derivedDayCount(profile)
  // Wybrane dni rozstawiamy równomiernie, a nie bierzemy pierwszych z rzędu.
  const trainingDays = spreadIndices(available.length, dayCount).map(
    (index) => available[index] as Weekday,
  )

  const strengthCount = plannedStrengthCount(
    trainingDays.length,
    profile,
    canStrength,
    canRun,
    canSwim,
  )
  const strengthPositions = new Set(spreadIndices(trainingDays.length, strengthCount))

  const days = new Map<Weekday, ScheduledDay>()
  let strengthCursor = 0
  let cardioCursor = 0

  for (const [index, dayOfWeek] of trainingDays.entries()) {
    if (strengthPositions.has(index)) {
      days.set(dayOfWeek, {
        dayOfWeek,
        type: 'strength',
        focus: 'full',
        workoutId: WORKOUT_ROTATION[strengthCursor % WORKOUT_ROTATION.length] as 'A' | 'B',
        hard: true,
      })
      strengthCursor++
      continue
    }

    if (!canCardio) {
      days.set(dayOfWeek, { dayOfWeek, type: 'rest', hard: false })
      continue
    }

    /**
     * Pierwszy dzień cardio idzie na BASEN, gdy jest dostępny.
     *
     * Wcześniej licznik startował od zera i warunek brzmiał `% 2 === 1`, więc
     * pierwszy dzień cardio zawsze był bieganiem. Przy jednym dniu cardio
     * w tygodniu — czyli w typowym planie sylwetkowym — pływanie nie wchodziło
     * do planu NIGDY, mimo zaznaczonego basenu.
     *
     * Basen wygrywa pierwszeństwo, bo jest zasobem trudniejszym: wymaga dojazdu
     * i godzin otwarcia. Bieganie da się dołożyć spontanicznie, pływania nie.
     */
    const useSwim = canSwim && (!canRun || cardioCursor % 2 === 0)
    cardioCursor++

    if (useSwim) {
      days.set(dayOfWeek, { dayOfWeek, type: 'swim', hard: false })
    } else {
      const variant = runVariantFor(profile, cardioCursor)
      days.set(dayOfWeek, {
        dayOfWeek,
        type: 'run',
        runVariant: variant,
        hard: variant === 'intervals',
      })
    }
  }

  return days
}

export function isLegHeavyFocus(focus: SessionFocus | undefined): boolean {
  return focus !== undefined && LEG_HEAVY.includes(focus)
}

// ─────────────────────────────────────────────────────── Wewnętrzne

function plannedStrengthCount(
  dayCount: number,
  profile: Profile,
  canStrength: boolean,
  canRun: boolean,
  canSwim: boolean,
): number {
  if (!canStrength) return 0

  // Bez sprzętu do cardio siła bierze wszystkie dni, ograniczona doświadczeniem.
  if (!canRun && !canSwim) {
    return Math.min(dayCount, MAX_STRENGTH_DAYS[profile.experience])
  }

  /**
   * Każda dostępna dyscyplina cardio dostaje własny dzień w KAŻDYM tygodniu.
   * To ma pierwszeństwo nad liczbą sesji siłowych — inaczej przy planie
   * sylwetkowym jedna z dyscyplin wypadała z tygodnia na stałe.
   */
  const cardioDays = (canRun ? 1 : 0) + (canSwim ? 1 : 0)

  const cap =
    profile.goal === 'conditioning' || profile.goal === 'event'
      ? // Przy celach wytrzymałościowych cardio dominuje jeszcze mocniej.
        Math.min(MAX_STRENGTH_DAYS_WITH_CARDIO - 1, MAX_STRENGTH_DAYS[profile.experience])
      : Math.min(MAX_STRENGTH_DAYS_WITH_CARDIO, MAX_STRENGTH_DAYS[profile.experience])

  return Math.max(0, Math.min(cap, dayCount - cardioDays))
}

function runVariantFor(profile: Profile, cardioCursor: number): RunVariant {
  // Interwały dla początkującego to droga do kontuzji — zawsze bieg spokojny.
  if (profile.experience === 'beginner') return 'easy'
  // Interwały to bieg o wysokim wpływie — przy ograniczeniu dna miednicy
  // odpada, tak samo jak ćwiczenia z mocnym parciem tłoczni brzusznej.
  if (profile.injuries.includes('pelvicFloor')) return 'easy'
  const wantsSpeed = profile.goal === 'conditioning' || profile.goal === 'event'
  if (wantsSpeed) return cardioCursor % 2 === 1 ? 'intervals' : 'easy'
  // Przy celach sylwetkowych interwały rzadziej — nie kanibalizują regeneracji.
  return cardioCursor % 4 === 1 ? 'intervals' : 'easy'
}

/**
 * Rozkłada `k` pozycji po `n` dniach tak, żeby odstępy były możliwie równe.
 * Bez tego trzy sesje siłowe wylądowałyby w poniedziałek, wtorek i środę.
 */
export function spreadIndices(n: number, k: number): number[] {
  if (k <= 0 || n <= 0) return []
  if (k >= n) return Array.from({ length: n }, (_, i) => i)
  if (k === 1) return [Math.floor((n - 1) / 2)]

  const out: number[] = []
  for (let i = 0; i < k; i++) {
    let index = Math.round((i * (n - 1)) / (k - 1))
    while (out.includes(index)) index = (index + 1) % n
    out.push(index)
  }
  return out.sort((a, b) => a - b)
}

/** R1: mocny bieg dzień po dniu nóg → degradacja do biegu spokojnego. */
function applyLegRunConflict(schedule: ScheduledDay[]): void {
  for (let i = 0; i < schedule.length; i++) {
    const day = schedule[i] as ScheduledDay
    if (day.type !== 'run' || day.runVariant !== 'intervals') continue

    const previous = schedule[(i - 1 + schedule.length) % schedule.length] as ScheduledDay
    if (previous.type === 'strength' && isLegHeavyFocus(previous.focus)) {
      day.runVariant = 'easy'
      day.hard = false
    }
  }
}

/**
 * R2: nie ma trzech wymagających dni z rzędu.
 *
 * Najpierw próbujemy degradacji (interwały → bieg spokojny), bo nie kosztuje
 * sesji. Gdy to nie wystarczy — środkowy dzień pasma zamieniamy na odpoczynek.
 * Trzy ciężkie dni pod rząd są gorsze niż jedna sesja mniej.
 */
function applyHardStreakLimit(schedule: ScheduledDay[]): void {
  const size = schedule.length

  for (let guard = 0; guard < size * 2; guard++) {
    const streakStart = findHardStreakStart(schedule)
    if (streakStart === null) return

    const middle = schedule[(streakStart + 1) % size] as ScheduledDay
    if (middle.type === 'run' && middle.runVariant === 'intervals') {
      middle.runVariant = 'easy'
      middle.hard = false
      continue
    }

    middle.type = 'rest'
    middle.hard = false
    delete middle.focus
    delete middle.runVariant
  }
}

/** Zwraca indeks początku pierwszego pasma trzech wymagających dni (cyklicznie). */
function findHardStreakStart(schedule: readonly ScheduledDay[]): number | null {
  const size = schedule.length
  for (let i = 0; i < size; i++) {
    const a = schedule[i] as ScheduledDay
    const b = schedule[(i + 1) % size] as ScheduledDay
    const c = schedule[(i + 2) % size] as ScheduledDay
    if (a.hard && b.hard && c.hard) return i
  }
  return null
}
