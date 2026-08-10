import type {
  IsoDate,
  MovementPattern,
  PlannedSession,
  Profile,
  StrengthPayload,
  TrainingPlan,
  Uuid,
} from '@/domain/types'
import {
  DEFAULT_PLAN_WEEKS,
  generatePlan,
  planTimeline,
  type PlanTimeline,
} from '@/domain/training/planGenerator'
import {
  achievedCardio,
  latestWorkingLoads,
  toWeightMap,
  type AchievedCardio,
} from '@/domain/training/history'
import { MissingPlanInputsError, missingPlanInputs } from '@/domain/training/planInputs'
import {
  applyProgression,
  deloadWeight,
  evaluateProgression,
} from '@/domain/training/progression'
import { BLOCK_LENGTH_WEEKS, weekLoad } from '@/domain/training/mesocycle'
import { runSession, swimSession } from '@/domain/training/cardio'
import { estimateMinutes, plannedWorkoutExercise } from '@/domain/training/workout'
import { addDays, diffDays, startOfWeek, weekOrderIndex } from '@/domain/dates'
import { exercisePlacement, WORKOUTS, WORKOUT_EXERCISES_BY_ID } from '@/lib/catalog'
import { alive, db, newId, stamp } from './db'

/**
 * Repozytorium planu treningowego.
 *
 * Trzyma się zasady rozdzielenia planu od logu: regeneracja archiwizuje
 * poprzedni plan (soft), nigdy nie dotyka `sessionLogs` ani `setLogs`.
 * Dzięki temu historia przeżywa każdą zmianę profilu.
 */

export interface GeneratedPlanResult {
  plan: TrainingPlan
  sessionCount: number
  warnings: string[]
  /** Ile ćwiczeń dostało ciężar przeniesiony z historii. */
  carriedLoadCount: number
  /** Przesunięcie rytmu bloków, żeby nie cofać użytkownika do akumulacji. */
  blockOffsetWeeks: number
  /**
   * Punkt wyjścia w cardio podniesiony przez odbyte sesje — puste pola znaczą
   * „log nie pobił deklaracji z profilu", nie „brak danych".
   */
  cardioFromLogs: AchievedCardio
}

export interface GeneratePlanOptions {
  weeks?: number
  seed?: string
  /** Wyłącza przenoszenie ciężarów — do testów i świadomego startu od zera. */
  carryLoads?: boolean
  /** Wyłącza zachowanie pozycji w mezocyklu. */
  preserveBlockPosition?: boolean
}

export interface ExtendedPlanResult extends GeneratedPlanResult {
  /**
   * `extended` — tygodnie dopisane do istniejącego planu (ten sam `planId`,
   * ta sama wersja, dotychczasowe tygodnie nietknięte).
   * `created` — powstał nowy plan, bo nie było do czego dopisywać.
   */
  mode: 'extended' | 'created'
  /** Ile tygodni doszło. */
  addedWeeks: number
  /** Numer pierwszego dopisanego tygodnia (liczony od zera). */
  firstWeekIndex: number
  /** Sobota, od której zaczyna się pierwszy dopisany tydzień. */
  firstWeekStart: IsoDate
}

