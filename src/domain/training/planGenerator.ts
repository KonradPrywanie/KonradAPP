import type {
  IsoDate,
  MesocyclePhase,
  Profile,
  SessionPayload,
  SessionType,
  Weekday,
  Workout,
} from '../types'
import { addDays, diffDays, isoWeekday, startOfWeek, weekOrderIndex } from '../dates'
import { weekLoad } from './mesocycle'
import { runSession, swimSession } from './cardio'
import { workoutSession } from './workout'
import { fixedLayoutApplies, MAX_TRAINING_DAYS, weeklySchedule } from './schedule'
import { derivedWeeklySessions } from './sessionTarget'

/**
 * Horyzont planu: DWA tygodnie.
 *
 * Wcześniej było dwanaście i to była fikcja. Obciążenia od tygodnia trzeciego
 * w górę i tak wynikały z tego, co zostanie zalogowane (`applyWeekProgression`),
 * więc dziesięć dalszych tygodni było wydrukiem założeń, nie planem: pokazywały
 * liczby, o których aplikacja wiedziała, że je zmieni.
 *
 * Dwa tygodnie to horyzont, na którym plan opiera się na FAKTACH — na sesjach
 * już odbytych. Rytm bloków 3 + 1 przeżywa krótszy plan dzięki
 * `blockOffsetWeeks`: kolejne odnowienie startuje tam, gdzie skończyło się
 * poprzednie, więc deload nadal wypada w co czwartym tygodniu treningu.
 */
export const DEFAULT_PLAN_WEEKS = 2
const MIN_PLAN_WEEKS = 2
const MAX_PLAN_WEEKS = 24
/** Poniżej tej liczby ćwiczeń sesja przestaje pokrywać wzorce ruchowe. */

export interface SessionDraft {
  weekIndex: number
  dayOfWeek: Weekday
  date: IsoDate
  type: SessionType
  phase: MesocyclePhase
  payload: SessionPayload
}

export interface PlanDraft {
  startDate: IsoDate
  weeks: number
  profileSnapshot: Profile
  sessions: SessionDraft[]
  /** Do pokazania użytkownikowi — np. że sprzęt nie pokrywa jakiegoś wzorca. */
  warnings: string[]
}

export interface GeneratePlanInput {
  profile: Profile
  startDate: IsoDate
  /** Treningi z arkusza — plan nie komponuje sesji, tylko wstawia gotowe. */
  workouts: readonly Workout[]
  weeks?: number
  seed?: string
  /**
   * Ciężary osiągnięte w poprzednich planach, per `exerciseId`.
   * Bez nich każda regeneracja cofa użytkownika do odgadywania obciążeń.
   */
  knownLoads?: ReadonlyMap<string, number>
  /**
   * Przesunięcie rytmu bloków — zachowuje pozycję w mezocyklu przy regeneracji
   * w środku cyklu. Patrz `weekLoad`.
   */
  blockOffsetWeeks?: number
}

/**
 * Generuje pełny plan treningowy.
 *
 * Dwie decyzje, które wyglądają jak uproszczenia, a są celowe:
 *
 *  1. **Rozkład tygodnia jest stały przez cały plan.** Progresję da się
 *     śledzić tylko wtedy, gdy te same ćwiczenia wracają w tym samym dniu.
 *     Zmienia się obciążenie, nie struktura.
 *  2. **Ćwiczeń nie dobieramy wcale.** Dni siłowe dostają gotowy Trening A albo
 *     B z arkusza trenera — z jego doborem, kolejnością, tempem i przerwami.
 *     Aplikacja odpowiada za kalendarz i za ciężary z logu, nie za komponowanie
 *     sesji; dwa źródła prawdy o „dzisiejszym treningu" to jedno za dużo.
 *
 * Tygodnie są wyrównane do tygodnia aplikacji, który zaczyna się w SOBOTĘ
 * (patrz `WEEK_START_DAY`) — ten sam podział mają jadłospis i lista zakupów,
 * więc „tydzień 2 planu" i „tydzień 2 zakupów" to ten sam odcinek kalendarza.
 * Sesje wypadające przed `startDate` są pomijane, więc pierwszy tydzień może
 * być częściowy — to lepsze niż plan zaczynający się „w połowie tygodnia"
 * i rozjeżdżający się z kalendarzem do końca.
 */
