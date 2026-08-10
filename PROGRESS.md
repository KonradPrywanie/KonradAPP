# Stan realizacji

> Plan źródłowy: [PLAN.md](PLAN.md) · Zasady projektu: [README.md](README.md)
> Aktualizuj ten plik po każdej sesji pracy. Sekcja „Następny krok" to punkt wejścia.

**Ostatnia aktualizacja:** 2026-08-10
**Stan:** aplikacja jest używalna od początku do końca — ekran startowy → plan
treningowy → jadłospis → logowanie → progresja → zakupy → postępy → odnowienie planu.

FITKonrad wyrósł z [FitPlannera](../FitPlanner) i przejął po nim całą architekturę
oraz wszystkie ukończone fazy. Ten plik opisuje WYŁĄCZNIE to, co się od tamtego
projektu różni; historia sesji FitPlannera została z niego usunięta, żeby nie
udawać, że opisuje ten kod.

## Stan weryfikacji

| Sprawdzenie | Wynik |
|---|---|
| `npx tsc -b --force --noEmit` | ✅ bez błędów |
| `npm test` | ✅ **622/622 testy** w 17 plikach |
| `npm run build` | ✅ 5,1 s, precache 14 plików (1057 KiB) |
| `python scripts/import/import_recipes.py` | ✅ 167 przepisów, maks. odchylenie od celu slotu **1,3%** |
| Podgląd diety (`scripts/dietReport.ts`) | ✅ wszystkie dni w tolerancji, odchylenia < 1% |
| **Przejście przez aplikację w przeglądarce** | ✅ przy 2500 i przy 3000 kcal — patrz niżej |

Środowisko: Node 24.18.0, Python 3.9.

---

## Co się zmieniło względem FitPlannera

### 1. Dzień ma CZTERY posiłki, nie trzy

Śniadanie nie jest kosmetyką. Przy 2500–3000 kcal trzy posiłki oznaczają
800–1000 kcal na talerzu — porcje, których nikt nie zjada w tygodniu pracy.
Cztery schodzą do 560–765 kcal i dopiero wtedy gramatury z przepisu wyglądają
jak jedzenie, a nie jak wyzwanie.

Zmiana dotknęła: `MealSlot` i `MealSplit` (`domain/types.ts`), `MEAL_SLOTS`
i `slotKcalTargets` (`domain/diet/solver.ts`), `MEAL_SLOT_ORDER` (`db/dietRepo.ts`),
`MEAL_SLOT_LABELS` (`lib/labels.ts`), preset profilu i kreator.

Rezerwa na słodką przekąskę urosła ze 150 do **200 kcal** z tego samego powodu:
ma być tym samym UŁAMKIEM dnia, nie tą samą liczbą. Przy 1600 kcal 150 kcal to
9% dnia; przy 2750 to 5,5%, czyli już nie „kostka czekolady, która i tak się
zdarzy", tylko połowa tego, co się zdarza.

Rozkład: śniadanie 24%, obiad 30%, posiłek po pracy 22%, kolacja 24%
(`DEFAULT_MEAL_SPLIT`, jedno źródło dla presetu i kreatora).

### 2. Nowa baza: 167 przepisów liczonych ze składników

Arkusz trenera (`Przepisy_Dieta_1600_kcal_V3.xlsx`) został **usunięty** —
jego sufit to ~2100 kcal dziennie, więc pod 2500–3000 nie nadawał się do niczego.
Nowe źródło to `data-source/produkty.json` (149 produktów) plus cztery pliki
przepisów po ~42 pozycje na slot.

**Kierunek liczenia jest odwrócony i to jest decyzja, nie niedopatrzenie.**
FitPlanner brał makro wprost z arkusza i świadomie NIE MIAŁ bazy produktów —
istniało tam zewnętrzne źródło, którego druga metoda liczenia mogłaby się nie
trzymać. Tutaj takiego źródła nie ma, więc jedno wyliczenie ze składników jest
tańsze i pewniejsze: gramatura nie ma jak rozjechać się z kaloriami.

