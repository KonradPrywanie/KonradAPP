# FITKonrad

Osobisty trener i dietetyk jako PWA. Działa offline, dane trzyma lokalnie w IndexedDB.

Aplikacja wyrosła z [FitPlannera](../FitPlanner) i dzieli z nim architekturę,
silnik diety i plan treningowy. Różni się tym, po co powstała: **jadłospis jest
ułożony pod 2500 i 3000 kcal dziennie**, a nie pod 1600. To pociągnęło za sobą
cztery zmiany, które opisują ten projekt lepiej niż cokolwiek innego:

| | FitPlanner | FITKonrad |
|---|---|---|
| Rozkład dnia | 3 posiłki + przekąska | **4 posiłki + przekąska** (doszło śniadanie) |
| Baza przepisów | 150 z arkusza trenera | **167 z własnego źródła JSON** |
| Makro przepisu | podane w arkuszu | **liczone ze składników**, jedną drogą |
| Skalowanie porcji | ±20% | **±25%** — tyle trzeba, żeby jedna baza pokryła 2500 i 3000 |

- **Plan implementacji:** [PLAN.md](PLAN.md)
- **Stan realizacji:** [PROGRESS.md](PROGRESS.md)

## Dane: przepisy z JSON-a, treningi z arkusza

Źródłem prawdy są pliki w `data-source/`:

| Plik | Co zawiera |
|---|---|
| `produkty.json` | 149 produktów z wartościami odżywczymi na 100 g |
| `przepisy/sniadania.json` | 41 śniadań |
| `przepisy/obiady.json` | 42 obiady |
| `przepisy/po-pracy.json` | 42 posiłki po pracy |
| `przepisy/kolacje.json` | 42 kolacje |
| `Plan_Treningowy_FBW_Holistyczny_v5.xlsx` | Trening A i B (po 5 ćwiczeń z dwiema alternatywami), rozgrzewka, legenda tempa |

```bash
python scripts/import/import_recipes.py
```

```bash
python scripts/import/import_workouts.py
```

Generują `src/data/recipes.ts` i `src/data/workouts.ts` — **plików generowanych
nie edytuje się ręcznie**. Zmiana danych = poprawka w źródle i ponowny import.
Importer przepisów nie ma zależności spoza biblioteki standardowej; importer
treningów wymaga `openpyxl`.

**Dwa źródła, dwa skrypty**, bo dieta i trening zmieniają się niezależnie —
poprawka w przepisie nie ma powodu wymagać obecności arkusza treningowego.

### Skąd się biorą gramatury

Autor przepisu podaje PROPORCJE, a importer dobiera wielkość porcji tak, żeby
posiłek trafił w cel kaloryczny swojego slotu. To nie jest wygoda, tylko
warunek utrzymania bazy: ręczne dostrajanie 167 przepisów do ±2% oznaczałoby,
że każda zmiana składnika wymaga przeliczenia całej pozycji od nowa.

Skrypt przerywa pracę na wszystkim, co wygląda na pomyłkę: nieznany produkt,
powtórzona nazwa, porcja wymagająca skalowania spoza zakresu 0,6–1,6, trafienie
w cel gorsze niż 3%, mniej niż 40 przepisów w slocie.

## Wymagania

Node.js 20+ (LTS). Sprawdź: `node --version`.

## Uruchomienie

```bash
npm install
```

```bash
npm run dev
```

## Testy

```bash
npm test
```

Testowany jest przede wszystkim `src/domain/` — czysty TypeScript bez React
i bez Dexie. To jedyne miejsce, gdzie błąd byłby cichy: kalkulacja kalorii
i makro nie rzuci wyjątku, tylko po cichu poda złą liczbę.

Podgląd jadłospisu w konsoli — bo „posiłki wyglądają jak jedzenie, a nie jak
wynik solvera" nie da się sprawdzić asercją:

```bash
npx vite-node scripts/dietReport.ts 3000 bulk 95 182
```

## Struktura

```
src/
├── domain/     # czysty TS — zero importów React i Dexie, w pełni testowalny
│   ├── calc/   # BMI, BMR, TDEE, adaptacyjny TDEE, trend masy, makro
│   ├── diet/   # solver, skalowanie porcji, wykluczenia, wyliczanie alergenów
│   ├── dates.ts
│   └── types.ts
├── db/         # Dexie: schemat, migracje, repozytoria
├── data/       # GENEROWANE ze źródeł: przepisy, treningi + preset profilu
├── features/   # UI per funkcja
├── components/ # primitives UI
├── app/        # shell i routing
└── lib/        # etykiety, utils
```

