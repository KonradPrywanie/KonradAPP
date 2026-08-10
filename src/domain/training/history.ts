import type {
  CardioLog,
  IsoDate,
  RunBaseline,
  SessionLog,
  SetLog,
  SwimBaseline,
} from '../types'
import { diffDays } from '../dates'
import { SWIM_SESSION_MULTIPLIER } from './cardio'

/**
 * Odczyt dorobku z logu treningowego.
 *
 * Po co: generator planu ustawia ciężary na `null`, bo na etapie generowania
 * nie zna siły użytkownika. To poprawne przy PIERWSZYM planie i błędne przy
 * każdym następnym — po 12 tygodniach albo po korekcie profilu użytkownik ma
 * już dorobek i cofanie go do odgadywania obciążeń od zera jest stratą.
 *
 * Ta warstwa jest czystą funkcją, żeby dała się przetestować bez bazy.
 */

export interface AchievedLoad {
  exerciseId: string
  /** Najcięższa seria z NAJNOWSZEJ sesji, w której ćwiczenie wystąpiło. */
  weightKg: number
  reps: number
  date: IsoDate
}

/**
 * Aktualny ciężar roboczy per ćwiczenie.
 *
 * Bierzemy najcięższą serię z ostatniej sesji, a nie rekord życiowy: rekord
 * z sprzed pół roku nie jest ciężarem, od którego da się dziś zacząć.
 * Sesje oznaczone jako pominięte i wpisy wycofane (soft delete) są ignorowane —
 * nie odbyły się.
 */
export function latestWorkingLoads(
  logs: readonly SessionLog[],
  sets: readonly SetLog[],
): Map<string, AchievedLoad> {
  const usableLogs = new Map(
    logs.filter((log) => !log.deletedAt && log.status !== 'skipped').map((log) => [log.id, log]),
  )
  const best = new Map<string, AchievedLoad>()

  for (const set of sets) {
    if (set.deletedAt) continue
    if (set.weightKg == null || set.weightKg <= 0) continue

    const log = usableLogs.get(set.sessionLogId)
    if (!log) continue

    const current = best.get(set.exerciseId)
    const fromNewerSession = current === undefined || log.date > current.date
    const heavierInSameSession =
      current !== undefined && log.date === current.date && set.weightKg > current.weightKg

    if (fromNewerSession || heavierInSameSession) {
      best.set(set.exerciseId, {
        exerciseId: set.exerciseId,
        weightKg: set.weightKg,
        reps: set.reps,
        date: log.date,
      })
    }
  }

  return best
}

/** Sam ciężar per ćwiczenie — kontrakt, jakiego oczekuje generator planu. */
export function toWeightMap(loads: ReadonlyMap<string, AchievedLoad>): Map<string, number> {
  return new Map([...loads.values()].map((load) => [load.exerciseId, load.weightKg]))
}

// ──────────────────────────────────── Punkt wyjścia w cardio z logu

/**
 * Ile dni wstecz patrzymy, szukając aktualnej formy w cardio.
 *
 * Plan powstaje na dwa tygodnie, więc odniesieniem jest ostatni miesiąc.
 * Sesja z pół roku temu nie mówi, ile użytkownik przebiegnie dziś — a to
 * dokładnie ten sam powód, dla którego ciężary bierzemy z ostatniej sesji,
 * nie z rekordu życiowego.
 */
export const CARDIO_BASELINE_WINDOW_DAYS = 28

export interface AchievedCardio {
  run?: RunBaseline
  swim?: SwimBaseline
}