**Wielkość porcji dobiera importer.** Autor podaje proporcje, `fit_portion`
przemnaża ważone składniki przez jeden współczynnik i trafia w cel slotu.
Ręczne dostrajanie 167 przepisów do ±2% oznaczałoby, że każda poprawka składnika
wymaga przeliczenia całej pozycji od nowa.

### 3. Cel kaloryczny jest WYBIERANY

`KCAL_PRESETS = [2500, 3000]` — chipy na ekranie startowym i w edycji profilu,
oparte na istniejącym polu `kcalOverride`. Wyliczenie automatyczne zostaje
dostępne, ale nie jest domyślne: potrafi wypaść poza zakres bazy i wtedy
jadłospis nie trafia w cel.

Jedna baza obsługuje oba presety, bo skalowanie porcji rozszerzono z ±20% do
**±25%**. Przy 2500 kcal solver schodzi na ~0,90, przy 3000 wchodzi na ~1,10 —
oba w środku zakresu, więc żaden cel nie stoi na granicy, gdzie solver traci
swobodę i zaczyna powtarzać najcięższe dania.

### 4. Profil Konrada zamiast profilu Eweliny

Mężczyzna, cel „masa", nacisk równomierny, doświadczenie średniozaawansowane.
Ekran startowy pyta teraz także o **wzrost i rocznik** — wcześniej były
w presecie, a z nich liczy się masa odniesienia, a z niej białko i podłoga
tłuszczu. Preset, który je zgaduje, daje makra policzone dla nieistniejącej osoby.

Wykluczenia składników (`BANNED_INGREDIENT_TERMS`) są **puste**. FitPlanner miał
tu kalafior i zakaz wszystkich kasz poza pęczakiem; przeniesienie tego byłoby
przeniesieniem cudzego gustu. Mechanizm został, żeby dopisanie „tego nie jem"
było jedną linią.

Cały kod i interfejs przepisane z rodzaju żeńskiego na neutralny/męski.

### 5. Rzeczy, które przestały być potrzebne

- **Tabela ujednolicania nazw** (`domain/shopping/canonical.ts`) jest PUSTA.
  W FitPlannerze scalała ponad sto wariantów z ręcznie pisanego arkusza
  („Oliwa" / „Oliwa z oliwek"). Tutaj składnik musi być pozycją z zamkniętej
  tabeli produktów, więc warianty nie mają jak powstać. Mechanizm zostaje na
  dzień, w którym obok siebie staną „Ryż basmati" i „Ryż ugotowany" — bo wtedy
  trzeba będzie umieć powiedzieć, że to NIE jest to samo.
- **Filtr przypraw** nie ma nic do odsiania: przyprawy żyją w osobnym polu
  `spices`. Zostaje jako druga linia obrony — dopisanie „Sól morska" do tabeli
  produktów byłoby błędem widocznym dopiero po kilogramie soli na liście zakupów.

Oba fakty mają teraz testy, które PILNUJĄ założenia u źródła, zamiast sprawdzać
tabelę, której nie ma.

---

## Dopisane po pierwszym użyciu (2026-08-10)

Obie rzeczy wyszły z używania aplikacji, nie z planu — i obie dotyczą tego
samego: ekran pokazywał wszystko, co wie, zamiast tego, co jest teraz potrzebne.

### Wyszukiwarka w zamiennikach posiłku

`domain/diet/search.ts` + pole tekstowe w arkuszu „Zamień". Lista zamienników
świadomie pokazuje CAŁY katalog na dany slot (czterdzieści parę pozycji w pięciu
grupach), bo ranking odpowiada tylko na pytanie „co najlepiej trafia w makra",
a posiłek wybiera się też dlatego, że coś leży w lodówce. Cena tej decyzji była
taka, że do konkretnego dania trzeba było przewinąć wszystkie.

Szukamy w nazwie **i w składnikach** — „placki" to pytanie o danie, „kurczak"
o to, co trzeba zużyć. Bez polskich znaków (`normalize`, ta sama funkcja co
w wykluczeniach) i po fragmentach, więc odmiana nie ma znaczenia. Kilka słów
**zawęża** wynik: przy alternatywie dopisanie drugiego słowa dawałoby więcej
wyników niż jedno, czyli działałoby odwrotnie do intencji.

