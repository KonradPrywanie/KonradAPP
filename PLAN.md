# FITKonrad — plan implementacji (PWA)

> Dokument źródłowy planu. Stan realizacji: [PROGRESS.md](PROGRESS.md)
>
> **Plan jest ODZIEDZICZONY po FitPlannerze** i opisuje decyzje techniczne,
> które FITKonrad przejął bez zmian: platformę, bazę danych, routing, testy,
> podział na fazy. Wszystkie te fazy są ukończone.
>
> Czego ten plan NIE opisuje: rozkładu dnia na cztery posiłki, bazy przepisów
> pod 2500/3000 kcal ani liczenia makra ze składników. To są różnice tego
> projektu i mieszkają w [README.md](README.md) (zasady) oraz
> [PROGRESS.md](PROGRESS.md) (co i dlaczego zmieniono).

---

## 1. Decyzje techniczne (zamknięte)

| Obszar | Decyzja | Dlaczego |
|---|---|---|
| Platforma | **PWA** (Vite + React 19 + TypeScript) | Wybór użytkownika. Brak App Store, brak Maca, brak $99/rok, instalacja przez „Dodaj do ekranu głównego" |
| Styl | Tailwind CSS v4 | mobile-first, zero runtime |
| Baza danych | **IndexedDB przez Dexie 4** | patrz §2 |
| Reaktywność | `dexie-react-hooks` / `useLiveQuery` | baza jest źródłem prawdy, UI subskrybuje — brak duplikowania stanu |
| Routing | react-router 7 (hash-free, SPA fallback) | |
| Testy | Vitest | tylko warstwa `domain/` — tam gdzie błąd jest cichy |
| Wykresy | Recharts | |
| Service worker | `vite-plugin-pwa` (Workbox) | precache app-shell, offline-first |
| AI | **poza v1** | patrz §7 |

### Dlaczego Dexie/IndexedDB, a nie SQLite WASM

Rozważane było SQLite WASM + OPFS (prawdziwy SQL, łatwa późniejsza migracja do Postgresa). Odrzucone:

- oficjalny VFS OPFS wymaga nagłówków COOP/COEP na hostingu — komplikacja wdrożenia PWA,
- ~1 MB+ WASM w bundle,
- OPFS na iOS Safari jest młody (17+) i ma znane kwirki; IndexedDB działa tam od lat.

Wolumen danych jest mikroskopijny (~1 200 rekordów serii na cykl 12 tygodni, ~340 posiłków, ~250 produktów) — pełny silnik SQL to przerost. Zapytania „relacyjne" robimy w TS nad indeksowanymi kolekcjami.

**Ale schemat projektujemy pod przyszłą synchronizację** (koszt: pół dnia teraz, tydzień później):
- klucze główne = `crypto.randomUUID()`, nigdy autoincrement,
- `updatedAt` na każdej tabeli,
- usuwanie miękkie (`deletedAt`), nigdy `.delete()` na danych użytkownika,
- wersjonowane migracje Dexie od wersji 1.

Gdy przyjdzie sync → **Supabase** (Postgres, schemat 1:1), nie Firebase.

### Ograniczenia PWA, które trzeba przyjąć świadomie

1. **Powiadomienia z harmonogramem są niewykonalne bez serwera.** `Notification Triggers API` nie weszło do żadnej przeglądarki. Web Push (iOS 16.4+, tylko PWA dodana do ekranu głównego) wymaga serwera push z kluczami VAPID. Konsekwencja: **Etap 9 z wizji wypada z v1.** Zastępniki w v1: sekcja „Dziś" w dashboardzie + opcjonalny push z minimalnego workera (Faza 8).
2. **Trwałość danych.** Safari usuwa dane witryn nieużywanych 7 dni — instalacja PWA na ekran główny to wyłącza, ale zabezpieczamy się dodatkowo: `navigator.storage.persist()` przy pierwszym uruchomieniu + **twardy wymóg backupu JSON (Faza 7)**. Local-first = zgubiony telefon to utrata historii. To jedyne zabezpieczenie, jakie mamy.
3. **Brak Apple Health / Google Fit.** Native-only API. Ewentualnie ręczny import CSV.

---

## 2. Model danych — rozdzielenie planu od logu

Najważniejsza decyzja i najtrudniejsza do cofnięcia.

