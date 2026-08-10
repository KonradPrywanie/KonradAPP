import { useLiveQuery } from 'dexie-react-hooks'
import type { NutritionTargets, Profile, WeightTrendPoint } from '@/domain/types'
import {
  adaptiveTdee,
  currentTrendKg,
  nutritionTargets,
  trendRateKgPerWeek,
  weightTrend,
  type AdaptiveTdeeResult,
} from '@/domain/calc'
import { mealLogRepo, weightRepo } from '@/db/repositories'

export interface TargetsState {
  targets: NutritionTargets
  /**
   * Masa, z której policzone są cele: `profile.startWeightKg`.
   * Zmienia się WYŁĄCZNIE przy jawnej edycji profilu.
   */
  referenceWeightKg: number
  /** Masa z trendu pomiarów — do pokazania, nigdy do liczenia. */
  trendWeightKg: number | null
  /**
   * Realny wydatek policzony z danych. INFORMACYJNY — nie wchodzi do `targets`.
   * Null, dopóki nie ma 14 dni z pokryciem ≥70%.
   */
  adaptive: AdaptiveTdeeResult | null
  trend: WeightTrendPoint[]
  rateKgPerWeek: number | null
  measurementCount: number
}

/**
 * Cele żywieniowe.
 *
 * KLUCZOWA ZASADA: codzienne ważenie NIE zmienia wyliczeń. Cele liczą się
 * z masy odniesienia z profilu, a kolejne pomiary są historią — zasilają
 * wykres, trend i tempo zmian, ale nie ruszają kalorii ani makro.
 *
 * Wcześniej było odwrotnie: cel liczył się z bieżącego trendu, a po 14 dniach
 * podmieniał TDEE na policzony z danych. Brzmi to precyzyjniej, niż działało.
 * Skutki były dwa i oba złe:
 *  1. **Jadłospis ruszał się pod ręką.** Cel kaloryczny zmieniał się po każdym
 *     wejściu na wagę, a razem z nim gramatury i lista zakupów — kupione
 *     produkty przestawały pasować do planu, który je zamówił.
 *  2. **Wahania nawodnienia udawały informację.** Dobowa różnica ±1,5 kg
 *     przekłada się na kilkadziesiąt kcal w jedną i drugą stronę. To szum,
 *     nie sygnał, a wyglądał jak precyzja.
 *
 * Masę odniesienia podnosi się albo obniża ŚWIADOMIE, w profilu — wtedy
 * jadłospis przelicza się raz, w kontrolowanym momencie. Adaptacyjny TDEE
 * zostaje policzony i pokazany, bo jest cenną informacją („jesz o 300 kcal
 * więcej, niż wydajesz"), ale nie przestawia celu za plecami użytkownika.
 */
export function useTargets(profile: Profile): TargetsState | undefined {
  return useLiveQuery(async () => {
    const [entries, intake] = await Promise.all([
      weightRepo.all(),
      mealLogRepo.dailyIntake(),
    ])

    const trend = weightTrend(entries)
    const referenceWeightKg = profile.startWeightKg
    const targets = nutritionTargets(profile, referenceWeightKg)

    return {
      targets,
      referenceWeightKg,
      trendWeightKg: currentTrendKg(trend),
      // Liczony z trendu i spożycia, więc zmienny — dlatego tylko do pokazania.
      adaptive: adaptiveTdee({ trend, intake, bmr: targets.bmr }),
      trend,
      rateKgPerWeek: trendRateKgPerWeek(trend),
      measurementCount: entries.length,
    }
  }, [profile.id, profile.updatedAt])
}
