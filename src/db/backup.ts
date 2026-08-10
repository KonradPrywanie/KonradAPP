import { db } from './db'

/**
 * Kopia zapasowa całej bazy.
 *
 * Local-first oznacza, że dane żyją wyłącznie w pamięci przeglądarki. Jedno
 * wyczyszczenie danych witryny albo zgubiony telefon kasuje historię, której
 * nie da się odtworzyć z niczego. To nie jest funkcja opcjonalna — to jedyne
 * realne zabezpieczenie, jakie ta architektura dopuszcza.
 *
 * Zrzut jest surowy: zawiera też rekordy usunięte miękko. Kopia ma odtworzyć
 * stan bazy, a nie stan widoku.
 */

export const BACKUP_FORMAT = 'fitkonrad-backup'
export const BACKUP_FORMAT_VERSION = 1

export interface BackupFile {
  format: typeof BACKUP_FORMAT
  /** Wersja formatu pliku kopii — niezależna od wersji schematu Dexie. */
  formatVersion: number
  /** Wersja schematu bazy, z której zrobiono zrzut. */
  schemaVersion: number
  exportedAt: string
  tables: Record<string, unknown[]>
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackupError'
  }
}

export async function exportBackup(now = new Date()): Promise<BackupFile> {
  const tables: Record<string, unknown[]> = {}
  for (const table of db.tables) {
    tables[table.name] = await table.toArray()
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    schemaVersion: db.verno,
    exportedAt: now.toISOString(),
    tables,
  }
}

export function backupFileName(now = new Date()): string {
  const date = now.toISOString().slice(0, 10)
  return `fitkonrad-kopia-${date}.json`
}

/**
 * Waliduje zawartość pliku, zanim dotknie bazy.
 *
 * Komunikaty są po polsku i konkretne, bo to jedyny moment, w którym
 * użytkownik może zorientować się, że wskazał zły plik — po nadpisaniu
 * bazy byłoby już za późno.
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('Plik nie jest poprawnym JSON-em.')
  }

  if (!isRecord(raw)) {
    throw new BackupError('Plik nie zawiera obiektu kopii zapasowej.')
  }
  if (raw['format'] !== BACKUP_FORMAT) {
    throw new BackupError('To nie jest kopia zapasowa FITKonrada.')
  }

  const formatVersion = raw['formatVersion']
  if (typeof formatVersion !== 'number' || formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `Kopia ma format w wersji ${String(formatVersion)}, a ta aplikacja obsługuje ` +
        `najwyżej ${BACKUP_FORMAT_VERSION}. Zaktualizuj aplikację.`,
    )
  }

  const schemaVersion = raw['schemaVersion']
  if (typeof schemaVersion !== 'number') {
    throw new BackupError('Kopia nie podaje wersji schematu bazy.')
  }
  if (schemaVersion > db.verno) {
    throw new BackupError(
      `Kopia pochodzi z nowszej wersji bazy (${schemaVersion} wobec ${db.verno}). ` +
        'Zaktualizuj aplikację przed przywróceniem.',
    )
  }

  const tables = raw['tables']
  if (!isRecord(tables)) {
    throw new BackupError('Kopia nie zawiera sekcji z tabelami.')
  }
  for (const [name, rows] of Object.entries(tables)) {
    if (!Array.isArray(rows)) {
      throw new BackupError(`Tabela „${name}" w kopii nie jest listą rekordów.`)
    }
  }

  return {
    format: BACKUP_FORMAT,
    formatVersion,
    schemaVersion,
    exportedAt: typeof raw['exportedAt'] === 'string' ? raw['exportedAt'] : '',
    tables: tables as Record<string, unknown[]>,
  }
}

export type ImportMode = 'replace' | 'merge'

export interface ImportResult {
  mode: ImportMode
  /** Liczba wczytanych rekordów per tabela. */
  imported: Record<string, number>
  /** Rekordy pominięte — bez `id` albo starsze od istniejących (tryb `merge`). */
  skipped: Record<string, number>
  warnings: string[]
}

/**
 * Przywraca kopię.
 *
 * `replace` czyści bazę i wczytuje zrzut — to zwykłe odtworzenie po awarii.
 * `merge` scala po `updatedAt`, zostawiając nowszą wersję rekordu. Ten drugi
 * tryb jest możliwy tylko dlatego, że schemat od początku ma UUID i `updatedAt`
 * (patrz PLAN.md §1) — bez tego scalanie dwóch urządzeń byłoby niewykonalne.
 */
export async function importBackup(
  backup: BackupFile,
  mode: ImportMode = 'replace',
): Promise<ImportResult> {
  const known = new Map(db.tables.map((table) => [table.name, table]))
  const imported: Record<string, number> = {}
  const skipped: Record<string, number> = {}
  const warnings: string[] = []

  for (const name of Object.keys(backup.tables)) {
    if (!known.has(name)) {
      warnings.push(`Tabela „${name}" z kopii nie istnieje w tej wersji aplikacji — pominięta.`)
    }
  }
  for (const name of known.keys()) {
    if (!(name in backup.tables)) {
      warnings.push(`Kopia nie zawiera tabeli „${name}" — pozostanie pusta.`)
    }
  }

  await db.transaction('rw', db.tables, async () => {
    if (mode === 'replace') {
      for (const table of db.tables) await table.clear()
    }

    for (const [name, rows] of Object.entries(backup.tables)) {
      const table = known.get(name)
      if (!table) continue

      let importedCount = 0
      let skippedCount = 0

      for (const row of rows) {
        if (!isRecord(row) || typeof row['id'] !== 'string') {
          skippedCount++
          continue
        }

        if (mode === 'merge') {
          const existing = await table.get(row['id'])
          if (existing && !isNewer(row, existing as Record<string, unknown>)) {
            skippedCount++
            continue
          }
        }

        await table.put(row)
        importedCount++
      }

      imported[name] = importedCount
      skipped[name] = skippedCount
    }
  })

  const skippedTotal = Object.values(skipped).reduce((sum, n) => sum + n, 0)
  if (mode === 'replace' && skippedTotal > 0) {
    warnings.push(`${skippedTotal} rekord(ów) pominięto — brak identyfikatora.`)
  }

  return { mode, imported, skipped, warnings }
}

/** Ile rekordów łącznie zawiera kopia — do pokazania przed przywróceniem. */
export function countRecords(backup: BackupFile): number {
  return Object.values(backup.tables).reduce((sum, rows) => sum + rows.length, 0)
}

function isNewer(incoming: Record<string, unknown>, existing: Record<string, unknown>): boolean {
  const a = incoming['updatedAt']
  const b = existing['updatedAt']
  if (typeof a !== 'string') return false
  if (typeof b !== 'string') return true
  return a > b
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
