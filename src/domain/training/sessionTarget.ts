import type { ActivityLevel, Experience } from '../types'

/**
 * Ile sesji w tygodniu — wyliczane, nie pytane.
 *
 * Wcześniej było to osobne pole w profilu. Zostało usunięte świadomie: liczba
 * treningów wynika z tego, ile ktoś już się rusza i jak długo trenuje, a te
 * dwie rzeczy profil i tak zbiera. Pytanie o trzecią, spójną z nimi wartość
 * dawało trzy okazje do sprzeczności („siedząca, początkująca, 6 treningów")
 * i zapisywało w bazie dane, które mogły rozjechać się z resztą profilu.
 *
 * Zakres 3–6, w praktyce najczęściej 4 albo 5.
 *
 * Liczba jest STAŁA dla danego profilu, nie losowana co tydzień. Struktura
 * tygodnia musi być powtarzalna, bo na niej opiera się śledzenie progresji:
 * te same ćwiczenia w ten sam dzień tygodnia. Zmienia się obciążenie.
 */
const TARGETS: Record<Experience, Record<ActivityLevel, number>> = {
  beginner: {
    sedentary: 3,
    light: 3,
    moderate: 4,
    high: 4,
    veryHigh: 4,
  },
  intermediate: {
    sedentary: 3,
    light: 4,
    moderate: 4,
    high: 5,
    veryHigh: 5,
  },
  advanced: {
    sedentary: 4,
    light: 4,
    moderate: 5,
    high: 5,
    veryHigh: 6,
  },
}

export const MIN_WEEKLY_SESSIONS = 3
export const MAX_WEEKLY_SESSIONS = 6

export function derivedWeeklySessions(
  activityLevel: ActivityLevel,
  experience: Experience,
): number {
  return TARGETS[experience][activityLevel]
}
