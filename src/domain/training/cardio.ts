import type { Experience, RunBaseline, RunPayload, SwimBaseline, SwimPayload } from '../types'
import type { WeekLoad } from './mesocycle'
import type { RunVariant } from './schedule'

/**
 * Presety awaryjne, gdy użytkownik nie podała własnego punktu wyjścia.
 *
 * Są zgrubne z definicji — dwie osoby oznaczone jako „średniozaawansowane"
 * mogą różnić się o dwie minuty na kilometrze. Dlatego kreator pyta o realny
 * dystans i tempo, a te wartości służą tylko jako zapas.
 */
const RUN_FALLBACK: Record<Experience, RunBaseline> = {
  beginner: { distanceM: 3000, paceSecPerKm: 420 }, // 7:00 /km
  intermediate: { distanceM: 6000, paceSecPerKm: 330 }, // 5:30 /km
  advanced: { distanceM: 10000, paceSecPerKm: 285 }, // 4:45 /km
}

const SWIM_FALLBACK: Record<Experience, SwimBaseline> = {
  beginner: { laps: 12, poolLengthM: 25, stroke: 'any' },
  intermediate: { laps: 24, poolLengthM: 25, stroke: 'freestyle' },
  advanced: { laps: 40, poolLengthM: 25, stroke: 'freestyle' },
}

/**
 * Bieg spokojny ma być SPOKOJNY.
 *
 * Podane tempo to tempo, w jakim użytkownik biega dziś na swoim dystansie —
 * czyli jej tempo z wysiłkiem. Bieg w strefie 2 musi być od niego wolniejszy,
 * inaczej „spokojny" bieg co tydzień byłby biegiem na czas.
 */
const EASY_PACE_OFFSET_SEC = 30
/** Odcinki interwałowe są szybsze od tempa bazowego. */
const INTERVAL_PACE_OFFSET_SEC = -30

/** Odcinek interwałowy. */
const INTERVAL_LEG_M = 400
const INTERVAL_REST_SEC = 90

/**
 * Ile razy dystans sesji przekracza to, co użytkownik przepływa ciągiem.
 * Praca w seriach z przerwami pozwala pokryć wyraźnie więcej niż bez przerwy.
 *
 * Eksportowane, bo `achievedCardio()` odwraca to przełożenie, czytając bazę
 * z sumy metrów w logu. Dwie kopie tej liczby rozjechałyby się przy pierwszej
 * korekcie i progresja pływacka zaczęłaby dryfować w jedną stronę.
 */
export const SWIM_SESSION_MULTIPLIER = 2.2

export function runSession(
  experience: Experience,
  load: WeekLoad,
  variant: RunVariant,
  baseline?: RunBaseline,
): RunPayload {
  const base = baseline ?? RUN_FALLBACK[experience]
  const longTerm = 1 + 0.05 * load.blockIndex

  if (variant === 'intervals') {
    const distanceM = round100(base.distanceM * 0.6 * load.volumeFactor * longTerm)
    const legs = clamp(Math.round((distanceM * 0.5) / INTERVAL_LEG_M), 4, 12)
    const pace = paceFor(base.paceSecPerKm, INTERVAL_PACE_OFFSET_SEC, load)
    return {
      kind: 'run',
      distanceM,
      targetPaceSecPerKm: pace,
      // Przerwy między odcinkami wydłużają sesję poza czysty czas biegu.
      durationSec: Math.round((distanceM / 1000) * pace + legs * INTERVAL_REST_SEC),
      zone: 4,
      intervals: `${legs}×${INTERVAL_LEG_M} m / ${INTERVAL_REST_SEC} s przerwy`,
    }
  }

  const distanceM = round100(base.distanceM * load.volumeFactor * longTerm)
  const pace = paceFor(base.paceSecPerKm, EASY_PACE_OFFSET_SEC, load)
  return {
    kind: 'run',
    distanceM,
    targetPaceSecPerKm: pace,
    durationSec: Math.round((distanceM / 1000) * pace),
    zone: 2,
    intervals: null,
  }
}

export function swimSession(
  experience: Experience,
  load: WeekLoad,
  baseline?: SwimBaseline,
): SwimPayload {
  const base = baseline ?? SWIM_FALLBACK[experience]
  const longTerm = 1 + 0.05 * load.blockIndex

  const continuousM = Math.max(base.poolLengthM, base.laps * base.poolLengthM)
  const targetM = continuousM * SWIM_SESSION_MULTIPLIER * load.volumeFactor * longTerm
  const { sets, setLengthM } = splitIntoSets(targetM, base.poolLengthM)

  return {
    kind: 'swim',
    // Dystans to ILOCZYN serii i odcinka, nie zaokrąglony cel. Dzięki temu
    // liczby w planie się zgadzają: 14 serii × 175 m to dokładnie 2450 m,
    // a 175 m to równe 7 długości basenu.
    distanceM: sets * setLengthM,
    stroke: base.stroke,
    sets,
    restSec: restForStroke(base.stroke, experience),
  }
}

const MIN_SWIM_SETS = 4
const MAX_SWIM_SETS = 16

/**
 * Dzieli zamierzony dystans na serie.
 *
 * Odcinek startuje od dwóch długości basenu (tam i z powrotem — naturalna
 * porcja) i wydłuża się o kolejne długości, gdy serii wyszłoby za dużo.
 *
 * Dwa poprzednie podejścia były błędne i oba wyszły z testów:
 *  1. Przycięcie liczby serii dawało „2200 m, 20 serii po 50 m" = 1000 m.
 *  2. Dzielenie zaokrąglonego dystansu przez serie dawało 170 m na serię,
 *     czyli 6,8 długości basenu — odcinek, którego nie da się przepłynąć.
 * Dlatego liczymy w drugą stronę: najpierw odcinek i serie, potem dystans.
 */
function splitIntoSets(
  targetM: number,
  poolLengthM: number,
): { sets: number; setLengthM: number } {
  let setLengthM = poolLengthM * 2
  let sets = Math.max(MIN_SWIM_SETS, Math.round(targetM / setLengthM))

  while (sets > MAX_SWIM_SETS) {
    setLengthM += poolLengthM
    sets = Math.max(MIN_SWIM_SETS, Math.round(targetM / setLengthM))
  }

  return { sets, setLengthM }
}

/**
 * Tempo docelowe.
 *
 * Przesunięcie względem tempa bazowego nadaje sesji charakter (spokojny bieg
 * wolniejszy, interwały szybsze), a dzielenie przez współczynnik intensywności
 * daje długoterminową progresję — szybciej znaczy MNIEJ sekund na kilometr.
 */
function paceFor(basePaceSecPerKm: number, offsetSec: number, load: WeekLoad): number {
  return Math.round((basePaceSecPerKm + offsetSec) / load.intensityFactor)
}

/** Krótsza przerwa dla stylu, który użytkownik opanował lepiej. */
function restForStroke(stroke: SwimBaseline['stroke'], experience: Experience): number {
  if (stroke === 'any') return 45
  return experience === 'advanced' ? 30 : 40
}

function round100(meters: number): number {
  return Math.max(100, Math.round(meters / 100) * 100)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