Zamknięcie arkusza czyści wpisany tekst. Komponent zostaje zamontowany, więc
bez tego następne otwarcie — także dla innego posiłku — pokazywałoby listę
przefiltrowaną poprzednim wpisem, a pole wyszukiwania byłoby wtedy poza ekranem.
Wygląda to jak pusty katalog, nie jak filtr.

### Lista zakupów bez tego, co już zjedzone

`withoutEatenMeals` w `domain/shopping/aggregate.ts`. Lista odpowiada na pytanie
„co jeszcze muszę kupić", a składniki obiadu zjedzonego w poniedziałek nie są już
odpowiedzią. Posiłek z wpisem w logu odejmuje SWOJE ilości od pozycji; pozycja,
z której nic nie zostało, znika. Ilości liczą się tą samą regułą, co przy
budowaniu listy — suma tego, co znane, więc zjedzenie jednego z dwóch dań nie
zamienia „400 g ryżu" w „do smaku".

**Zawężenie liczy się przy wyświetlaniu, nie przez przebudowę zapisanej listy.**
To jest sedno: „Cofnij" przy posiłku przywraca pozycje same z siebie, a przebudowa
gubiłaby przy okazji odhaczenia pozycji, które zdążyły z listy zniknąć. Zapisana
lista zostaje nietknięta — sprawdza to test.

Posiłek wskazuje para **data + przepis** (`sourceMealKey`), bo przepis należy do
jednego slotu, a slot w dniu jest zajęty najwyżej raz. Dzięki temu obiad gotowany
na zapas znika tylko z tego dnia, w którym go zjedzono, a nie z obu. Wchodzą
wyłącznie wpisy z `plannedMealId` — „zjadłem coś innego" nie ma prawa zdejmować
składników posiłku, którego nikt nie tknął.

Przełącznik „Pokaż całą listę" zostaje dla zakupów z wyprzedzeniem, a nagłówek
mówi, ile pozycji ukryto i dlaczego — pozycja znikająca po kliknięciu „Zjadłem"
na innym ekranie wygląda inaczej jak zgubiona.

### Dwa komunikaty opisywały FitPlannera, nie tę aplikację

Karta „jadłospis pod celem" ([DietDayPanel](src/features/diet/DietDayPanel.tsx))
i ostrzeżenie po wygenerowaniu tygodnia ([GenerateCards](src/features/shared/GenerateCards.tsx))
mówiły o bazie na **1600 kcal**, **trzech posiłkach** i skalowaniu **±20%** —
czyli o poprzednim projekcie. Pierwszy radził wprost „ustaw ręczny cel kaloryczny
1600 kcal w profilu", co przy tej bazie zepsułoby dietę. Teraz oba podają
prawdziwe liczby (2750 kcal, cztery posiłki plus rezerwa, ±25%, zakres
2110–3385 kcal) i odsyłają do presetów 2500/3000, pod które baza jest napisana.

Wniosek na przyszłość: przy forku najgroźniejsze są nie funkcje, tylko **teksty
tłumaczące, dlaczego coś działa tak, a nie inaczej**. Kod przestaje pasować
głośno (testy, typy), tekst — po cichu.

### Rodzaj żeński wrócił, więc pilnuje go teraz test

Poprzednia poprawka szła klikaniem, a klikaniem nie da się przejść wszystkich
komunikatów: część pokazuje się dopiero po zmianie profilu, część w dniu pod
celem kalorycznym, część siedzi w komentarzach. Zostało osiem miejsc —
„zalogowałaś" (×3), „przeszłaś", „zaznaczyłaś" w ostrzeżeniu generatora planu
i „nie mierzyłam" w dwóch komentarzach.

Wszystkie poprawione, a [`app/uiText.test.ts`](src/app/uiText.test.ts) skanuje
teraz surowe źródła w poszukiwaniu końcówek `łaś`/`łam`/`łabyś`/`łyśmy`. Drugi
test tego pliku sprawdza sam wzorzec — bez niego pierwszy przechodziłby także
wtedy, gdyby wzorzec przestał cokolwiek łapać. Uwaga na `\b`: w JavaScripcie
granica słowa liczy się po ASCII, więc po „ś" jej nie ma i „zalogowałaś."
nie zostałoby dopasowane.

