import type { Macros } from '../types'

/**
 * Słodka przekąska jako stała pozycja budżetu.
 *
 * Dlaczego to istnieje: jadłospis rozpisany dokładnie na cel kaloryczny nie
 * zostawia miejsca na kostkę czekolady, a kostka czekolady i tak się zdarzy.
 * Efekt był zawsze ten sam — dzień „przekroczony", mimo że plan był wykonany
 * co do grama. Odłożenie budżetu z góry odwraca sytuację: przekąska jest
 * częścią planu, a nie jego złamaniem.
 *
 * Solver dostaje więc cel POMNIEJSZONY o tę rezerwę i układa z niego cztery
 * posiłki. Rezerwa nie jest planowana na konkretny produkt, bo nie da się
 * z góry powiedzieć, co to będzie — treść wpisuje użytkownik ręcznie.
 *
 * Rozkład makro rezerwy odpowiada typowej słodkiej przekąsce (czekolada,
 * ciastko): dużo tłuszczu, przewaga węglowodanów, białko śladowe.
 * 200 kcal, 3 g białka, 22 g węglowodanów i 11 g tłuszczu — czyli połowa tabliczki
 * gorzkiej albo dwa ciastka owsiane. Suma z makroskładników
 * (3 × 4 + 11 × 9 + 22 × 4 = 199 kcal) zgadza się z podaną kalorycznością,
 * więc rezerwa nie kłamie w żadną stronę.
 *
 * Dlaczego 200, a nie 150 jak w FitPlannerze: rezerwa ma być tym samym UŁAMKIEM
 * dnia, nie tą samą liczbą. Przy celu 1600 kcal 150 kcal to 9% dnia; przy 2750
 * te same 150 kcal to 5,5%, czyli już nie „kostka czekolady, która i tak się
 * zdarzy", tylko połowa tego, co się zdarza. Zaniżona rezerwa wraca jako
 * przekroczony bilans przy wykonanym planie — dokładnie to, czemu ma zapobiegać.
 *
 * Te 3 g białka są jedynym miejscem, w którym rezerwa dotyka białka. Zero byłoby
 * wygodniejsze, bo białko jest najtrudniejsze do trafienia — ale przy 3 g różnica
 * mieści się w zaokrągleniu porcji, więc zasada („nie odbieramy białka
 * zaplanowanym posiłkom") w praktyce dalej obowiązuje.
 */
export const SWEET_SNACK: Macros = {
  kcal: 200,
  proteinG: 3,
  fatG: 11,
  carbsG: 22,
}

export const SWEET_SNACK_LABEL = 'Słodka przekąska'

/**
 * Cel dla posiłków układanych przez solver: dzienny cel minus rezerwa.
 *
 * Nigdy nie schodzi poniżej zera — przy skrajnie niskim celu kalorycznym
 * lepiej mieć rezerwę zjadającą cały budżet niż ujemne makra, na których
 * funkcja kosztu solvera przestaje mieć sens.
 */
export function plannedMealTargets(dailyTargets: Macros): Macros {
  return {
    kcal: Math.max(0, dailyTargets.kcal - SWEET_SNACK.kcal),
    proteinG: Math.max(0, round1(dailyTargets.proteinG - SWEET_SNACK.proteinG)),
    fatG: Math.max(0, round1(dailyTargets.fatG - SWEET_SNACK.fatG)),
    carbsG: Math.max(0, round1(dailyTargets.carbsG - SWEET_SNACK.carbsG)),
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