export const planRepo = {
  async active(): Promise<TrainingPlan | undefined> {
    const rows = alive(await db.trainingPlans.toArray())
    return rows
      .filter((p) => p.status === 'active')
      .sort((a, b) => b.version - a.version)[0]
  },

  /**
   * Generuje plan i zapisuje go w jednej transakcji.
   *
   * Poprzedni plan jest archiwizowany, nie usuwany — jego sesje pozostają
   * powiązane z zalogowanymi treningami przez `plannedSessionId`.
   *
   * Trzy rzeczy dzieją się tu automatycznie, żeby żaden wywołujący nie mógł
   * ich pominąć: przeniesienie osiągniętych ciężarów z logu, podniesienie
   * punktu wyjścia w cardio z odbytych sesji i zachowanie pozycji w mezocyklu.
   * Bez pierwszych dwóch odnowienie planu cofa dorobek treningowy, bez
   * trzeciego kolejny dwutygodniowy plan zawsze startowałby od pierwszego
   * tygodnia akumulacji, a deload nie wypadłby nigdy.
   *
   * Odmawia, gdy w profilu brakuje punktu wyjścia dla zgłoszonego cardio —
   * plan zbudowany na presecie wygląda wiarygodnie i dotyczy kogoś innego.
   */
  async generateAndSave(
    profile: Profile,
    startDate: IsoDate,
    options: GeneratePlanOptions = {},
  ): Promise<GeneratedPlanResult> {
    const gaps = missingPlanInputs(profile)
    if (gaps.length > 0) throw new MissingPlanInputsError(gaps)

    const previous = await planRepo.active()

    const knownLoads =
      options.carryLoads === false ? new Map<string, number>() : await planRepo.achievedLoads()

    const cardioFromLogs =
      options.carryLoads === false ? {} : await planRepo.achievedCardio(profile, startDate)

    const blockOffsetWeeks =
      options.preserveBlockPosition === false || !previous
        ? 0
        : blockOffsetFor(previous, startDate)

    const draft = generatePlan({
      // Plan liczy dystanse i tempo z formy AKTUALNEJ, czyli z logu, gdy ten
      // pobił deklarację z profilu. Snapshot planu zapisze te same wartości,
      // więc plan pozostaje odtwarzalny.
      profile: withCardioBaselines(profile, cardioFromLogs),
      startDate,
      workouts: WORKOUTS,
      knownLoads,
      blockOffsetWeeks,
      ...(options.weeks === undefined ? {} : { weeks: options.weeks }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    })

    const now = stamp()
    const planId = newId()

    const plan: TrainingPlan = {
      id: planId,
      startDate: draft.startDate,
      weeks: draft.weeks,
      profileSnapshot: draft.profileSnapshot,
      version: (previous?.version ?? 0) + 1,
      status: 'active',
      blockOffsetWeeks,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }

    const sessions: PlannedSession[] = draft.sessions.map((s) => ({
      id: newId(),
      planId,
      weekIndex: s.weekIndex,
      dayOfWeek: s.dayOfWeek,
      date: s.date,
      type: s.type,
      phase: s.phase,
      payload: s.payload,
      updatedAt: now,
      deletedAt: null,
    }))

    await db.transaction('rw', db.trainingPlans, db.plannedSessions, async () => {
      if (previous) {
        await db.trainingPlans.put({ ...previous, status: 'archived', updatedAt: now })
      }
      await db.trainingPlans.add(plan)
      await db.plannedSessions.bulkAdd(sessions)
    })

    return {
      plan,
      sessionCount: sessions.length,
      warnings: draft.warnings,
      carriedLoadCount: knownLoads.size,
      blockOffsetWeeks,
      cardioFromLogs,
    }
  },

  /**
   * DOPISUJE kolejne tygodnie do istniejącego planu.
   *
   * Tak działa przycisk „wygeneruj plan na kolejne dwa tygodnie": każde
   * kliknięcie dokłada dwa tygodnie, których jeszcze nie ma — pierwszy raz
   * tygodnie 3–4, drugi raz 5–6, i tak dalej. Dotychczasowe tygodnie zostają
   * w planie razem z logami; nie ma archiwizacji ani nowej wersji, bo nie
   * powstaje nowy plan, tylko dłuższy ten sam.
   *
   * Dlaczego to nie jest to samo, co `generateAndSave`: tamta funkcja zaczyna
   * plan od dziś i archiwizuje poprzedni, więc drugie kliknięcie nadpisywało
   * te same dwa tygodnie zamiast dodać następne. Przy dopisywaniu numeracja
   * tygodni jest ciągła, więc `applyWeekProgression` i przełącznik tygodni
   * w zakładce Plan widzą cały ciąg — a nie dwa rozdzielne plany.
   *
   * Nowy plan powstaje tylko w dwóch sytuacjach:
   *  - nie ma aktywnego planu,
   *  - plan skończył się PRZED bieżącym tygodniem. Dopisanie tygodni
   *    w przeszłości dałoby sesje, których nikt nie zrobi, a przerwa
   *    w kalendarzu rozjechałaby numerację tygodni z datami.
   *
   * Rytm bloków 3 + 1 biegnie dalej: dopisany blok startuje z przesunięciem
   * poprzedniego plus jego długość, więc deload wypada w swoim terminie.
   */
  async extendOrGenerate(
    profile: Profile,
    today: IsoDate,
    options: GeneratePlanOptions = {},
  ): Promise<ExtendedPlanResult> {
    const gaps = missingPlanInputs(profile)
    if (gaps.length > 0) throw new MissingPlanInputsError(gaps)

    const previous = await planRepo.active()
    const nextWeekStart = previous
      ? addDays(startOfWeek(previous.startDate), previous.weeks * 7)
      : null

    // Brak planu albo dziura w kalendarzu → zwykłe generowanie od dziś.
    if (!previous || !nextWeekStart || diffDays(nextWeekStart, startOfWeek(today)) > 0) {
      const created = await planRepo.generateAndSave(profile, today, options)
      return {
        ...created,
        mode: 'created',
        addedWeeks: created.plan.weeks,
        firstWeekIndex: 0,
        firstWeekStart: startOfWeek(created.plan.startDate),
      }
    }

    const knownLoads =
      options.carryLoads === false ? new Map<string, number>() : await planRepo.achievedLoads()
    const cardioFromLogs =
      options.carryLoads === false ? {} : await planRepo.achievedCardio(profile, today)

    const blockOffsetWeeks =
      options.preserveBlockPosition === false
        ? 0
        : ((previous.blockOffsetWeeks ?? 0) + previous.weeks) % BLOCK_LENGTH_WEEKS

    const draft = generatePlan({
      profile: withCardioBaselines(profile, cardioFromLogs),
      startDate: nextWeekStart,
      workouts: WORKOUTS,
      knownLoads,
      blockOffsetWeeks,
      weeks: options.weeks ?? DEFAULT_PLAN_WEEKS,
      // To samo ziarno, co przy pierwszym generowaniu — dopisane tygodnie mają
      // te same ćwiczenia, inaczej progresji nie da się śledzić przez granicę.
      seed: options.seed ?? profile.id,
    })

    const now = stamp()
    const sessions: PlannedSession[] = draft.sessions.map((s) => ({
      id: newId(),
      planId: previous.id,
      weekIndex: previous.weeks + s.weekIndex,
      dayOfWeek: s.dayOfWeek,
      date: s.date,
      type: s.type,
      phase: s.phase,
      payload: s.payload,
      updatedAt: now,
      deletedAt: null,
    }))

    const plan: TrainingPlan = {
      ...previous,
      weeks: previous.weeks + draft.weeks,
      profileSnapshot: profile,
      updatedAt: now,
    }

    await db.transaction('rw', db.trainingPlans, db.plannedSessions, async () => {
      await db.trainingPlans.put(plan)
      await db.plannedSessions.bulkAdd(sessions)
    })

    return {
      plan,
      sessionCount: sessions.length,
      warnings: draft.warnings,
      carriedLoadCount: knownLoads.size,
      blockOffsetWeeks,
      cardioFromLogs,
      mode: 'extended',
      addedWeeks: draft.weeks,
      firstWeekIndex: previous.weeks,
      firstWeekStart: nextWeekStart,
    }
  },

  /**
   * Podmienia ćwiczenie w zaplanowanej sesji na jego alternatywę z arkusza.
   *
   * Po co: arkusz podaje dwie alternatywy dla każdego ćwiczenia i pisze wprost,
   * kiedy ich użyć — „gdy ławka i sztanga są zajęte". Bez podmiany w planie
   * trening zrobiony na wariancie nie miałby gdzie się zapisać: log wskazuje na
   * `exerciseId`, więc progresja liczyłaby się dla ćwiczenia, którego nie było.
   *
   * Wariant wchodzi z WŁASNYMI parametrami — swoje serie, powtórzenia, przerwa
   * i ciężar startowy. Odziedziczenie parametrów ćwiczenia zastępowanego byłoby
   * cichą zmianą planu trenera (Glute Bridge nie robi się na 30 kg, bo tyle
   * wychodziło na Hip Thruście).
   *
   * Ciężar bierzemy z logu, gdy ten wariant był już kiedyś robiony — tak samo
   * jak przy generowaniu planu.
   */
  async swapExercise(
    sessionId: Uuid,
    nextExerciseId: string,
  ): Promise<PlannedSession | undefined> {
    const session = await planRepo.byId(sessionId)
    if (!session || session.payload.kind !== 'strength') return undefined

    const placement = exercisePlacement(nextExerciseId)
    if (!placement) return undefined

    // Który wpis w sesji należy do tego samego miejsca w treningu.
    const slotExerciseIds = new Set(
      [placement.slot.main, ...placement.slot.alternatives].map((e) => e.id),
    )
    const payload = session.payload
    const index = payload.exercises.findIndex((e) => slotExerciseIds.has(e.exerciseId))
    if (index === -1) return undefined
    if (payload.exercises[index]?.exerciseId === nextExerciseId) return session

    const knownLoads = await planRepo.achievedLoads()
    const replacement = plannedWorkoutExercise(placement.exercise, {
      deload: session.phase === 'deload',
      knownWeightKg: knownLoads.get(nextExerciseId),
    })

    const exercises = payload.exercises.map((e, i) => (i === index ? replacement : e))
    const updated: PlannedSession = {
      ...session,
      payload: {
        ...payload,
        exercises,
        estimatedMinutes: Math.round(estimateMinutes(exercises)),
      },
      updatedAt: stamp(),
    }

    await db.plannedSessions.put(updated)
    return updated
  },

  /** Aktualne ciężary robocze z logu treningowego, per `exerciseId`. */
  async achievedLoads(): Promise<Map<string, number>> {
    const logs = alive(await db.sessionLogs.toArray())
    const sets = alive(await db.setLogs.toArray())
    return toWeightMap(latestWorkingLoads(logs, sets))
  },

  /** Punkt wyjścia w cardio podniesiony przez odbyte sesje. */
  async achievedCardio(profile: Profile, today: IsoDate): Promise<AchievedCardio> {
    const logs = alive(await db.sessionLogs.toArray())
    const cardio = alive(await db.cardioLogs.toArray())
    return achievedCardio(logs, cardio, today, {
      run: profile.runBaseline,
      swim: profile.swimBaseline,
    })
  },

  /** Kalendarz aktywnego planu na podaną datę. Null, gdy planu nie ma. */
  async timeline(today: IsoDate): Promise<PlanTimeline | null> {
    const plan = await planRepo.active()
    if (!plan) return null
    return planTimeline(plan.startDate, plan.weeks, today)
  },

  async sessionsOnDate(date: IsoDate): Promise<PlannedSession[]> {
    const rows = alive(await db.plannedSessions.where('date').equals(date).toArray())
    const active = await planRepo.active()
    return active ? rows.filter((s) => s.planId === active.id) : rows
  },

  async sessionsForWeek(planId: Uuid, weekIndex: number): Promise<PlannedSession[]> {
    const rows = alive(
      await db.plannedSessions.where('[planId+weekIndex]').equals([planId, weekIndex]).toArray(),
    )
    // Sortowanie po `dayOfWeek` postawiłoby poniedziałek przed sobotą, czyli
    // w kolejności innego tygodnia. Liczy się pozycja w tygodniu aplikacji.
    return rows.sort((a, b) => weekOrderIndex(a.dayOfWeek) - weekOrderIndex(b.dayOfWeek))
  },

  async byId(id: Uuid): Promise<PlannedSession | undefined> {
    const row = await db.plannedSessions.get(id)
    return row && !row.deletedAt ? row : undefined
  },

  /** Najbliższa sesja treningowa (bez dni odpoczynku) od podanej daty. */
  async nextSession(fromDate: IsoDate): Promise<PlannedSession | undefined> {
    const active = await planRepo.active()
    if (!active) return undefined
    const rows = alive(await db.plannedSessions.where('planId').equals(active.id).toArray())
    return rows
      .filter((s) => s.type !== 'rest' && diffDays(fromDate, s.date) >= 0)
      .sort((a, b) => a.date.localeCompare(b.date))[0]
  },

  /** Który tydzień planu przypada na daną datę. Null, gdy data jest poza planem. */
  async weekIndexOf(date: IsoDate): Promise<number | null> {
    const rows = await planRepo.sessionsOnDate(date)
    return rows[0]?.weekIndex ?? null
  },

  /**
   * Usuwa zaplanowane sesje jednego tygodnia.
   *
   * Po co: tydzień wyjazdu, choroby albo remontu nie jest tygodniem treningu,
   * a plan pokazujący sesje, których nikt nie zrobi, psuje statystykę
   * realizacji — sesje wyglądałyby na pominięte, choć nigdy nie miały się odbyć.
   *
   * Usuwamy MIĘKKO, jak wszystkie dane użytkownika. To istotne właśnie tutaj:
   * log treningowy wskazuje na `plannedSessionId`, więc twarde usunięcie
   * zerwałoby powiązanie z historią. Zalogowane sesje zostają w liczniku
   * `keptLogged` i NIE są usuwane — trening, który się odbył, nie przestaje
   * być faktem tylko dlatego, że reszta tygodnia wypada.
   *
   * **Nie ma dziś przycisku w interfejsie** — jego miejsce zajęła aktualizacja
   * tygodnia z historii (`refreshWeekFromHistory`), o którą poprosiła
   * użytkownik. Funkcja zostaje wraz z testami: kasowanie tygodnia wyjazdu
   * jest realną potrzebą, a przywrócenie go to dodanie karty, nie odtwarzanie
   * logiki miękkiego usuwania z zachowaniem logów.
   */
  async deleteWeek(planId: Uuid, weekIndex: number): Promise<DeleteWeekSummary> {
    const sessions = await planRepo.sessionsForWeek(planId, weekIndex)
    if (sessions.length === 0) return { removed: 0, keptLogged: 0 }

    const loggedSessionIds = await loggedPlannedSessionIds()
    const now = stamp()
    const toRemove = sessions.filter((session) => !loggedSessionIds.has(session.id))

    if (toRemove.length > 0) {
      await db.plannedSessions.bulkPut(
        toRemove.map((session) => ({ ...session, deletedAt: now, updatedAt: now })),
      )
    }

    return { removed: toRemove.length, keptLogged: sessions.length - toRemove.length }
  },
}

export interface DeleteWeekSummary {
  /** Sesje usunięte miękko. */
  removed: number
  /** Sesje zachowane, bo są już zalogowane. */
  keptLogged: number
}

export interface ResyncSummary {
  /** Sesje przepisane pod nowe ustawienia. */
  updatedSessions: number
  /** Sesje pominięte, bo już je zalogowano. */
  keptLogged: number
  /** Sesje pominięte, bo są w przeszłości. */
  keptPast: number
  warnings: string[]
}

/**
 * Dopasowuje zaplanowane sesje do zmienionego profilu.
 *
 * Nie tworzy nowej wersji planu — przepisuje zawartość sesji NIEWYKONANYCH
 * od podanej daty w przód, zachowując ich identyfikatory. To istotne: log
 * treningowy wskazuje na `plannedSessionId`, więc podmiana rekordów zerwałaby
 * powiązanie z historią.
 *
 * Nietknięte zostają:
 *  - sesje z datą przed `fromDate` (przeszłość jest przeszłością),
 *  - sesje, do których istnieje wpis w logu — nawet jeśli są w przyszłości.
 *
 * Rytm bloków odtwarzamy z zapisanego `blockOffsetWeeks`, żeby korekta
 * ustawień nie przestawiła deloadu na inny tydzień.
 */
export async function resyncPlan(
  profile: Profile,
  fromDate: IsoDate,
): Promise<ResyncSummary | null> {
  const plan = await planRepo.active()
  if (!plan) return null
  /**
   * Brak punktu wyjścia w cardio zatrzymuje korektę tak samo, jak zatrzymuje
   * generowanie: lepiej zostawić plan sprzed zmiany niż przepisać go na
   * dystansach z presetu. Formularz profilu nie pozwala zapisać takiego stanu,
   * więc to zabezpieczenie na wypadek innej drogi zapisu.
   */
  if (missingPlanInputs(profile).length > 0) return null

  const draft = generatePlan({
    profile: withCardioBaselines(profile, await planRepo.achievedCardio(profile, fromDate)),
    startDate: plan.startDate,
    workouts: WORKOUTS,
    weeks: plan.weeks,
    knownLoads: await planRepo.achievedLoads(),
    blockOffsetWeeks: plan.blockOffsetWeeks ?? 0,
    // To samo ziarno, co przy generowaniu — korekta profilu nie ma tasować
    // ćwiczeń, tylko dopasować parametry sesji.
    seed: profile.id,
  })

  const stored = alive(await db.plannedSessions.where('planId').equals(plan.id).toArray())
  const byDate = new Map(stored.map((session) => [session.date, session]))

  const loggedSessionIds = new Set(
    alive(await db.sessionLogs.toArray())
      .map((log) => log.plannedSessionId)
      .filter((id): id is Uuid => id !== null),
  )

  const now = stamp()
  const updates: PlannedSession[] = []
  let keptLogged = 0
  let keptPast = 0

  for (const fresh of draft.sessions) {
    const current = byDate.get(fresh.date)
    if (!current) continue

    if (diffDays(fromDate, fresh.date) < 0) {
      keptPast++
      continue
    }
    if (loggedSessionIds.has(current.id)) {
      keptLogged++
      continue
    }

    updates.push({
      ...current,
      type: fresh.type,
      phase: fresh.phase,
      payload: fresh.payload,
      updatedAt: now,
    })
  }

  if (updates.length > 0) {
    await db.plannedSessions.bulkPut(updates)
  }
  await db.trainingPlans.put({ ...plan, profileSnapshot: profile, updatedAt: now })

  return {
    updatedSessions: updates.length,
    keptLogged,
    keptPast,
    warnings: draft.warnings,
  }
}

/**
 * Profil z punktem wyjścia podniesionym o to, co zostało odbyte.
 *
 * Nadpisujemy tylko te dyscypliny, w których log pobił deklarację — reszta
 * zostaje z profilu. Kopia jest lokalna: w bazie profil pozostaje tym, co
 * podał użytkownik, a osiągnięcia mieszkają w logu.
 */
function withCardioBaselines(profile: Profile, achieved: AchievedCardio): Profile {
  if (!achieved.run && !achieved.swim) return profile
  return {
    ...profile,
    ...(achieved.run ? { runBaseline: achieved.run } : {}),
    ...(achieved.swim ? { swimBaseline: achieved.swim } : {}),
  }
}

/**
 * Gdzie w rytmie bloków wypada nowy plan.
 *
 * Rytm liczymy z KALENDARZA, a nie z pozycji w poprzednim planie: ile tygodni
 * minęło od jego początku, plus przesunięcie, z jakim tamten plan startował.
 * Dzięki temu rytm 3 + 1 jest ciągły niezależnie od tego, jak krótkie są
 * kolejne plany i czy odnowienie nastąpiło w trakcie, czy po zakończeniu.
 *
 * Poprzednia wersja czytała `currentWeekIndex` i zwracała zero, gdy plan już
 * się skończył — przy dwutygodniowych planach oznaczało to start od tygodnia
 * akumulacji za każdym razem, czyli deload NIGDY. Pomijała też przesunięcie
 * poprzedniego planu, więc rytm gubił się po drugim odnowieniu w trakcie.
 */
function blockOffsetFor(previous: TrainingPlan, startDate: IsoDate): number {
  const weeksElapsed = Math.floor(
    diffDays(startOfWeek(previous.startDate), startOfWeek(startDate)) / 7,
  )
  if (weeksElapsed < 0) return 0
  return (weeksElapsed + (previous.blockOffsetWeeks ?? 0)) % BLOCK_LENGTH_WEEKS
}

// ────────────────────────────────────── Pętla progresji

export interface ExerciseProgression {
  exerciseId: string
  exerciseName: string
  verdict: 'advance' | 'hold' | 'regress'
  suggestedWeightKg: number | null
  reason: string
}

export interface ProgressionSummary {
  targetWeekIndex: number
  sourceWeekIndex: number
  updatedSessions: number
  entries: ExerciseProgression[]
}

/**
 * Przenosi wnioski z zalogowanego tygodnia na obciążenia tygodnia następnego.
 *
 * To domknięcie pętli, bez którego plan jest tylko wydrukiem: obciążenia
 * na kolejny tydzień wynikają z tego, co faktycznie zostało zrobione,
 * a nie z mnożnika w kalendarzu.
 *
 * Sesje kojarzymy po dniu tygodnia — rozkład jest stały przez cały plan,
 * więc „poniedziałkowa siła" z tygodnia N ma swój odpowiednik w N+1.
 */
export interface WeekProgressionOptions {
  /**
   * Pomija sesje docelowe, które mają już wpis w logu.
   *
   * Domyślnie wyłączone, bo progresja uruchamiana po zapisaniu treningu dotyczy
   * tygodnia PRZYSZŁEGO, gdzie logów nie ma. Włącza to ręczna aktualizacja
   * tygodnia (`refreshWeekFromHistory`), która może trafić na tydzień częściowo
   * już wykonany — przepisywanie ciężarów pod zapisaną sesją zmieniałoby plan,
   * względem którego trening został oceniony.
   */
  skipLoggedTargets?: boolean
}

export async function applyWeekProgression(
  planId: Uuid,
  targetWeekIndex: number,
  options: WeekProgressionOptions = {},
): Promise<ProgressionSummary> {
  const sourceWeekIndex = targetWeekIndex - 1
  const empty: ProgressionSummary = {
    targetWeekIndex,
    sourceWeekIndex,
    updatedSessions: 0,
    entries: [],
  }
  if (sourceWeekIndex < 0) return empty

  const [sourceSessions, targetSessions] = await Promise.all([
    planRepo.sessionsForWeek(planId, sourceWeekIndex),
    planRepo.sessionsForWeek(planId, targetWeekIndex),
  ])

  const skipIds = options.skipLoggedTargets ? await loggedPlannedSessionIds() : null
  const targetByDay = new Map(
    targetSessions.filter((s) => !skipIds?.has(s.id)).map((s) => [s.dayOfWeek, s]),
  )
  const entries: ExerciseProgression[] = []
  const updates: PlannedSession[] = []
  const now = stamp()

  for (const source of sourceSessions) {
    if (source.payload.kind !== 'strength') continue
    const target = targetByDay.get(source.dayOfWeek)
    if (!target || target.payload.kind !== 'strength') continue

    const log = alive(
      await db.sessionLogs.where('plannedSessionId').equals(source.id).toArray(),
    )[0]
    if (!log) continue

    const setLogs = alive(await db.setLogs.where('sessionLogId').equals(log.id).toArray())
    const targetPayload = target.payload as StrengthPayload
    let changed = false

    const nextExercises = targetPayload.exercises.map((targetExercise) => {
      const sourceExercise = (source.payload as StrengthPayload).exercises.find(
        (e) => e.exerciseId === targetExercise.exerciseId,
      )
      if (!sourceExercise) return targetExercise

      const logged = setLogs
        .filter((s) => s.exerciseId === targetExercise.exerciseId)
        .sort((a, b) => a.setIndex - b.setIndex)
      if (logged.length === 0) return targetExercise

      const pattern: MovementPattern =
        WORKOUT_EXERCISES_BY_ID.get(targetExercise.exerciseId)?.pattern ?? 'isolation'

      const result = evaluateProgression({
        planned: sourceExercise.sets,
        logged,
        pattern,
      })

      entries.push({
        exerciseId: targetExercise.exerciseId,
        exerciseName: WORKOUT_EXERCISES_BY_ID.get(targetExercise.exerciseId)?.name ?? targetExercise.exerciseId,
        verdict: result.verdict,
        suggestedWeightKg: result.suggestedWeightKg,
        reason: result.reason,
      })

      changed = true
      // Faza tygodnia DOCELOWEGO decyduje o obciążeniu: w deloadzie progresja
      // wchodzi obniżona, inaczej „tydzień lżejszy" wychodził cięższy od
      // poprzedniego — patrz `ApplyProgressionOptions`.
      return {
        ...targetExercise,
        sets: applyProgression(targetExercise.sets, result, {
          deload: target.phase === 'deload',
        }),
      }
    })

    if (changed) {
      updates.push({
        ...target,
        payload: { ...targetPayload, exercises: nextExercises },
        updatedAt: now,
      })
    }
  }

  if (updates.length > 0) {
    await db.plannedSessions.bulkPut(updates)
  }

  return { targetWeekIndex, sourceWeekIndex, updatedSessions: updates.length, entries }
}

// ─────────────────────────── Aktualizacja tygodnia z historii

export interface CarriedLoad {
  exerciseId: string
  exerciseName: string
  weightKg: number
}

export interface WeekRefreshSummary {
  weekIndex: number
  /** Tydzień, z którego wzięła się progresja. Null dla pierwszego tygodnia planu. */
  sourceWeekIndex: number | null
  /** Sesje siłowe zmienione progresją z poprzedniego tygodnia. */
  progressedSessions: number
  progression: ExerciseProgression[]
  /** Ćwiczenia, którym ustawiono ciężar z historii spoza poprzedniego tygodnia. */
  carried: CarriedLoad[]
  /** Sesje cardio przeliczone na formę z odbytych sesji. */
  cardioSessions: number
  cardioFromLogs: AchievedCardio
  /** Sesje pominięte, bo są już zalogowane. */
  keptLogged: number
  /** Ile sesji łącznie zapisano na nowo. */
  updatedSessions: number
}

/**
 * Przelicza JEDEN tydzień planu na podstawie tego, co już zostało zrobione.
 *
 * Zastępuje dawny przycisk „usuń plan na tydzień". Powód zamiany: usuwanie było
 * czynnością na tydzień, którego nie będzie, a codzienna potrzeba jest odwrotna —
 * tydzień JEST, tylko jego liczby pochodzą z momentu generowania planu i nie
 * wiedzą o treningach zapisanych od tamtej pory.
 *
 * Trzy źródła danych, w tej kolejności — od najbardziej do najmniej konkretnego:
 *
 *  1. **Log tygodnia poprzedniego** → progresja per ćwiczenie (`evaluateProgression`).
 *     To samo, co dzieje się automatycznie po zapisaniu treningu; tutaj można
 *     to wywołać ręcznie, także po poprawieniu wpisu w logu.
 *  2. **Cała historia** → ciężar roboczy dla ćwiczeń, których w poprzednim
 *     tygodniu nie było (`latestWorkingLoads`). Bez tego kroku tydzień pierwszy
 *     nowego bloku i ćwiczenia trenowane rzadziej niż raz w tygodniu zostawałyby
 *     z ciężarem „z sufitu".
 *  3. **Odbyte sesje cardio** → dystans i tempo (`achievedCardio`). Bieganie
 *     i pływanie mają swoją progresję tak samo jak siła.
 *
 * Sesje z zapisanym treningiem są POMIJANE. Trening, który się odbył, jest
 * faktem — przepisanie planu pod nim zmieniłoby to, względem czego został
 * oceniony, a przy okazji rozjechałoby statystykę realizacji.
 */
export async function refreshWeekFromHistory(
  profile: Profile,
  weekIndex: number,
): Promise<WeekRefreshSummary | null> {
  const plan = await planRepo.active()
  if (!plan || weekIndex < 0 || weekIndex >= plan.weeks) return null

  const progression =
    weekIndex > 0
      ? await applyWeekProgression(plan.id, weekIndex, { skipLoggedTargets: true })
      : null

  // Sesje czytamy PO progresji — inaczej drugi przebieg nadpisałby jej wynik
  // ciężarem z historii, czyli cofnąłby właśnie policzoną zmianę.
  const sessions = await planRepo.sessionsForWeek(plan.id, weekIndex)
  const loggedIds = await loggedPlannedSessionIds()
  const openSessions = sessions.filter((session) => !loggedIds.has(session.id))

  const progressedExerciseIds = new Set(progression?.entries.map((e) => e.exerciseId) ?? [])
  const knownLoads = await planRepo.achievedLoads()
  const weekStart = addDays(startOfWeek(plan.startDate), weekIndex * 7)
  const cardioFromLogs = await planRepo.achievedCardio(profile, weekStart)
  const baselines = withCardioBaselines(profile, cardioFromLogs)
  const load = weekLoad(weekIndex, plan.weeks, profile.goal, plan.blockOffsetWeeks ?? 0)

  const carried: CarriedLoad[] = []
  const updates: PlannedSession[] = []
  const now = stamp()
  let cardioSessions = 0

  for (const session of openSessions) {
    if (session.payload.kind === 'strength') {
      const payload = session.payload as StrengthPayload
      let changed = false

      const exercises = payload.exercises.map((exercise) => {
        // Ćwiczenie objęte progresją z poprzedniego tygodnia już ma swój ciężar.
        if (progressedExerciseIds.has(exercise.exerciseId)) return exercise

        const achieved = knownLoads.get(exercise.exerciseId)
        if (achieved === undefined) return exercise
        /**
         * W deloadzie ciężar z historii wchodzi OBNIŻONY.
         *
         * Bez tego przycisk „zaktualizuj tydzień z historii" kasował deload:
         * wpisywał pełny ciężar roboczy w tydzień, którego jedynym zadaniem jest
         * być lżejszym. To ta sama pomyłka, którą naprawiliśmy w progresji.
         */
        const known = load.phase === 'deload' ? deloadWeight(achieved) : achieved
        if (exercise.sets.every((set) => set.weightKg === known)) return exercise

        changed = true
        carried.push({
          exerciseId: exercise.exerciseId,
          exerciseName: WORKOUT_EXERCISES_BY_ID.get(exercise.exerciseId)?.name ?? exercise.exerciseId,
          // Raportujemy ciężar FAKTYCZNIE wpisany, nie ten z historii —
          // podsumowanie nie ma prawa pokazywać innej liczby niż plan.
          weightKg: known,
        })
        return { ...exercise, sets: exercise.sets.map((set) => ({ ...set, weightKg: known })) }
      })

      if (changed) {
        updates.push({ ...session, payload: { ...payload, exercises }, updatedAt: now })
      }
      continue
    }

    if (session.payload.kind === 'run' && cardioFromLogs.run) {
      // Wariant biegu bierzemy z sesji, nie z profilu: to plan zdecydował,
      // czy ten dzień jest biegiem spokojnym, czy interwałami.
      const variant = session.payload.intervals === null ? 'easy' : 'intervals'
      const payload = runSession(profile.experience, load, variant, baselines.runBaseline)
      if (payload.distanceM !== session.payload.distanceM ||
        payload.targetPaceSecPerKm !== session.payload.targetPaceSecPerKm) {
        cardioSessions++
        updates.push({ ...session, payload, updatedAt: now })
      }
      continue
    }

    if (session.payload.kind === 'swim' && cardioFromLogs.swim) {
      const payload = swimSession(profile.experience, load, baselines.swimBaseline)
      if (payload.distanceM !== session.payload.distanceM) {
        cardioSessions++
        updates.push({ ...session, payload, updatedAt: now })
      }
    }
  }

  if (updates.length > 0) {
    await db.plannedSessions.bulkPut(updates)
  }

  return {
    weekIndex,
    sourceWeekIndex: weekIndex > 0 ? weekIndex - 1 : null,
    progressedSessions: progression?.updatedSessions ?? 0,
    progression: progression?.entries ?? [],
    carried,
    cardioSessions,
    cardioFromLogs,
    keptLogged: sessions.length - openSessions.length,
    updatedSessions: (progression?.updatedSessions ?? 0) + updates.length,
  }
}

/** Identyfikatory zaplanowanych sesji, do których istnieje wpis w logu. */
async function loggedPlannedSessionIds(): Promise<Set<Uuid>> {
  return new Set(
    alive(await db.sessionLogs.toArray())
      .map((log) => log.plannedSessionId)
      .filter((id): id is Uuid => id !== null),
  )
}