## Zasady, które trzymają projekt w kupie

1. **`domain/` nie importuje niczego z `db/`, `features/` ani `react`.**
   Naruszenie tej zasady kończy testowalność silników.
2. **Plan jest mutowalny, log jest append-only.**
   Historia, statystyki i progresja czytają wyłącznie z logu. Regeneracja planu
   nigdy nie rusza logu.
3. **Dane użytkownika usuwamy tylko miękko** (`deletedAt`), klucze główne to UUID.
   Bez tego późniejsza synchronizacja jest przepisaniem warstwy danych.
4. **Granice bezpieczeństwa żyją w `domain/calc`, nie w UI.**
   Podłogi kaloryczne i limit deficytu obowiązują też przy ręcznym nadpisaniu.
5. **Zmiana schematu bazy = nowy blok `.version(n).stores(...)`.**
   Nigdy nie edytujemy wersji już wydanej — użytkownik ma ją w przeglądarce.
6. **Tydzień zaczyna się w SOBOTĘ** (`WEEK_START_DAY` w `domain/dates.ts`).
   Ten sam podział ma plan treningowy, jadłospis, lista zakupów i agregacje
   statystyk — dwie definicje tygodnia obok siebie rozjechałyby zakupy z planem.
   Do liczenia służą `startOfWeek` i `weekOrderIndex`, nigdy `dayOfWeek - 1`.
7. **Wyliczenia stoją na masie odniesienia z profilu, nie na ostatnim ważeniu.**
   Codzienne pomiary zasilają trend i wykresy. Gdyby zmieniały cel kaloryczny,
   jadłospis i lista zakupów ruszałyby się po każdym wejściu na wagę.
8. **Plan powstaje na dwa tygodnie i tylko z danych, które istnieją.** Bez punktu
   wyjścia w cardio (dystans i tempo biegu, długości basenu) plan się NIE tworzy —
   liczby z presetu wyglądają wiarygodnie i dotyczą kogoś innego. Ekran startowy
   pyta też o wzrost i rocznik: z nich liczy się masa odniesienia, a z niej
   białko i podłoga tłuszczu.
9. **Lista zakupów nie zawiera przypraw** — te są w karcie posiłku, przy instrukcji
   (`isSeasoning` w `domain/shopping/aggregate.ts`). W tej bazie przyprawy
   w ogóle nie są składnikami (`spices` to osobne pole), więc filtr nie ma nic
   do roboty i jest DRUGĄ linią obrony: dopisanie „Sól morska" do tabeli
   produktów byłoby błędem, którego nikt nie zauważy inaczej niż po kilogramie
   soli na liście zakupów. Składniki bez gramatury zostają na liście
   z adnotacją „do smaku"; **czosnek „do smaku" wypada**, a czosnek zważony
   zostaje, w warzywach.
10. **Nazwy składników są jednolite U ŹRÓDŁA, nie scalane po fakcie.**
    Składnik przepisu musi być pozycją z `produkty.json`, a importer przerywa
    pracę na nazwie spoza tej listy — więc „Oliwa" i „Oliwa z oliwek" nie mają
    jak powstać obok siebie. Tabela wariantów (`domain/shopping/canonical.ts`)
    jest z tego powodu PUSTA, a mechanizm zostaje na dzień, w którym w tabeli
    produktów staną obok siebie „Ryż basmati" i „Ryż ugotowany" — bo wtedy trzeba
    będzie umieć powiedzieć, że to NIE jest to samo (ugotowany waży prawie trzy
    razy tyle). Gdy grupy wrócą, mają być WYPISANE, nie wyliczone z morfologii.
11. **Tożsamość pozycji zakupowej to nazwa I JEDNOSTKA** (`shoppingItemKey`).
    Ten sam składnik potrafi stać na liście dwa razy w różnych jednostkach;
    klucz z samej nazwy odhaczał obie pozycje naraz.
