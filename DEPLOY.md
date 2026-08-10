# Wdrożenie na Render i aktualizacje

Render nadaje się tu dobrze. FITKonrad jest aplikacją **statyczną** — cała logika
działa w przeglądarce, dane siedzą w IndexedDB, nie ma backendu ani bazy po stronie
serwera. Wystarczy serwis *Static Site*: **bezpłatny** i, co najważniejsze, **po HTTPS**.

HTTPS jest warunkiem koniecznym, nie wygodą: bez niego przeglądarka nie zarejestruje
service workera, więc na iPhonie nie zadziała ani tryb offline, ani instalacja PWA na
ekranie głównym. Dev server po LAN pokaże układ, ale tych dwóch rzeczy nie sprawdzi.

**Stan przygotowania** (sprawdzone 2026-08-10):

| | |
|---|---|
| `render.yaml` | ✅ gotowy blueprint |
| `package-lock.json` spójny z `package.json` | ✅ `npm ci` przejdzie |
| Binarki dla Linuksa w lockfile | ✅ esbuild, rollup, tailwind-oxide, lightningcss |
| Sekrety w repozytorium | ✅ brak — aplikacja nie ma kluczy API |
| Tożsamość Gita | ✅ ustawiona **lokalnie w repo** (nie globalnie) |
| Repozytorium Gita | ✅ gałąź `main`, pierwszy commit |
| Zdalne `origin` | ✅ `https://github.com/KonradPrywanie/KonradAPP.git` |
| Wypchnięte na GitHub | ⬜ czeka na `git push -u origin main` |
| Wdrożenie na Renderze | ⬜ blueprint trzeba wskazać na TO repozytorium |

> **Uwaga na `KonradPrywanie/APKA`.** Ten adres należy do FitPlannera, projektu,
> z którego FITKonrad wyrósł. Ta wersja dokumentu (i cała reszta katalogu)
> została po nim odziedziczona i do 2026-08-10 twierdziła, że repozytorium
> istnieje i jest wypchnięte — a w tym katalogu nie było nawet `.git`.
> FITKonrad jedzie do **osobnego** repozytorium `KonradPrywanie/KonradAPP`
> i nie ma z APKA wspólnej historii.

**Kolejne wersje publikuje się jednym poleceniem** — patrz „Aktualizacje" niżej.
Kroki 1–3 poniżej to pierwsze uruchomienie; zostają jako instrukcja na wypadek
odtwarzania wdrożenia od zera.

---

## Co już jest zrobione

Repozytorium jest zainicjowane i zacommitowane, zdalne `origin` wskazuje na
`KonradPrywanie/KonradAPP`. Tożsamość ustawiono **lokalnie w tym repo**,
nie globalnie:

```
Konrad Karabacz <konrad.karabacz@gmail.com>
```

Powód lokalnego zakresu: to maszyna z adresem służbowym, a prywatny adres nie
powinien wchodzić do firmowych repozytoriów. Konsekwencja: przy każdym **nowym**
prywatnym repozytorium na tym komputerze trzeba powtórzyć te dwie linie:

```bash
git config user.name "Konrad Karabacz" && git config user.email "konrad.karabacz@gmail.com"
```

Adres w commitach jest widoczny publicznie, jeśli repozytorium będzie publiczne.
Gdybyś nie chciał pokazywać prywatnego, GitHub daje zamiennik
`ID+login@users.noreply.github.com` (Settings → Emails).

Do repozytorium NIE weszły: `node_modules/`, `dist/`, `dev-dist/`,
`*.tsbuildinfo` ani `__pycache__/` z importerów. Doszedł `.gitattributes`
normalizujący końce linii do LF —
bez niego Render (Linux) widziałby inne bajty niż maszyna lokalna i diffy
pokazywałyby zmiany w plikach, których nikt nie ruszał.

## Krok 1 — wypchnij na GitHub

Repozytorium `KonradPrywanie/KonradAPP` musi istnieć i być **puste** — bez README
i bez .gitignore, inaczej push się odbije (wtedy: `git pull --rebase origin main`
i push jeszcze raz).

```bash
cd "C:\AI\Claude\FITKonrad" && git push -u origin main
```

Przy pierwszym pushu Git poprosi o zalogowanie do GitHuba (okno przeglądarki
albo token). Zdalne `origin` jest już skonfigurowane.

## Krok 2 — Render

