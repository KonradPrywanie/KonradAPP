/**
 * Trwałość danych w PWA.
 *
 * Safari usuwa dane witryn nieużywanych 7 dni. Instalacja na ekran główny to
 * wyłącza, ale nie polegamy na tym: prosimy o trwały magazyn i raportujemy
 * stan, żeby móc przypomnieć o backupie.
 *
 * To NIE jest substytut backupu. Local-first oznacza, że zgubiony telefon =
 * utrata historii. Eksport JSON (Faza 7) jest jedynym realnym zabezpieczeniem.
 */

export interface StorageStatus {
  /** Czy przeglądarka obiecuje nie usuwać danych bez zgody użytkownika. */
  persistent: boolean
  supported: boolean
  usageBytes?: number
  quotaBytes?: number
}

export async function requestPersistentStorage(): Promise<StorageStatus> {
  if (!('storage' in navigator) || typeof navigator.storage.persist !== 'function') {
    return { persistent: false, supported: false }
  }

  const alreadyPersisted = await navigator.storage.persisted()
  const persistent = alreadyPersisted || (await navigator.storage.persist())

  let usageBytes: number | undefined
  let quotaBytes: number | undefined
  if (typeof navigator.storage.estimate === 'function') {
    const estimate = await navigator.storage.estimate()
    usageBytes = estimate.usage
    quotaBytes = estimate.quota
  }

  return { persistent, supported: true, usageBytes, quotaBytes }
}
