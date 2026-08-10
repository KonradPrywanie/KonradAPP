/**
 * Paleta wykresów — zwalidowana narzędziem, nie dobrana na oko.
 *
 * Aplikacja ma wyłącznie tryb ciemny, a powierzchnia karty to `#1a2337`
 * (nie referencyjne `#1a1a19`), więc walidacja musiała pójść względem
 * WŁASNEGO tła. Wyniki (`validate_palette.js --mode dark --surface #1a2337`):
 *
 *  • `#3987e5` + `#d95926` + `#199e70` (serie kategorialne) — WSZYSTKIE KONTROLE
 *    PRZESZŁY dla trzech slotów: pasmo jasności, próg nasycenia, separacja CVD
 *    najgorszej pary ΔE 9,4 (deutan) / 32,4 (tritan), separacja dla widzenia
 *    prawidłowego ΔE 26,5, kontrast ≥ 3:1.
 *    Trzy sloty to sufit dla tej palety przy porównywaniu wszystkich par —
 *    czwarty postawiłby żółty obok pomarańczowego i para nie przechodzi progów.
 *
 *  • Akcent interfejsu `#38bdf8` ZOSTAŁ ODRZUCONY jako kolor serii — wypada
 *    z pasma jasności dla ciemnego tła (L 0,754 wobec zakresu 0,48–0,67).
 *    Zostaje wyłącznie dla chrome UI: przycisków, linków, aktywnych zakładek.
 *
 *  • `#898781` jako kolor kontekstu nie przechodzi progu nasycenia — i tak ma
 *    być, bo to celowo achromatyczny szary do wyróżnienia jednej serii
 *    („emphasis"): kontrola nasycenia dotyczy palet kategorialnych. Separacja
 *    od serii 1 (ΔE 15,9 / 11,5 CVD) i kontrast przechodzą.
 *
 *  • Statusy `#0ca30c` / `#fab219` / `#d03b3b` przechodzą kontrast na tym tle.
 *    `#fab219` wypada z pasma jasności, ale paleta statusów jest z definicji
 *    stała i nietematyzowana — dlatego statusy występują TYLKO z etykietą
 *    tekstową, nigdy jako sam kolor.
 *
 * Przy zmianie kolorów interfejsu trzeba walidator uruchomić ponownie.
 */
export const CHART = {
  /** Tło karty — pod przerwy między znacznikami i pierścienie punktów. */
  surface: '#1a2337',

  /** Slot 1: seria główna. */
  series1: '#3987e5',
  /** Slot 2: seria druga. */
  series2: '#d95926',
  /** Slot 3: seria trzecia. Zwalidowana razem z 1 i 2 na tym samym tle. */
  series3: '#199e70',
  /** Kontekst — dane drugoplanowe przy wyróżnieniu jednej serii. */
  context: '#898781',

  /** Siatka i osie: hairline, jeden stopień od tła, zawsze ciągłe. */
  grid: '#2f3d59',

  status: {
    done: '#0ca30c',
    partial: '#fab219',
    skipped: '#d03b3b',
  },
} as const

/** Wspólne właściwości osi — tekst nosi tokeny tekstu, nie kolor danych. */
export const AXIS_PROPS = {
  stroke: CHART.grid,
  tick: { fill: '#94a3b8', fontSize: 11 },
  tickLine: false,
} as const

/** `2026-08-05` → `5.08`. Oś musi być czytelna, nie kompletna. */
export function shortDate(isoDate: string): string {
  const [, month, day] = isoDate.split('-')
  return `${Number(day)}.${month}`
}