export function generatePlan(input: GeneratePlanInput): PlanDraft {
  const { profile, startDate } = input
  const warnings: string[] = []

  const weekStart = startOfWeek(startDate)
  const weeks = resolveWeeks(input, weekStart, warnings)

  const workoutsById = new Map(input.workouts.map((workout) => [workout.id, workout]))
  if (workoutsById.size === 0) {
    warnings.push('Brak treningów w katalogu — plan nie będzie zawierał sesji siłowych.')
  }

  /**
   * Rozkład tygodnia w kolejności KALENDARZOWEJ tygodnia aplikacji.
   *
   * `weeklySchedule` zwraca dni w numeracji ISO (poniedziałek pierwszy), bo
   * reguły kolizji traktują tydzień cyklicznie i ich to nie dotyczy. Ale sesje
   * planu muszą wychodzić w kolejności dat: bez tego sobota — pierwszy dzień
   * tygodnia — lądowała na końcu swojego tygodnia w `PlanDraft.sessions`.
   * Wyszło z podglądu planu, nie z testów: daty były poprawne, kolejność nie.
   */
  const schedule = [...weeklySchedule(profile)].sort(
    (a, b) => weekOrderIndex(a.dayOfWeek) - weekOrderIndex(b.dayOfWeek),
  )

  /**
   * Reguła „maksymalnie dwa wymagające dni z rzędu" może odebrać sesję, gdy
   * dostępne dni idą jeden po drugim (np. pon–pt przy pięciu treningach).
   * Ograniczenie jest słuszne, ale przemilczenie go nie: użytkownik prosi
   * o pięć sesji i musi wiedzieć, że dostała mniej — i dlaczego.
   */
  const usesFixedLayout = fixedLayoutApplies(profile)
  const plannedSessions = schedule.filter((day) => day.type !== 'rest').length
  const availableCount = new Set(profile.availableDays).size
  const derived = derivedWeeklySessions(profile.activityLevel, profile.experience)
  const requested = Math.min(derived, availableCount, MAX_TRAINING_DAYS)

  /**
   * Obie dyscypliny cardio zgłoszone, ale w tygodniu zmieściła się jedna.
   * Milczenie wyglądałoby jak zignorowanie zaznaczonego sprzętu.
   */
  const hasRun = schedule.some((day) => day.type === 'run')
  const hasSwim = schedule.some((day) => day.type === 'swim')
  const wantsBoth = profile.equipment.includes('running') && profile.equipment.includes('pool')
  if (wantsBoth && hasRun !== hasSwim) {
    const missing = hasSwim ? 'bieganie' : 'pływanie'
    warnings.push(
      usesFixedLayout
        ? `Stały rozkład tygodnia nie ma dnia na ${missing} — dyscyplina jest w sprzęcie, ` +
            'ale nie w planie.'
        : `W tygodniu zmieścił się jeden dzień cardio, więc ${missing} nie weszło do planu. ` +
            'Zaznacz więcej dni, w które możesz trenować.',
    )
  }

  /**
   * Ostrzeżenia o LICZBIE sesji dotyczą tylko rozkładu wyliczanego z profilu.
   * Przy stałym układzie dni są podane wprost i to one wygrywają — „zaplanowano
   * 4 z 5" brzmiałoby jak awaria, a jest realizacją wskazanych dni.
   */
  if (!usesFixedLayout) {
    if (plannedSessions < requested) {
      warnings.push(
        `Zaplanowano ${plannedSessions} z ${requested} sesji w tygodniu. Wybrane dni ` +
          'następują po sobie, a plan nie stawia trzech wymagających treningów z rzędu — ' +
          'zaznacz dni rozłożone bardziej równomiernie.',
      )
    }

    if (availableCount < derived) {
      warnings.push(
        `Twój poziom aktywności i doświadczenia daje ${derived} sesji w tygodniu, ale ` +
          `w profilu masz zaznaczone ${availableCount} dni. Plan wykorzysta tyle, ile jest.`,
      )
    }
  }

  /**
   * Sesja dłuższa niż budżet czasowy z profilu to informacja, nie błąd.
   *
   * Poprzednia wersja docinała sesję do budżetu (najpierw ćwiczenia, potem
   * serie). Przy planie z arkusza to byłoby wycinanie ćwiczeń, które trener
   * wpisał świadomie — więc mówimy o rozbieżności i zostawiamy decyzję
   * użytkownikowi.
   */
  for (const workout of input.workouts) {
    const minutes = workoutSession({ workout, load: weekLoad(0, 1, profile.goal) }).estimatedMinutes
    if (minutes > profile.sessionMinutes) {
      warnings.push(
        `${workout.name} to około ${minutes} minut, a w profilu masz ` +
          `${profile.sessionMinutes} min na sesję. Nic nie skracamy — plan jest z arkusza — ` +
          'ale warto o tym wiedzieć przy planowaniu dnia.',
      )
    }
  }

  const sessions: SessionDraft[] = []

  for (let weekIndex = 0; weekIndex < weeks; weekIndex++) {
    const load = weekLoad(weekIndex, weeks, profile.goal, input.blockOffsetWeeks ?? 0)

    for (const day of schedule) {
      // Przesunięcie liczymy od POCZĄTKU TYGODNIA APLIKACJI, nie od
      // poniedziałku: `dayOfWeek - 1` wyrzuciłoby sobotę i niedzielę na koniec
      // tygodnia sobotniego, czyli o sześć dni za daleko.
      const date = addDays(weekStart, weekIndex * 7 + weekOrderIndex(day.dayOfWeek))
      // Pierwszy tydzień planu może być częściowy.
      if (diffDays(startDate, date) < 0) continue

      let payload: SessionPayload
      let type: SessionType = day.type

      if (day.type === 'strength') {
        const workout = workoutsById.get(day.workoutId ?? 'A') ?? input.workouts[0]
        if (!workout) {
          type = 'rest'
          payload = { kind: 'rest', note: 'Brak treningu w katalogu' }
        } else {
          payload = workoutSession({
            workout,
            load,
            ...(input.knownLoads === undefined ? {} : { knownLoads: input.knownLoads }),
          })
        }
      } else if (day.type === 'run') {
        payload = runSession(
          profile.experience,
          load,
          day.runVariant ?? 'easy',
          profile.runBaseline,
        )
      } else if (day.type === 'swim') {
        payload = swimSession(profile.experience, load, profile.swimBaseline)
      } else {
        payload = { kind: 'rest', note: restNoteFor(load.phase) }
      }

      sessions.push({
        weekIndex,
        dayOfWeek: day.dayOfWeek,
        date,
        type,
        phase: load.phase,
        payload,
      })
    }
  }

  return { startDate, weeks, profileSnapshot: profile, sessions, warnings }
}