```
plan (mutowalny, wersjonowany)          log (append-only, nigdy nadpisywany)
────────────────────────────────        ──────────────────────────────────
trainingPlans                           sessionLogs      ← status done/partial/skipped
  └─ plannedSessions                      └─ setLogs     ← PER SERIA, nie per ćwiczenie
       payload: strength|run|swim         └─ cardioLogs

plannedMeals                            mealLogs         ← source: 'plan' | 'manual'
                                        weightEntries
```

**Zasady nienaruszalne:**
- Historia, statystyki, progresja i adaptacja czytają **wyłącznie z logu**.
- Regeneracja planu nigdy nie rusza logu.
- `setLogs` per seria — bez tego nie ma progresji ani objętości treningowej.
- `mealLogs.source='manual'` to obywatel pierwszej kategorii, nie wyjątek (patrz §4).

Pełne typy: `src/domain/types.ts`

---

## 3. Struktura katalogów

```
src/
├── domain/            # CZYSTY TypeScript — zero importów React i Dexie
│   ├── types.ts
│   ├── calc/          # BMI, BMR, TDEE, adaptacyjny TDEE, trend EWMA, makro
│   ├── training/      # generator planu, progresja, reguły kolizji
│   ├── diet/          # solver posiłków, skalowanie, zaokrąglanie porcji
│   └── shopping/      # konwersja jednostek, agregacja, opakowania
├── db/                # Dexie: schemat, migracje, repozytoria, seed
├── data/              # dane statyczne: produkty, przepisy, ćwiczenia
├── features/          # UI per funkcja (profile, dashboard, training, diet, ...)
├── app/               # shell, routing, providery
└── lib/               # utils
```

Warstwa `domain/` nie może importować niczego z `db/`, `features/`, `react`. To jedyna dyscyplina architektoniczna, jakiej pilnujemy — i jedyna, która się zwraca, bo umożliwia testy jednostkowe. **Clean Architecture / 4 warstwy: świadomie odrzucone** (przerost dla projektu jednoosobowego).

---

## 4. Zakres v1 — co jest rdzeniem, a co nie

Wizja opisywała generator planów. v1 celuje w **trenera**, więc rdzeń to logowanie rzeczywistości, nie generowanie:

**Rdzeń (bez tego aplikacja jest bezużyteczna po 4 dniach):**
- log treningu per seria + status `done/partial/skipped`
- log posiłku z planu **i log odstępstwa** (ręczne kcal/makro)
- zamienniki posiłków (1 klik → inny posiłek o zbliżonych makro)
- trend wagi EWMA (nie surowa waga)
- adaptacyjny TDEE z realnych danych

**Poza v1:** powiadomienia push, AI, sync, Apple Health, przepisy użytkownika.

---

## 5. Fazy

Kolejność zmieniona względem wizji: **największe ryzyko idzie pierwsze.** W oryginale silnik diety (najtrudniejszy element) był w połowie projektu — czyli dowód, że wizja jest wykonalna, przychodziłby w tygodniu 8.

### Faza 0 — Fundamenty
- scaffold Vite + React + TS + Tailwind + vite-plugin-pwa
- `domain/types.ts` — cały model danych
- Dexie schemat v1 + repozytoria + `navigator.storage.persist()`
- Vitest

### Faza 1 — Kalkulatory + profil
- `domain/calc`: BMI, BMR (Mifflin-St Jeor domyślnie, Katch-McArdle gdy znany %BF), TDEE, cel kaloryczny **z podłogami bezpieczeństwa**, rozkład makro, trend EWMA, adaptacyjny TDEE
- testy jednostkowe **wszystkich** wzorów
- kreator profilu — z polami, których nie da się dodać później bez przebudowy:
  wykluczenia żywieniowe (dieta/alergeny/nie lubię), kontuzje, czas na sesję, styl gotowania, data zawodów

### Faza 1.5 — SPIKE silnika diety (2–3 dni) ⚠ BRAMKA GO/NO-GO
25 produktów, 8 przepisów, wygenerować **jeden dzień**. Kryteria zaliczenia:
- kcal w ±5%, każde makro w ±10%
- gramatury zaokrąglone (10 g mięso/kasze, 5 g przyprawy/tłuszcze)
- składniki dyskretne w całościach (jajko = 1 szt., nigdy 0,7)
- posiłki wyglądają jak jedzenie, nie jak wynik solvera

