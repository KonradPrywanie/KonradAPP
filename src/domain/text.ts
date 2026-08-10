/**
 * Normalizacja tekstu dla dopasowań po nazwie.
 *
 * Osobny moduł, bo korzystają z niej i wykluczenia (`diet/eligibility`),
 * i wyliczanie alergenów (`diet/derive`), i kategorie dania oraz działy listy
 * zakupów. Trzymanie jej w którymkolwiek z nich robiło cykl importów.
 */

/** Usuwa polskie znaki diakrytyczne — użytkownik wpisze „brokuly" albo „brokuły". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll('ą', 'a')
    .replaceAll('ć', 'c')
    .replaceAll('ę', 'e')
    .replaceAll('ł', 'l')
    .replaceAll('ń', 'n')
    .replaceAll('ó', 'o')
    .replaceAll('ś', 's')
    .replaceAll('ź', 'z')
    .replaceAll('ż', 'z')
    .trim()
}
