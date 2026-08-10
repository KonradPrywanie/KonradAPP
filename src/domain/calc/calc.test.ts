import { describe, expect, it } from 'vitest'
import { bmi, bmiCategory } from './bmi'
import { ageFromBirthYear, bmrKatchMcArdle, bmrMifflin, calcBmr } from './bmr'
import { tdee } from './tdee'
import { KCAL_FLOOR, MAX_DEFICIT_KCAL, MAX_SURPLUS_KCAL, kcalTarget } from './kcalTarget'
import { kcalFromMacros, macros, referenceWeightKg } from './macros'

describe('bmi', () => {
  it('liczy BMI z wagi i wzrostu', () => {
    expect(bmi(80, 180)).toBe(24.7)
    expect(bmi(65, 165)).toBe(23.9)
  })

  it('klasyfikuje na granicach kategorii', () => {
    expect(bmiCategory(18.4)).toBe('underweight')
    expect(bmiCategory(18.5)).toBe('normal')
    expect(bmiCategory(24.9)).toBe('normal')
    expect(bmiCategory(25)).toBe('overweight')
    expect(bmiCategory(29.9)).toBe('overweight')
    expect(bmiCategory(30)).toBe('obese')
  })

  it('odrzuca dane niedodatnie', () => {
    expect(() => bmi(0, 180)).toThrow(RangeError)
    expect(() => bmi(80, 0)).toThrow(RangeError)
  })
})

describe('bmr', () => {
  it('Mifflin-St Jeor dla mężczyzny', () => {
    // 10·80 + 6,25·180 − 5·30 + 5 = 800 + 1125 − 150 + 5
    expect(bmrMifflin({ sex: 'male', weightKg: 80, heightCm: 180, age: 30 })).toBe(1780)
  })

  it('Mifflin-St Jeor dla kobiety', () => {
    // 10·65 + 6,25·165 − 5·28 − 161 = 650 + 1031,25 − 140 − 161
    expect(bmrMifflin({ sex: 'female', weightKg: 65, heightCm: 165, age: 28 })).toBe(1380)
  })

  it('Katch-McArdle liczy z masy beztłuszczowej', () => {
    // LBM = 80 · 0,85 = 68;  370 + 21,6 · 68 = 1838,8
    expect(bmrKatchMcArdle(80, 15)).toBe(1839)
  })

  it('Katch-McArdle nie zależy od płci ani wzrostu', () => {
    expect(bmrKatchMcArdle(80, 15)).toBe(bmrKatchMcArdle(80, 15))
  })

  it('odrzuca niewiarygodny procent tkanki tłuszczowej', () => {
    expect(() => bmrKatchMcArdle(80, 2)).toThrow(RangeError)
    expect(() => bmrKatchMcArdle(80, 61)).toThrow(RangeError)
  })

  it('wybiera Katch-McArdle gdy znany %BF, inaczej Mifflin', () => {
    const base = { sex: 'male' as const, weightKg: 80, heightCm: 180, age: 30 }
    expect(calcBmr(base).formula).toBe('mifflin')
    expect(calcBmr({ ...base, bodyFatPct: 15 }).formula).toBe('katch')
  })

  it('liczy wiek z rocznika', () => {
    expect(ageFromBirthYear(1996, new Date('2026-07-29T00:00:00Z'))).toBe(30)
  })
})

describe('tdee', () => {
  it('mnoży BMR przez współczynnik aktywności', () => {
    expect(tdee(1780, 'sedentary')).toBe(2136)
    expect(tdee(1780, 'moderate')).toBe(2759)
    expect(tdee(1780, 'veryHigh')).toBe(3382)
  })
})

