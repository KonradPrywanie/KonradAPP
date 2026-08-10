/**
 * Ustawienia lokalne urządzenia.
 *
 * Świadomie NIE trafiają do Dexie: data ostatniej kopii zapasowej dotyczy tego
 * konkretnego urządzenia i przeglądarki, a nie użytkownika. Gdyby siedziała
 * w bazie, przywrócenie kopii nadpisywałoby ją datą ze zrzutu — czyli
 * aplikacja twierdziłaby, że backup jest świeży, w chwili gdy właśnie nie jest.
 */

const KEYS = {
  lastBackupAt: 'fitkonrad.lastBackupAt',
} as const

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Tryb prywatny w niektórych przeglądarkach rzuca przy dostępie.
    return null
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* brak pamięci lub tryb prywatny — pomijamy w ciszy */
  }
}

export function getLastBackupAt(): string | null {
  return read(KEYS.lastBackupAt)
}

export function setLastBackupAt(timestamp: string): void {
  write(KEYS.lastBackupAt, timestamp)
}

/** Ile dni minęło od ostatniej kopii. Null, gdy nigdy jej nie zrobiono. */
export function daysSinceLastBackup(now = new Date()): number | null {
  const last = getLastBackupAt()
  if (!last) return null
  const then = Date.parse(last)
  if (Number.isNaN(then)) return null
  return Math.floor((now.getTime() - then) / 86_400_000)
}

/** Po tylu dniach przypominamy o kopii. */
export const BACKUP_REMINDER_DAYS = 14
