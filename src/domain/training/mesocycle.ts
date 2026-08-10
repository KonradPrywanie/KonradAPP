import type { Goal, MesocyclePhase } from '../types'

/**
 * Periodyzacja obciążenia.
 *
 * Kluczowa poprawka względem pierwotnej wizji („każdy tydzień trudniejszy
 * od poprzedniego"): progresja liniowa przez 12 tygodni nie działa.
 * Po ~4 tygodniach kumuluje się zmęczenie i postęp się zatrzymuje albo
 * kończy kontuzją. Stąd bloki 3 + 1: trzy tygodnie akumulacji, czwarty
 * to deload o obniżonej objętości.
 *
 * Intensywność narasta MIĘDZY blokami i utrzymuje się po deloadzie —
 * objętość resetuje się w każdym bloku, ciężary nie.
 */

export const BLOCK_LENGTH_WEEKS = 4
/** Ostatnie tygodnie przed zawodami: objętość w dół, intensywność utrzymana. */
export const TAPER_WEEKS = 2

export interface WeekLoad {
  phase: MesocyclePhase
  /** Mnożnik liczby serii, dystansu i czasu. */
  volumeFactor: number
  /** Mnożnik obciążenia i tempa. */
  intensityFactor: number
  blockIndex: number
  weekInBlock: number
}

/**
 * @param blockOffsetWeeks Przesunięcie rytmu bloków. Pozwala regeneracji planu
 *   w środku cyklu zachować pozycję w mezocyklu — bez tego korekta profilu
 *   w tygodniu 7 odrzucałaby użytkownika do pierwszego tygodnia akumulacji
 *   i przesuwała deload o trzy tygodnie, kumulując zmęczenie.
 *   Tapering pozostaje liczony od KOŃCA planu, nie od rytmu bloków.
 */
export function weekLoad(
  weekIndex: number,
  totalWeeks: number,
  goal: Goal,
  blockOffsetWeeks = 0,
): WeekLoad {
  if (weekIndex < 0 || weekIndex >= totalWeeks) {
    throw new RangeError(`Tydzień ${weekIndex} poza planem długości ${totalWeeks}`)
  }

  const rhythmIndex = weekIndex + blockOffsetWeeks
  const blockIndex = Math.floor(rhythmIndex / BLOCK_LENGTH_WEEKS)
  const weekInBlock = rhythmIndex % BLOCK_LENGTH_WEEKS

  // Tapering przed zawodami ma pierwszeństwo nad rytmem bloków.
  const taperFrom = totalWeeks - TAPER_WEEKS
  if (goal === 'event' && weekIndex >= taperFrom) {
    const stepsIntoTaper = weekIndex - taperFrom
    return {
      phase: 'taper',
      volumeFactor: stepsIntoTaper === 0 ? 0.65 : 0.45,
      intensityFactor: 1 + 0.05 * blockIndex,
      blockIndex,
      weekInBlock,
    }
  }

  if (weekInBlock === BLOCK_LENGTH_WEEKS - 1) {
    return {
      phase: 'deload',
      volumeFactor: 0.6,
      intensityFactor: Math.max(0.85, 1 + 0.05 * blockIndex - 0.1),
      blockIndex,
      weekInBlock,
    }
  }

  return {
    phase: 'accumulation',
    volumeFactor: round3(1 + 0.075 * weekInBlock),
    intensityFactor: round3(1 + 0.05 * blockIndex + 0.025 * weekInBlock),
    blockIndex,
    weekInBlock,
  }
}

/** Wszystkie tygodnie planu — wygodne do testów i podglądu. */
export function planLoads(totalWeeks: number, goal: Goal, blockOffsetWeeks = 0): WeekLoad[] {
  return Array.from({ length: totalWeeks }, (_, i) =>
    weekLoad(i, totalWeeks, goal, blockOffsetWeeks),
  )
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}