### Zmierzona wydajność solvera (poprzednia liczba była nieprawdziwa)

Ten plik mówił „tydzień liczy się ~2 s na maszynie deweloperskiej". Pomiar:
**119 ms przy 2500 kcal, 123 ms przy 3000 kcal** (średnia z pięciu przebiegów),
zamienniki **6 ms** na 41 opcji. Nawet pięciokrotnie wolniejszy telefon zmieści
się w ćwierć sekundy — testu wydajności nie ma po co pisać, punkt wypada
z „Następnego kroku".

**Nieprzetestowane w przeglądarce:** panel podglądu w tym środowisku nie
kompozytuje klatek (zrzut ekranu nie działa), więc oba ekrany sprawdzają
wyłącznie testy montujące prawdziwy `App` na podstawionym IndexedDB. Aplikacja
wstaje bez błędów w konsoli.

---

## Znalezione i naprawione w trakcie budowy

- [x] **Tabela produktów nie sumowała się do własnych kalorii.** Wartości wprost
      z tabel żywieniowych nie spełniają równania 4/9/4, bo błonnik liczy się
      w węglowodanach, a daje ~2 kcal/g: brokuł podany jako 34 kcal wychodził
      z makra na 43, rozjazd sięgał **29%**. To byłoby widoczne w aplikacji —
      karta posiłku pokazuje kalorie I gramy makro obok siebie. Węglowodany są
      teraz wyliczane z kalorii (`(kcal − 4·B − 9·T) / 4`), czyli jako
      węglowodan przyswajalny; największy rozjazd spadł do **2,5%**.
- [x] **Dobieranie porcji schodziło do „oliwa z oliwek 2 g".** Arytmetycznie
      poprawne, kuchennie bezsensowne — dwa gramy nie pokrywają dna patelni.
      Doszło `minGram` w tabeli produktów, czyli najmniejsza ilość, jaką ma sens
      odmierzyć. Podłoga zabiera dopasowaniu swobodę i to jest w porządku:
      brakujące kalorie znajdą się na ryżu, nie na tłuszczu. Osobny test pilnuje,
      że w całej bazie nie ma gramatury poniżej 4 g.
- [x] **Zaokrąglanie do 5 g wywracało dopasowanie porcji.** Oliwa wyliczona na
      7 g schodziła do 5 i posiłek tracił 18 kcal — na jednym składniku tyle,
      ile wynosi cała dopuszczalna rozbieżność. Krok 1 g poniżej 25 g dotyczy
      dokładnie tych składników, które waży się na wadze kuchennej.
- [x] **Trzy pozycje lądowały w dziale „Inne" na liście zakupów** (rzodkiewka,
      winogrona, sok z limonki). Ostatnia pokazuje, dlaczego to jest test,
      a nie jednorazowy przegląd: reguła miała słowo `limonka`, a w przepisach
      stoi „Sok z limonki". Test wymaga teraz pokrycia **pełnego**, nie „poniżej
      10%" jak w FitPlannerze — przy zamkniętej tabeli produktów da się je mieć.
- [x] **Testy solvera mierzyły budżety, których aplikacja nigdy nie poda.**
      Stały tam liczby wpisane z ręki (1450 kcal, 116 g białka). Teraz cele liczą
      się tą samą drogą co w `dietRepo`: `macros()` z profilu minus rezerwa na
      przekąskę. Masa jest parametrem przypadku testowego, bo białko liczy się
      w g/kg — testowanie 2500 i 3000 kcal na jednej wadze mierzyłoby sytuację,
      która w praktyce nie występuje.
