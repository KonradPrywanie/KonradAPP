import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Strażnik rodzaju gramatycznego w interfejsie.
 *
 * FITKonrad wyrósł z FitPlannera, pisanego dla kobiety, i cały tekst został
 * przepisany na rodzaj męski/neutralny. PROGRESS odhaczył to jako zrobione —
 * a mimo to w kodzie zostało osiem miejsc z „zalogowałaś", „przeszłaś",
 * „zaznaczyłaś", „nie mierzyłam". Znalazły się dopiero przy przeglądzie, bo
 * pierwsze poprawki robiono klikaniem, a klikaniem nie da się przejść
 * wszystkich komunikatów: część pokazuje się tylko po zmianie profilu, część
 * przy dniu pod celem kalorycznym, część siedzi w komentarzach.
 *
 * Dlatego to jest TEST, a nie kolejny przegląd. Skanuje surowe źródła —
 * także komentarze, bo one też opisują tę aplikację i rozjeżdżają się tak samo.
 *
 * Gdyby aplikacja miała kiedyś obsługiwać obie płcie, ten test należy USUNĄĆ
 * razem z wprowadzeniem odmiany zależnej od profilu — nie obchodzić go
 * wyjątkami na pojedyncze pliki.
 */

/**
 * Końcówki jednoznacznie żeńskie: 1. i 2. osoba czasu przeszłego.
 *
 * Bez `\b` na końcu, bo w JavaScripcie granica słowa liczy się po ASCII —
 * po „ś" w „zalogowałaś." żadnej granicy nie ma i wzorzec by nie trafił.
 * Zamiast tego wprost wykluczamy kolejną literę, żeby „migdałami"
 * i „ziołami" (łam + i) nie były fałszywym trafieniem.
 */
const FEMININE = /[a-ząćęłńóśźż]+(?:łaś|łam|łabyś|łyśmy)(?![a-ząćęłńóśźż])/gi

const SRC = fileURLToPath(new URL('..', import.meta.url))

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) return []
    return [path]
  })
}

describe('rodzaj gramatyczny w tekstach', () => {
  it('KRYTYCZNE: nigdzie w źródłach nie ma form żeńskich', () => {
    const found: string[] = []
    for (const path of sourceFiles(SRC)) {
      const text = readFileSync(path, 'utf8')
      for (const match of text.matchAll(FEMININE)) {
        const line = text.slice(0, match.index).split('\n').length
        found.push(`${path.slice(SRC.length)}:${line} — ${match[0]}`)
      }
    }
    expect(found, `formy żeńskie:\n${found.join('\n')}`).toEqual([])
  })

  it('wzorzec faktycznie łapie to, po co powstał', () => {
    // Bez tego test wyżej przechodziłby także wtedy, gdyby wzorzec przestał
    // cokolwiek dopasowywać — a to jest jedyny powód jego istnienia.
    const hits = (text: string) => [...text.matchAll(FEMININE)].map((m) => m[0])
    expect(hits('bo już je zalogowałaś.')).toEqual(['zalogowałaś'])
    expect(hits('Ile metrów przeszłaś —')).toEqual(['przeszłaś'])
    expect(hits('znaczy „nie mierzyłam", a nie zero')).toEqual(['mierzyłam'])
    // I nie łapie słów, które tylko tak wyglądają.
    expect(hits('Kurczak z migdałami i ziołami, interwałami')).toEqual([])
    expect(hits('właśnie kłamie o ułamku')).toEqual([])
  })
})
