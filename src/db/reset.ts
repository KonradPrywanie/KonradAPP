import { db } from './db'

/**
 * Wyczyszczenie wszystkich danych — start od zera.
 *
 * Tu ŚWIADOMIE usuwamy twardo, wbrew zasadzie „log jest append-only".
 * Ta zasada chroni historię od przypadkowej utraty przy zwykłej pracy
 * (regeneracja planu, poprawka wpisu). Reset jest czymś innym: użytkownik
 * jawnie żąda, żeby nic nie zostało. Usunięcie miękkie zostawiłoby setki
 * martwych rekordów, które nigdy już się nie pokażą, a bazę rozdmuchiwałyby
 * przy każdym kolejnym resecie.
 *
 * Operacja jest NIEODWRACALNA — wywołujący musi ją potwierdzić.
 */
export interface ResetResult {
  /** Ile rekordów usunięto, per tabela. */
  removed: Record<string, number>
  total: number
}

/** Klucze ustawień lokalnych czyszczone razem z bazą. */
const LOCAL_KEYS = ['fitkonrad.lastBackupAt']

export async function wipeAllData(): Promise<ResetResult> {
  const removed: Record<string, number> = {}

  await db.transaction('rw', db.tables, async () => {
    for (const table of db.tables) {
      removed[table.name] = await table.count()
      await table.clear()
    }
  })

  for (const key of LOCAL_KEYS) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* tryb prywatny — pomijamy */
    }
  }

  return {
    removed,
    total: Object.values(removed).reduce((sum, count) => sum + count, 0),
  }
}

/** Ile rekordów zniknie po resecie — do pokazania przed potwierdzeniem. */
export async function countAllRecords(): Promise<number> {
  let total = 0
  for (const table of db.tables) total += await table.count()
  return total
}