12. **Zmiana jadłospisu przebudowuje listę zakupów SAMA**
    (`shoppingRepo.rebuildIfExists`, wołane po usunięciu, podmianie i wstawieniu
    posiłku). Lista jest materializowana, bo odhaczenia muszą przeżyć zamknięcie
    aplikacji — więc ktoś musi ją odświeżyć. Tylko gdy już istnieje: budowanie
    jej przy okazji edycji dnia byłoby zrobieniem czegoś, o co nikt nie prosił.
13. **Posiłku ZJEDZONEGO nie da się usunąć z planu** (`dietRepo.removeMeal`).
    Log jest nienaruszalny i wlicza się do bilansu dnia, więc skasowanie planu
    zostawiłoby kalorie bez pozycji, przy której je widać. Najpierw „Cofnij",
    potem „Usuń" — pilnuje tego repozytorium, nie tylko interfejs.
14. **Żaden przepis nie wraca przez MIESIĄC** — twardo, przez wykluczenie
    z listy opcji (`excludeRecipeIds`) w obrębie tygodnia, a `dietRepo` dokłada
    okno ±`DIET_HISTORY_WEEKS` w OBIE strony (`recentRecipeIds`) plus to, co
    w generowanym tygodniu już stoi. Samo „nie w tym tygodniu" nie wystarcza:
    tydzień 3 nie widzi tygodnia 1 i wraca do jego optimum, więc miesiąc wychodzi
    jako dwa tygodnie na przemian. Miękka kara w funkcji kosztu tego NIE załatwia:
    solver co dzień rozwiązuje to samo zadanie, więc bez zakazu wybiera to samo
    minimum. Każdy dzień ma drabinkę pięciu prób, od „nic się nie powtarza" do
    „makra ponad wszystko", i wygrywa PIERWSZA w tolerancji: bramką są makra,
    nie różnorodność. Stąd też minimum 40 przepisów na slot — miesiąc zużywa 28.
15. **Obiad powtarza się przez dwa kolejne dni** przy `cooking.prepStyle: 'batch'`
    (`solveWeek({ lunchBatchDays })`): ugotowane raz, zjedzone dwa razy. Pary liczą
    się od początku tygodnia (sob–nd, pon–wt, śr–czw), a powtarza się OBIAD, nie dzień —
    śniadanie, posiłek po pracy i kolacja dopasowują się do reszty budżetu.
16. **Dzień to CZTERY posiłki plus przekąska:** śniadanie, obiad, posiłek po
    pracy, słodka przekąska, kolacja. Solver układa cztery (`MEAL_SLOTS`),
    a przekąska ma odłożoną rezerwę 200 kcal (`domain/diet/sweetSnack.ts`)
    i jest wpisywana ręcznie. Rezerwę odejmuje `dietRepo`, w jednym miejscu —
    ekrany podają pełny cel dzienny.
    **Śniadanie jest tu różnicą wobec FitPlannera i nie jest kosmetyką:** przy
    2500–3000 kcal trzy posiłki oznaczają 800–1000 kcal na talerzu, czyli porcje,
    których nikt nie zjada w tygodniu pracy. Cztery schodzą do 560–765 kcal.
    Rezerwa na przekąskę urosła ze 150 do 200 z tego samego powodu: ma być tym
    samym UŁAMKIEM dnia, nie tą samą liczbą.
17. **Makro przepisu LICZY SIĘ ze składników** (`produkty.json` +
    `import_recipes.py`), jedną drogą. To odwrotnie niż w FitPlannerze — i to
    jest świadoma zmiana kierunku, nie niedopatrzenie. Tam istniał zewnętrzny
    arkusz z gotowym makrem, więc druga metoda liczenia dałaby dwie różne prawdy
    o tym samym obiedzie. Tutaj takiego arkusza nie ma, więc jedno wyliczenie
    jest tańsze i pewniejsze: zmiana gramatury nie ma jak rozjechać się
    z kaloriami. Skalowanie porcji przez solver mnoży makro i gramatury tym samym
    współczynnikiem, najwyżej ±25%.
18. **Węglowodany w tabeli produktów są WYLICZONE z kalorii**
    (`wegle = (kcal − 4·B − 9·T) / 4`). Wartości wprost z tabel żywieniowych tego
    równania nie spełniają, bo błonnik liczy się w węglowodanach, a daje około
    2 kcal na gram — brokuł podany jako 34 kcal wychodzi z makra na 43. Rozjazd
    sięgał 29% i byłby widoczny: karta posiłku pokazuje kalorie I gramy makro
    obok siebie. Kaloryczność zostaje ta z tabel (jest dokładniejsza),
    a węglowodany stają się resztą budżetu, czyli węglowodanem przyswajalnym.