/**
 * Aktualny punkt wyjścia w cardio, policzony z tego, co zostało zrobione.
 *
 * Bez tego kolejny plan powtarzałby dystanse z profilu w nieskończoność:
 * użytkownik podał 3 km na starcie, przebiegł już 7 km, a plan wciąż
 * proponował 3 km × mnożnik tygodnia. Progresja siłowa domykała pętlę od
 * początku (log → ciężary), cardio nie miało odpowiednika.
 *
 * Reguły — te same, co w progresji siłowej:
 *  - liczą się WYŁĄCZNIE sesje odbyte (`done`); pominięta sesja nie jest
 *    dowodem formy, a częściowa nie mówi, ile z niej wyszło,
 *  - bierzemy NAJDŁUŻSZY dystans z okna, bo o zakres decyduje najdłuższa
 *    przebiegnięta trasa, nie średnia,
 *  - tempo bierzemy z TEJ SAMEJ sesji, co dystans — tempo z krótkiego szybkiego
 *    biegu połączone z długim dystansem dałoby cel, którego nikt nie wykona,
 *  - wynik gorszy od deklaracji z profilu jest ignorowany: jeden słaby trening
 *    nie może obniżyć planu (formę obniża deload, nie jedna sesja).
 *
 * Tempo nie może się cofnąć i to jest tu istotne, a nie ostrożnościowe:
 * plan każe biegać spokojnie o 30 s/km wolniej od tempa z profilu, więc
 * przyjęcie tempa z takiego biegu jako nowej bazy dokładałoby pół minuty przy
 * każdym odnowieniu planu i po kilku cyklach zjechałoby do marszu.
 */
export function achievedCardio(
  logs: readonly SessionLog[],
  cardio: readonly CardioLog[],
  today: IsoDate,
  declared: { run?: RunBaseline; swim?: SwimBaseline } = {},
  windowDays = CARDIO_BASELINE_WINDOW_DAYS,
): AchievedCardio {
  const usable = new Map(
    logs
      .filter((log) => !log.deletedAt && log.status === 'done')
      .filter((log) => {
        const age = diffDays(log.date, today)
        return age >= 0 && age < windowDays
      })
      .map((log) => [log.id, log]),
  )

  let bestRun: { distanceM: number; durationSec: number } | null = null
  let bestSwimM = 0

  for (const entry of cardio) {
    if (entry.deletedAt) continue
    if (entry.distanceM <= 0 || entry.durationSec <= 0) continue
    const log = usable.get(entry.sessionLogId)
    if (!log) continue

    if (log.type === 'run') {
      if (!bestRun || entry.distanceM > bestRun.distanceM) {
        bestRun = { distanceM: entry.distanceM, durationSec: entry.durationSec }
      }
    } else if (log.type === 'swim') {
      bestSwimM = Math.max(bestSwimM, entry.distanceM)
    }
    // Spacer świadomie pomijany: 6 km marszu nie jest dowodem formy biegowej.
  }

  const result: AchievedCardio = {}

  if (bestRun && bestRun.distanceM > (declared.run?.distanceM ?? 0)) {
    const loggedPace = Math.round(bestRun.durationSec / (bestRun.distanceM / 1000))
    result.run = {
      distanceM: Math.round(bestRun.distanceM),
      paceSecPerKm: Math.min(loggedPace, declared.run?.paceSecPerKm ?? loggedPace),
    }
  }

  /**
   * Pływanie ma jeden kłopot, którego bieganie nie ma: log zna sumę metrów
   * z całej sesji, a baza to dystans przepływany BEZ PRZERWY. Sesja 660 m
   * w seriach nie znaczy, że użytkownik przepłynie 660 m ciągiem.
   *
   * Odwracamy więc to samo przełożenie, którym plan liczy sesję z bazy
   * (`SWIM_SESSION_MULTIPLIER`). Jest spójne po obu stronach: sesja wykonana
   * dokładnie tak, jak zaplanowana, daje bazę równą deklarowanej, a dopiero
   * przepłynięcie WIĘCEJ niż zaplanowano ją podnosi.
   *
   * Długość basenu i styl zostają z profilu — log zna metry, nie to, w jakim
   * basenie i jakim stylem zostały przepłynięte.
   */
  if (declared.swim && bestSwimM > 0) {
    // Zaokrąglenie do pełnych metrów PRZED dzieleniem: 1100 / 2,2 daje
    // 499,999… i sama podłoga urwałaby całą długość basenu.
    const impliedContinuousM = Math.round(bestSwimM / SWIM_SESSION_MULTIPLIER)
    const laps = Math.floor(impliedContinuousM / declared.swim.poolLengthM)
    if (laps > declared.swim.laps) {
      result.swim = { ...declared.swim, laps }
    }
  }

  return result
}