/**
 * Długość planu.
 *
 * Dla celu „przygotowanie do zawodów" liczymy WSTECZ od daty startu, żeby
 * tapering wypadł dokładnie przed zawodami — tylko ten cel wymaga horyzontu
 * dłuższego niż dwa tygodnie, bo tapering trzeba umieć zaplanować z wyprzedzeniem.
 * Pozostałe cele dostają `DEFAULT_PLAN_WEEKS`.
 */
function resolveWeeks(input: GeneratePlanInput, weekStart: IsoDate, warnings: string[]): number {
  const { profile } = input

  if (profile.goal === 'event' && profile.eventDate) {
    const days = diffDays(weekStart, profile.eventDate)
    if (days <= 0) {
      warnings.push(
        `Data zawodów jest w przeszłości — plan wygenerowano na ${DEFAULT_PLAN_WEEKS} tygodnie.`,
      )
      return DEFAULT_PLAN_WEEKS
    }
    const raw = Math.ceil(days / 7)
    const clamped = Math.min(MAX_PLAN_WEEKS, Math.max(MIN_PLAN_WEEKS, raw))
    if (clamped !== raw) {
      warnings.push(
        `Do zawodów jest ${raw} tygodni — plan ograniczono do ${clamped} ` +
          `(zakres ${MIN_PLAN_WEEKS}–${MAX_PLAN_WEEKS}).`,
      )
    }
    return clamped
  }

  return input.weeks ?? DEFAULT_PLAN_WEEKS
}

function restNoteFor(phase: MesocyclePhase): string {
  if (phase === 'deload') return 'Tydzień deloadu — odpoczynek jest częścią planu.'
  if (phase === 'taper') return 'Tapering przed zawodami — priorytetem jest regeneracja.'
  return 'Dzień wolny.'
}