19. **Najmniejsza sensowna ilość składnika jest DANĄ, nie regułą** (`minGram`
    w `produkty.json`). Bez niej dobieranie porcji schodziło do „oliwa z oliwek
    2 g" — liczby arytmetycznie poprawnej i nie do odmierzenia. Podłoga zabiera
    dopasowaniu trochę swobody i to jest w porządku: brakujące kalorie znajdą się
    na ryżu, nie na tłuszczu.
20. **Cel kaloryczny jest WYBIERANY, nie tylko wyliczany** (`KCAL_PRESETS`
    w `data/presetProfile.ts`). 2500 i 3000 to kaloryczności, pod które napisana
    jest baza; wyliczenie automatyczne zostaje dostępne, ale nie jest domyślne,
    bo potrafi wypaść poza zakres bazy (~2110–3385 kcal) i wtedy jadłospis nie
    trafia w cel. Aplikacja mówi o tym wprost (`belowTargetDays`).
21. **Wykluczenia składników (`BANNED_INGREDIENT_TERMS` w `lib/catalog.ts`)
    są PUSTE i to jest stan wyjściowy.** FitPlanner miał tu wykluczenia swojej
    użytkowniczki; przepisanie ich tutaj byłoby przeniesieniem cudzego gustu,
    a wykluczenie, o które nikt nie prosił, po cichu zwęża bazę. Mechanizm
    zostaje: dopisanie „tego nie jem" to jedna linia i obowiązuje NATYCHMIAST,
    także dla profilu już zapisanego w przeglądarce (wykluczenia w profilu
    dotyczą tylko nowo zakładanych).
22. **Dni treningowe są PODANE, nie wyliczone** (`FIXED_WEEK_LAYOUT` w
    `domain/training/schedule.ts`): poniedziałek bieg, wtorek i czwartek siłownia,
    sobota basen. Układ jest domyślnym argumentem `weeklySchedule` i obowiązuje
    tylko, gdy profil go uniesie. `weeklySchedule(profile, null)` wraca do
    rozstawiania sesji z dostępnych dni.
23. **„Dopisz kolejne 2 tygodnie" dopisuje do planu, nie tworzy nowego**
    (`planRepo.extendOrGenerate`). Numeracja tygodni musi być ciągła — na niej
    stoi progresja z logu i przełącznik tygodni.
24. **Dni siłowe to GOTOWE treningi z arkusza** (Trening A we wtorek, B w czwartek).
    Aplikacja nie dobiera ćwiczeń — odpowiada za kalendarz, ciężary z logu
    i podmianę na alternatywę. W zapisie trenera zmienia dokładnie dwie rzeczy,
    obie tylko w deloadzie: jedną serię mniej i 10% mniej ciężaru.
25. **Obniżkę deloadu liczy JEDNA funkcja** (`deloadWeight` w
    `domain/training/progression.ts`) i przechodzą przez nią wszystkie trzy drogi
    ustawiania obciążenia: budowanie sesji z arkusza, progresja z logu
    i aktualizacja tygodnia z historii. Gdy reguła żyła tylko w pierwszej z nich,
    dwie pozostałe wpisywały do deloadu pełny (a po progresji nawet wyższy)
    ciężar — „tydzień lżejszy" wychodził cięższy od poprzedniego. Obniżka
    zaokrągla W DÓŁ, bo do najbliższego kroku wracała na ciężar akumulacji.
26. **Instruktaże wideo są w `data/exerciseVideos.ts`** — pliku kuratorowanym
    ręcznie, poza generowanym `workouts.ts`, żeby ponowny import nie skasował
    linków. `exerciseVideo` bierze najpierw materiał z arkusza (gdy trener
    uzupełni kolumnę), potem kuratorowany, a na końcu ZAWSZE ma wyjście awaryjne:
    wyszukiwanie w YouTube po nazwie ćwiczenia. Przycisk nie ma prawa prowadzić
    w pustkę, także gdy konkretny film zniknie.
