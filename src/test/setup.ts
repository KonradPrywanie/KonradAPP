/**
 * Środowisko testowe dla warstwy bazy.
 *
 * `fake-indexeddb/auto` podstawia globalny `indexedDB`, więc Dexie działa
 * w Node bez przeglądarki. Testy warstwy `domain/` tego nie potrzebują, ale
 * import jest nieszkodliwy — plik setup wykonuje się raz na proces.
 */
import 'fake-indexeddb/auto'