Jeśli nie przejdzie — przeprojektowanie podejścia **w tygodniu 3, nie w 8**.

### Faza 2 — Silnik treningowy
- katalog ćwiczeń + filtr po sprzęcie **i kontuzjach**
- **mezocykle 3:1** (3 tyg. akumulacji + deload ~60% objętości) — nie progresja liniowa przez 12 tyg.
- **progresja z danych, nie z kalendarza**: wszystkie serie w górnym zakresie przy RPE ≤ 8 → +2,5 kg / +5%; inaczej → powtórz tydzień
- reguły kolizji dyscyplin (brak długiego biegu po dniu nóg, max 2 dni ciężkie z rzędu, min. 1 dzień odpoczynku)
- bieg (tempo/dystans/strefa tętna), pływanie (dystans/styl/serie) + substytuty przy braku sprzętu
- odnawianie planu w tyg. 13 z przeniesieniem osiągniętych ciężarów
- cel „przygotowanie do zawodów": plan liczony **wstecz od daty** + tapering w ostatnich 1–2 tyg.

### Faza 3 — Silnik diety (pełny)
- **150–250 ręcznie skuratorowanych produktów polskich + 60–80 przepisów.** Świadomie **nie** importujemy USDA FoodData Central (produkty amerykańskie) ani Open Food Facts (nierówna jakość + licencja bazy ODbL/share-alike). Baza po kodach kreskowych — ewentualnie później i tylko do *logowania*, nie do *generowania*
- solver: przepisy o skalowalnych porcjach, rozdzielenie składników skalowalnych od dyskretnych, tolerancje ±5%/±10%
- konfigurowalny rozkład kcal na posiłki (domyślnie 25/35/15/25%)
- zamienniki posiłków

### Faza 4 — Lista zakupów
- model jednostek z konwersją (g / ml / szt. / łyżka) + gęstości dla płynów
- agregacja tygodnia + **zaokrąglanie do opakowań handlowych** (nie 1,8 kg ryżu → 2 × 1 kg)
- przyprawy/sól → sekcja „zapas", nie lista główna

### Faza 5 — Dashboard + logowanie (rdzeń)
- „Dziś": trening, posiłki, pozostałe kcal, najbliższy trening
- oznaczanie treningu, log serii, **szybkie logowanie odstępstwa**
- cotygodniowa waga

### Faza 6 — Historia + statystyki
Etapy 7 i 8 z wizji to jedna rzecz: historia = dane, statystyki = widok.
- waga **z trendem**, BMI, kcal, objętość treningowa, dystanse
- kafel adaptacyjnego TDEE

### Faza 7 — PWA hardening + eksport
- offline, manifest, apple-touch-icon, prompt instalacji
- **backup/restore całej bazy do JSON** ← krytyczne, nie opcjonalne
- PDF (plan tygodnia, lista zakupów), CSV
- test na realnym iPhonie

### Faza 8 — Opcjonalnie
Sync (Supabase), push (worker z VAPID), AI.

---

## 6. Bezpieczeństwo i granice

Wbudowane w `domain/calc`, nie w UI:
- dolny limit kalorii: 1500 (M) / 1200 (K); ostrzeżenie gdy cel < BMR
- BMI < 18,5 + cel „redukcja" → deficyt **nie jest** stosowany, zwracane ostrzeżenie
- deficyt ograniczony do max 750 kcal/dzień
- disclaimer przy pierwszym uruchomieniu: to nie porada medyczna

## 7. AI — dopiero po v1, i z podziałem pracy

LLM jest dobry w *komponowaniu* posiłków i treningów, zły w *arytmetyce* na makrach. Więc: model proponuje skład → **kod deterministycznie liczy i koryguje gramatury**. Model nigdy nie zwraca liczby kalorii jako prawdy.

Klucz API w kliencie PWA jest jawny. Do użytku własnego — wystarczy `localStorage`. Do dystrybucji — konieczny proxy (Cloudflare Worker / Supabase Edge Function), czyli backend. Dlatego AI dopiero po v1.

---

## 8. Realny czas

Solo, po godzinach: **4–6 miesięcy** do wersji używanej codziennie. Sama Faza 3 to 4–6 tygodni. Oryginalny szacunek 8–14 tygodni dotyczyłby pełnego etatu bez przeszkód.