describe('kcalTarget', () => {
  const male = { sex: 'male' as const, weightKg: 80, heightCm: 180 }

  it('redukcja to −20% TDEE, gdy mieści się w limicie deficytu', () => {
    const r = kcalTarget({ tdee: 2759, bmr: 1780, goal: 'cut', ...male })
    expect(r.kcal).toBe(2207)
    expect(r.warnings).toHaveLength(0)
  })

  it('utrzymanie i kondycja nie zmieniają TDEE', () => {
    expect(kcalTarget({ tdee: 2759, bmr: 1780, goal: 'maintain', ...male }).kcal).toBe(2759)
    expect(kcalTarget({ tdee: 2759, bmr: 1780, goal: 'conditioning', ...male }).kcal).toBe(2759)
  })

  it('ogranicza deficyt do limitu i ostrzega', () => {
    const r = kcalTarget({ tdee: 4000, bmr: 2000, goal: 'cut', ...male })
    expect(r.rawKcal).toBe(3200) // −20% byłoby 800 kcal deficytu
    expect(r.kcal).toBe(4000 - MAX_DEFICIT_KCAL)
    expect(r.warnings.map((w) => w.code)).toContain('deficitCapped')
  })

  it('ogranicza nadwyżkę na masie', () => {
    const r = kcalTarget({ tdee: 5000, bmr: 2200, goal: 'bulk', ...male })
    expect(r.kcal).toBe(5000 + MAX_SURPLUS_KCAL)
  })

  it('nie stosuje deficytu przy niedowadze, nawet gdy cel to redukcja', () => {
    const r = kcalTarget({
      tdee: 2200,
      bmr: 1500,
      goal: 'cut',
      sex: 'male',
      weightKg: 50,
      heightCm: 175, // BMI 16,3
    })
    expect(r.kcal).toBe(2200)
    expect(r.warnings.map((w) => w.code)).toContain('underweightNoDeficit')
  })

  it('podnosi cel do podłogi bezpieczeństwa', () => {
    const r = kcalTarget({
      tdee: 1400,
      bmr: 1150,
      goal: 'cut',
      sex: 'female',
      weightKg: 55,
      heightCm: 160,
    })
    expect(r.kcal).toBe(KCAL_FLOOR.female)
    expect(r.warnings.map((w) => w.code)).toContain('kcalFloorApplied')
  })

  it('podłoga obowiązuje także przy ręcznym nadpisaniu', () => {
    const r = kcalTarget({ tdee: 2759, bmr: 1780, goal: 'cut', ...male, override: 800 })
    expect(r.kcal).toBe(KCAL_FLOOR.male)
    expect(r.warnings.map((w) => w.code)).toContain('kcalFloorApplied')
  })

  it('respektuje ręczne nadpisanie powyżej podłogi', () => {
    const r = kcalTarget({ tdee: 2759, bmr: 1780, goal: 'cut', ...male, override: 2400 })
    expect(r.kcal).toBe(2400)
  })

  it('ostrzega gdy cel schodzi poniżej BMR, ale nie zmienia wyniku', () => {
    const r = kcalTarget({
      tdee: 1900,
      bmr: 1700,
      goal: 'cut',
      sex: 'male',
      weightKg: 70,
      heightCm: 175,
    })
    expect(r.kcal).toBe(1520)
    expect(r.warnings.map((w) => w.code)).toContain('belowBmr')
  })
})

describe('referenceWeightKg', () => {
  it('przy prawidłowej masie zwraca masę rzeczywistą', () => {
    expect(referenceWeightKg(80, 180)).toBe(80)
  })

  it('przy otyłości koryguje masę — tkanka tłuszczowa nie potrzebuje białka', () => {
    // IBW przy BMI 25 = 72,25;  72,25 + 0,4 · (120 − 72,25) = 91,35
    expect(referenceWeightKg(120, 170)).toBe(91.4)
  })

  it('gdy znany %BF liczy z masy beztłuszczowej', () => {
    // LBM = 68;  68 · 1,15 = 78,2
    expect(referenceWeightKg(80, 180, 15)).toBe(78.2)
  })
})

describe('macros', () => {
  it('rozdziela kalorie na białko / tłuszcz / węglowodany', () => {
    const r = macros({ kcal: 2207, goal: 'cut', weightKg: 80, heightCm: 180 })
    expect(r.macros.proteinG).toBe(160) // 2,0 g/kg na redukcji
    expect(r.macros.fatG).toBe(64) // podłoga 0,8 g/kg wygrywa z 25% kcal
    expect(r.macros.carbsG).toBe(248)
    expect(r.warnings).toHaveLength(0)
  })

  it('suma makro odpowiada celowi kalorycznemu w granicach zaokrągleń', () => {
    for (const kcal of [1500, 1800, 2207, 2600, 3200]) {
      const r = macros({ kcal, goal: 'maintain', weightKg: 80, heightCm: 180 })
      expect(Math.abs(kcalFromMacros(r.macros) - kcal)).toBeLessThanOrEqual(10)
    }
  })

  it('nigdy nie schodzi z tłuszczem poniżej 0,8 g/kg', () => {
    const r = macros({ kcal: 1500, goal: 'cut', weightKg: 90, heightCm: 175 })
    const fatFloor = Math.round(r.referenceWeightKg * 0.8)
    expect(r.macros.fatG).toBeGreaterThanOrEqual(fatFloor)
  })

  it('ogranicza udział białka do 40% kalorii', () => {
    const r = macros({ kcal: 1400, goal: 'cut', weightKg: 95, heightCm: 165 })
    expect(r.macros.proteinG * 4).toBeLessThanOrEqual(1400 * 0.4)
  })

  it('ostrzega gdy na węglowodany zostaje za mało', () => {
    const r = macros({ kcal: 1200, goal: 'cut', weightKg: 100, heightCm: 165 })
    expect(r.warnings.map((w) => w.code)).toContain('lowCarbs')
    expect(r.macros.carbsG).toBeGreaterThanOrEqual(0)
  })

  it('białko jest wyższe na redukcji niż na kondycji', () => {
    const args = { kcal: 2400, weightKg: 80, heightCm: 180 }
    const cut = macros({ ...args, goal: 'cut' })
    const cond = macros({ ...args, goal: 'conditioning' })
    expect(cut.macros.proteinG).toBeGreaterThan(cond.macros.proteinG)
  })
})
