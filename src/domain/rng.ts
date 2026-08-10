/**
 * Deterministyczne losowanie.
 *
 * Generatory planów muszą być odtwarzalne: ten sam profil i ta sama data
 * zawsze dają ten sam jadłospis. Bez tego regeneracja tygodnia po drobnej
 * zmianie ustawień przetasowałaby wszystko, a testów nie da się napisać.
 * Dlatego nigdzie w `domain/` nie używamy `Math.random()`.
 */

/** FNV-1a, 32-bitowy. Zamienia ziarno tekstowe (np. datę) na liczbę. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Mulberry32 — mały, szybki PRNG o dobrym rozkładzie. Zwraca [0, 1). */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function rngFromSeed(seed: string): () => number {
  return mulberry32(hashString(seed))
}

/** Losowa liczba całkowita z [0, max). */
export function randomInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max)
}