/** Sesje z konkretnego dnia — do dashboardu. */
export function sessionsOnDate(plan: PlanDraft, date: IsoDate): SessionDraft[] {
  return plan.sessions.filter((s) => s.date === date)
}

/** Najbliższa sesja treningowa od podanej daty (bez dni odpoczynku). */
export function nextTrainingSession(plan: PlanDraft, fromDate: IsoDate): SessionDraft | null {
  const upcoming = plan.sessions
    .filter((s) => s.type !== 'rest' && diffDays(fromDate, s.date) >= 0)
    .sort((a, b) => a.date.localeCompare(b.date))
  return upcoming[0] ?? null
}

/** Dzień tygodnia sesji zgadza się z jej datą — niezmiennik planu. */
export function verifyWeekdayAlignment(plan: PlanDraft): boolean {
  return plan.sessions.every((s) => isoWeekday(s.date) === s.dayOfWeek)
}

export interface PlanWeekRange {
  weekIndex: number
  /** Sobota — pierwszy dzień tygodnia planu. */
  start: IsoDate
  /** Piątek — ostatni dzień tygodnia planu. */
  end: IsoDate
}

/**
 * Od kiedy do kiedy trwa dany tydzień planu.
 *
 * Numer tygodnia bez daty nic nie mówi: „tydzień 2" to informacja o pozycji
 * w cyklu, a nie o tym, czy chodzi o ten tydzień, czy o następny. Licząc
 * z `startOfWeek(plan.startDate)`, a nie z pierwszej sesji, dostajemy ten sam
 * podział co jadłospis i lista zakupów — także wtedy, gdy pierwszy tydzień
 * planu jest częściowy i nie ma sesji w sobotę.
 */
export function planWeekRange(
  planStartDate: IsoDate,
  weekIndex: number,
  weeks?: number,
): PlanWeekRange {
  if (weekIndex < 0 || (weeks !== undefined && weekIndex >= weeks)) {
    throw new RangeError(`Tydzień ${weekIndex} poza planem`)
  }
  const start = addDays(startOfWeek(planStartDate), weekIndex * 7)
  return { weekIndex, start, end: addDays(start, 6) }
}

/** Zakresy wszystkich tygodni planu — do przełącznika tygodni. */
export function planWeekRanges(planStartDate: IsoDate, weeks: number): PlanWeekRange[] {
  return Array.from({ length: weeks }, (_, i) => planWeekRange(planStartDate, i, weeks))
}

export interface PlanTimeline {
  /** Sobota tygodnia, w którym plan się zaczyna. */
  weekStart: IsoDate
  lastDate: IsoDate
  /** Numer tygodnia planu dla podanej daty. Null poza zakresem planu. */
  currentWeekIndex: number | null
  /** Data jest za ostatnim dniem planu. */
  isFinished: boolean
  /** Data jest przed początkiem planu. */
  notStarted: boolean
  /** Dni do końca planu; ujemne, gdy plan już się skończył. */
  daysRemaining: number
  /** Trwa ostatni tydzień planu. */
  isFinalWeek: boolean
}

/**
 * Kalendarz planu.
 *
 * Bez tego plan po ostatnim tygodniu kończył się w ciszy: zapytania o sesje
 * zwracały pustą listę, a ekran „Dziś" pokazywał puste miejsce zamiast
 * propozycji odnowienia. Czysta funkcja, żeby dała się przetestować bez bazy.
 */
export function planTimeline(startDate: IsoDate, weeks: number, today: IsoDate): PlanTimeline {
  const weekStart = startOfWeek(startDate)
  const lastDate = addDays(weekStart, weeks * 7 - 1)
  const daysFromStart = diffDays(weekStart, today)
  const daysRemaining = diffDays(today, lastDate)

  const notStarted = diffDays(today, startDate) > 0
  const isFinished = daysRemaining < 0
  const inRange = !notStarted && !isFinished

  return {
    weekStart,
    lastDate,
    currentWeekIndex: inRange ? Math.floor(daysFromStart / 7) : null,
    isFinished,
    notStarted,
    daysRemaining,
    isFinalWeek: inRange && Math.floor(daysFromStart / 7) === weeks - 1,
  }
}