1. [dashboard.render.com](https://dashboard.render.com) → **New** → **Blueprint**.
2. Wskaż repozytorium. Render odczyta `render.yaml` i sam ustawi: serwis statyczny,
   `npm ci && npm run build`, katalog `dist`, przepisanie `/*` → `/index.html`,
   nagłówki cache i automatyczne wdrażanie.
3. **Apply**. Pierwszy build ok. 2–3 minuty.
4. Dostaniesz adres w rodzaju `https://fitkonrad.onrender.com`.

Jeśli build padnie na wersji Node, w ustawieniach serwisu dodaj zmienną
`NODE_VERSION` = `22`. Plik `.node-version` prosi o Node 24 (na nim projekt jest
budowany lokalnie), ale aplikacja działa też na 22.

Bez blueprintu: **New → Static Site**, ręcznie `npm ci && npm run build` i `dist`,
a potem **koniecznie** reguła *Rewrite* `/*` → `/index.html` w zakładce
Redirects/Rewrites. Bez niej wejście wprost na `/postepy` zwróci 404.

## Krok 3 — instalacja na iPhonie

1. Otwórz adres w **Safari** — na iOS tylko Safari instaluje PWA.
2. **Udostępnij** → **Dodaj do ekranu głównego**.
3. Uruchom z ikony: powinno otworzyć się bez paska adresu.
4. Test offline: tryb samolotowy i ponowne uruchomienie z ikony.

---

## Aktualizacje — publikowanie nowych wersji

To jest cała procedura. Adres się nie zmienia, więc każdy, kto ma link, dostaje
nową wersję.

```bash
cd "C:\AI\Claude\FITKonrad" && git add -A && git commit -m "opis zmiany" && git push
```

Render sam wykryje push, przebuduje i podmieni wersję. Postęp widać w zakładce
**Events** serwisu.

**Zanim wypchniesz — sprawdź build produkcyjny lokalnie.** Zajmuje kilkanaście
sekund i wyłapuje rzeczy, których dev server nie pokazuje:

```bash
npm --prefix "C:\AI\Claude\FITKonrad" run build && npm --prefix "C:\AI\Claude\FITKonrad" run preview
```

Warto też przed każdym pushem uruchomić testy — 624 sztuki idą w ok. 17 sekund:

```bash
npm --prefix "C:\AI\Claude\FITKonrad" test
```

### Jak aktualizacja dociera do zainstalowanej PWA

Service worker jest w trybie `autoUpdate`, a `sw.js` ma wyłączony cache, więc
przeglądarka sprawdza nową wersję przy każdym otwarciu. W praktyce: **pierwsze
otwarcie po wdrożeniu może jeszcze pokazać starą wersję**, nowa wchodzi przy
następnym. To normalne zachowanie service workera, nie błąd — nowa wersja pobiera
się w tle, a przejmuje kontrolę po przeładowaniu.

Jeśli chcesz wymusić od razu: zamknij aplikację całkowicie (przesuń w górę
w przełączniku aplikacji) i otwórz ponownie.

### Cofnięcie nieudanej wersji

Render trzyma historię wdrożeń. W zakładce **Events** wybierz starsze wdrożenie
i **Redeploy** — nie trzeba niczego cofać w Gicie.

---

## O czym warto wiedzieć

**Adres jest publiczny.** Każdy, kto zna link, otworzy aplikację — ale zobaczy pustą
bazę i własny kreator, bo dane nie opuszczają urządzenia. Nie ma kont ani serwera,
więc nie ma czego wyciec. Zamknięcie dostępu hasłem jest u Rendera funkcją płatną.

**Dane są per przeglądarka, nie per konto.** Profil z iPhone'a nie pojawi się na
komputerze i odwrotnie. To konsekwencja architektury local-first, nie błąd.

**Aktualizacja kodu NIE usuwa danych.** IndexedDB przeżywa wdrożenie. Jedyny
wyjątek to zmiana schematu bazy bez migracji — dlatego każda zmiana struktury
wymaga nowego bloku `.version(n).stores(...)` w `src/db/db.ts`, nigdy edycji
wersji już wydanej. To ważne teraz podwójnie: kopia zapasowa jest ukryta
w interfejsie, a w aplikacji jest przycisk czyszczenia danych — nieudana migracja
nie miałaby z czego się odtworzyć.

**Kopia zapasowa jest ukryta, nie usunięta.** Kod eksportu i importu JSON żyje
w `src/db/backup.ts` i `src/features/backup/BackupCard.tsx` wraz z 34 testami.
Przywrócenie karty to dodanie jednej linii `<BackupCard />` w `ProfileScreen.tsx`.

**Darmowy plan** dla serwisów statycznych nie usypia (to dotyczy tylko serwisów
z własnym serwerem), więc aplikacja odpowiada od razu.
