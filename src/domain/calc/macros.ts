import type { CalcWarning, Goal, Macros } from '../types'

export const KCAL_PER_G = { protein: 4, fat: 9, carbs: 4 } as const

/** Docelowa podaż białka w g na kg masy odniesienia. */
const PROTEIN_G_PER_KG: Record<Goal, number> = {
  cut: 2.0, // wyższa na deficycie — chroni masę mięśniową
  maintain: 1.8,
  bulk: 1.8,
  conditioning: 1.6,
  event: 1.8,
}

/** Minimum tłuszczu — poniżej cierpi gospodarka hormonalna i wchłanianie witamin. */
const FAT_FLOOR_G_PER_KG = 0.8
/** Docelowy udział tłuszczu w kaloryczności, gdy podłoga nie jest wiążąca. */
const FAT_TARGET_KCAL_SHARE = 0.25
/** Minimum węglowodanów — poniżej spada jakość treningów. */
const MIN_CARBS_G = 50
/** Białko nie powinno przekraczać tego udziału kalorii. */
const MAX_PROTEIN_KCAL_SHARE = 0.4

export interface MacroInput {
  kcal: number
  goal: Goal
  weightKg: number
  heightCm: number
  bodyFatPct?: number | undefined
}

export interface MacroResult {
  macros: Macros
  /** Masa użyta do przeliczeń g/kg — patrz `referenceWeightKg`. */
  referenceWeightKg: number
  warnings: CalcWarning[]
}

/**
 * Masa odniesienia dla wyliczeń g/kg.
 *
 * Przy otyłości surowa masa ciała daje absurdalne wartości (150 kg × 2 g/kg
 * = 300 g białka), bo tkanka tłuszczowa nie ma zapotrzebowania na białko.
 * Używamy klinicznej masy skorygowanej:  IBW + 0,4 · (masa − IBW),
 * gdzie IBW to masa przy BMI 25. Gdy znany %BF — liczymy z masy beztłuszczowej.
 */
export function referenceWeightKg(
  weightKg: number,
  heightCm: number,
  bodyFatPct?: number | undefined,
): number {
  if (bodyFatPct != null && Number.isFinite(bodyFatPct)) {
    const leanMassKg = weightKg * (1 - bodyFatPct / 100)
    // Beztłuszczowa + zapas na tkankę tłuszczową o niskim zapotrzebowaniu.
    return round1(leanMassKg * 1.15)
  }
  const heightM = heightCm / 100
  const idealWeightKg = 25 * heightM * heightM
  if (weightKg <= idealWeightKg) return round1(weightKg)
  return round1(idealWeightKg + 0.4 * (weightKg - idealWeightKg))
}

export function macros(input: MacroInput): MacroResult {
  const { kcal, goal } = input
  if (!Number.isFinite(kcal) || kcal <= 0) throw new RangeError('Kalorie muszą być dodatnie')

  const warnings: CalcWarning[] = []
  const refKg = referenceWeightKg(input.weightKg, input.heightCm, input.bodyFatPct)

  // Białko — z limitem udziału w kaloriach.
  let proteinG = Math.round(refKg * PROTEIN_G_PER_KG[goal])
  const proteinCapG = Math.floor((kcal * MAX_PROTEIN_KCAL_SHARE) / KCAL_PER_G.protein)
  if (proteinG > proteinCapG) proteinG = proteinCapG

  // Tłuszcz — większa z dwóch wartości: podłoga g/kg albo udział w kaloriach.
  const fatFloorG = Math.round(refKg * FAT_FLOOR_G_PER_KG)
  let fatG = Math.max(fatFloorG, Math.round((kcal * FAT_TARGET_KCAL_SHARE) / KCAL_PER_G.fat))

  // Węglowodany — reszta budżetu.
  let carbsG = carbsFromRemainder(kcal, proteinG, fatG)

  // Gdy węgli zabrakło, oddajemy tłuszcz aż do jego podłogi.
  if (carbsG < MIN_CARBS_G && fatG > fatFloorG) {
    const kcalNeeded = (MIN_CARBS_G - carbsG) * KCAL_PER_G.carbs
    const reductionG = Math.min(fatG - fatFloorG, Math.ceil(kcalNeeded / KCAL_PER_G.fat))
    fatG -= reductionG
    carbsG = carbsFromRemainder(kcal, proteinG, fatG)
  }

  if (carbsG < MIN_CARBS_G) {
    warnings.push({
      code: 'lowCarbs',
      message:
        `Przy ${kcal} kcal i tym poziomie białka/tłuszczu na węglowodany zostaje ` +
        `${Math.max(0, carbsG)} g. To mało — rozważ podniesienie celu kalorycznego.`,
    })
    carbsG = Math.max(0, carbsG)
  }

  return {
    macros: { kcal, proteinG, fatG, carbsG },
    referenceWeightKg: refKg,
    warnings,
  }
}

/** Kalorie zamknięte w makro — do walidacji spójności. */
export function kcalFromMacros(m: Pick<Macros, 'proteinG' | 'fatG' | 'carbsG'>): number {
  return Math.round(
    m.proteinG * KCAL_PER_G.protein + m.fatG * KCAL_PER_G.fat + m.carbsG * KCAL_PER_G.carbs,
  )
}

function carbsFromRemainder(kcal: number, proteinG: number, fatG: number): number {
  const remaining = kcal - proteinG * KCAL_PER_G.protein - fatG * KCAL_PER_G.fat
  return Math.round(remaining / KCAL_PER_G.carbs)
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