- [x] **Rodzaj żeński przeciekł do interfejsu** („opiera się na tym, co już
      zrobiłaś"). Złapane dopiero przy przejściu przez aplikację, nie przez testy.

## Zmierzone właściwości bazy

Dzień z bazy przy porcji ×1,0: **2550 kcal, 150 g białka, 66 g tłuszczu,
338 g węglowodanów** (plus przekąska 200 kcal → 2750 kcal).
Zakres przy skalowaniu 0,75–1,25: **2110–3385 kcal dziennie**.

Przejście przez aplikację w przeglądarce, świeży profil (86 kg, 182 cm, 1990):

| Cel | Suma dnia | Białko | Tłuszcz | Węgle |
|---|---|---|---|---|
| 2500 kcal | 2502 / 2500 | 150 / 151 | 70 / 69 | 318 / 319 |
| 3000 kcal | 2997 / 3000 | 151 / 151 | 83 / 83 | 411 / 412 |

Przełączenie presetu w Profilu przeliczyło jadłospis SAMO (`resyncFromDate`),
bez klikania „wygeneruj". Lista zakupów: 79 pozycji, wszystkie w swoich działach,
chleb przeliczony na kromki.

## Świadome ograniczenia bazy

- **Dieta wegańska nie ma rozwiązania** — wegańskich śniadań i obiadów nie ma
  ani jednego, więc solver zwraca `null` zamiast udawać, że coś ułożył.
- **Wegetariańska trafia w makra**, ale obiadów ma trzy na czterdzieści dwa,
  więc tydzień stoi na trzech obiadach zamiast siedmiu.
- **Laktoza plus gluten razem kasują cały slot śniadaniowy** — śniadania stoją
  na nabiale i pieczywie.

Wszystkie trzy mają testy. Rozbudowa bazy jest jedynym wyjściem; poluzowanie
filtrów nim NIE jest.

---

## Następny krok

Nic nie jest zablokowane — aplikacja działa. Do rozważenia, w kolejności wartości:

1. **Kopia zapasowa jest gotowa, przetestowana i NIEDOSTĘPNA.** `db/backup.ts`
   działa i ma 478 linii testów, ale karty nie renderuje nikt (`ProfileScreen`
   ma ją zakomentowaną — dziedziczone po FitPlannerze). Razem z nią niedostępny
   jest eksport CSV: `db/csvExport.ts` importuje wyłącznie ta karta. Przy
   magazynie wyłącznie lokalnym to największe pojedyncze ryzyko w projekcie,
   a przywrócenie to jedna linia.
2. **Disclaimer medyczny jest poza domyślną ścieżką.** Stoi w pełnym kreatorze
   (`/profil/kreator`), a nowy użytkownik trafia na `/start` (`QuickStartScreen`),
   gdzie go nie ma. PLAN §6 wymaga go „przy pierwszym uruchomieniu"; test
   sprawdza wersję, której nikt nie widzi.
3. **Śniadania bezmleczne i bezglutenowe** (po 5–6 pozycji). Dziś każda z tych
   dwóch nietolerancji osobno przechodzi, ale razem kasują cały slot.
4. **ESLint + `eslint-plugin-react-hooks`.** Projektu nie pilnuje żaden linter,
   a `tsc` nie widzi brakujących zależności efektu ani pływających promisów.
   To jedyna pozycja z tej listy, która zapobiega powstawaniu następnych —
   patrz rodzaj żeński, znaleziony dwa razy przeglądem, a nie narzędziem.
5. **Wegetariańskie obiady** — trzy na czterdzieści dwa to za mało, żeby ta
   ścieżka była użyteczna dłużej niż tydzień.
6. **Własne przepisy użytkownika.** Dziś każde odstępstwo od bazy jest wpisem
   ręcznym: nie wchodzi na listę zakupów i nie wraca następnym razem — a domowa
   kuchnia ma kilkanaście dań gotowanych co tydzień.
7. **„TDEE z danych" jest liczony i nieużywany.** Wisi w Profilu z podpisem
   „informacyjnie", choć powstaje z realnego trendu masy i realnych kalorii.
   Naturalny krok to cotygodniowe podsumowanie, które PROPONUJE korektę celu —
   nigdy nie robiąc jej samo, bo stabilny cel to zasada tego projektu.

Wypadło z listy: **test wydajności solvera** — pomiar pokazał 120 ms na tydzień,
nie 2 s (patrz wyżej). Nie ma tam problemu do pilnowania.
