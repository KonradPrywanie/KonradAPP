export type BmiCategory = 'underweight' | 'normal' | 'overweight' | 'obese'

export function bmi(weightKg: number, heightCm: number): number {
  if (weightKg <= 0 || heightCm <= 0) throw new RangeError('Waga i wzrost muszą być dodatnie')
  const heightM = heightCm / 100
  return round1(weightKg / (heightM * heightM))
}

export function bmiCategory(value: number): BmiCategory {
  if (value < 18.5) return 'underweight'
  if (value < 25) return 'normal'
  if (value < 30) return 'overweight'
  return 'obese'
}

export const BMI_CATEGORY_LABELS_PL: Record<BmiCategory, string> = {
  underweight: 'niedowaga',
  normal: 'waga prawidłowa',
  overweight: 'nadwaga',
  obese: 'otyłość',
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