27. **Przypomnienia idą przez kalendarz telefonu, nie przez powiadomienia**
    (`domain/calendar/ics.ts`): PWA bez serwera nie obudzi się w sobotę o 9:00.
    Aplikacja generuje plik `.ics` — jedno wydarzenie z `RRULE` na 12 tygodni,
    czas zmiennoprzecinkowy (bez strefy), `UID` zależny od daty startu, żeby
    ponowny import nadpisywał serię, a nie dublował.
28. **Alergeny i styl diety są WYLICZANE z nazw składników** (`domain/diet/derive.ts`),
    bo źródło ich nie deklaruje. To filtr wygody, nie gwarancja medyczna — i tak
    jest opisany w interfejsie. Przy stylu diety wymagamy dowodu roślinności:
    wątpliwy przepis zostaje wszystkożerny.
29. **Każdy nieudany zapis musi to POWIEDZIEĆ.** `try/finally` bez `catch`
    zamienia awarię w ciszę, a cisza w tej aplikacji wygląda jak sukces —
    użytkownik wychodzi z siłowni przekonany, że trening jest w historii.
    Wzór: lokalny `error` w stanie + `Callout tone="warn"` przy przycisku.
30. **Granica błędu (`app/ErrorBoundary.tsx`) jest częścią umowy z użytkownikiem.**
    Dane są tylko w przeglądarce, więc biały ekran czyta się jak ich utrata.
    Ekran awaryjny mówi wprost, że dane są całe, pokazuje treść błędu i daje
    wyjście.
31. **Lista zakupów pokazuje to, czego JESZCZE nie zjadłeś**
    (`withoutEatenMeals` w `domain/shopping/aggregate.ts`). Zjedzenie posiłku
    odejmuje jego składniki od pozycji, a pozycję bez reszty zdejmuje z listy.
    Zawężenie liczy się przy WYŚWIETLANIU, nie przez przebudowę zapisanej listy —
    inaczej „Cofnij" nie miałby jak przywrócić pozycji, a przebudowa gubiłaby
    po drodze odhaczenia. Posiłek wskazuje para DATA + PRZEPIS (`sourceMealKey`),
    bo przepis należy do jednego slotu, a slot w dniu jest zajęty najwyżej raz;
    dzięki temu obiad gotowany na zapas znika tylko z dnia, w którym go zjedzono.
    Pozycje ze starych list (bez `sources`) zostają nietknięte — nie wiadomo,
    z czego się wzięły, więc ukrycie ich byłoby zgadywaniem.
32. **Zamienniki da się PRZESZUKAĆ** (`domain/diet/search.ts`). Lista pokazuje
    cały katalog na dany slot — czterdzieści parę pozycji — więc sama kolejność
    rankingowa nie wystarcza. Szukamy w nazwie dania I w składnikach, bez
    polskich znaków (`normalize`) i po fragmentach, a kilka słów ZAWĘŻA wynik
    (koniunkcja): przy alternatywie drugie słowo dawałoby więcej wyników niż
    pierwsze, czyli działałoby odwrotnie do tego, po co się je dopisuje.

## Świadome ograniczenia

- **Ścieżka roślinna jest cienka.** Wegańskich śniadań i obiadów nie ma w bazie
  ani jednego, więc dieta wegańska nie ma rozwiązania i solver zwraca `null`.
  Wegetariańska trafia w makra, ale obiadów ma trzy na czterdzieści dwa, więc
  tydzień stoi na trzech obiadach. Baza była pisana pod dietę mięsno-rybną przy
  2500–3000 kcal i to jest jej właściwość, nie błąd aplikacji — obie sytuacje
  mają testy, żeby nikt nie założył działania, którego nie ma.
- **Laktoza plus gluten razem kasują cały slot śniadaniowy.** Śniadania stoją
  na nabiale i pieczywie. Rozbudowa bazy jest jedynym wyjściem; poluzowanie
  filtra alergenów nim NIE jest.
- **Powiadomienia z harmonogramem są niewykonalne bez serwera.** `Notification Triggers API`
  nie weszło do przeglądarek, a Web Push wymaga serwera z kluczami VAPID.
- **Local-first = zgubiony telefon to utrata historii.** Eksport/import bazy do JSON
  jest jedynym realnym zabezpieczeniem, nie funkcją opcjonalną.
- **Brak Apple Health / Google Fit** — to API tylko dla aplikacji natywnych.
