# -*- coding: utf-8 -*-
"""Import bazy przepisów z JSON-a do `src/data/recipes.ts`.

    python scripts/import/import_recipes.py

Źródłem prawdy są pliki w `data-source/`:

    produkty.json           — wartości odżywcze na 100 g
    przepisy/sniadania.json — skład, przyprawy, wykonanie
    przepisy/obiady.json
    przepisy/po-pracy.json
    przepisy/kolacje.json

`src/data/recipes.ts` jest GENEROWANY i nie należy go edytować ręcznie.
Poprawka w JSON-ie plus ponowne uruchomienie tego skryptu jest jedyną
przewidzianą drogą zmiany tych danych.

CO TEN SKRYPT ROBI POZA PRZEPISANIEM DANYCH — i dlaczego:

 1. **Liczy makro ze składników.** FitPlanner, z którego ta aplikacja wyrosła,
    brał makro wprost z arkusza trenera i świadomie NIE MIAŁ bazy produktów:
    drugie źródło dałoby dwie różne prawdy o tym samym obiedzie. Tutaj nie ma
    arkusza do uszanowania, więc jest odwrotnie — jedna droga liczenia, z której
    wynika, że gramatura i kalorie nie mogą się rozjechać.

 2. **Dobiera WIELKOŚĆ PORCJI pod cel slotu.** Autor przepisu podaje proporcje
    („kurczak, ryż, brokuł, oliwa" w rozsądnych ilościach), a skrypt przemnaża
    wszystkie ważone składniki przez jeden współczynnik tak, żeby posiłek trafił
    w cel kaloryczny swojego slotu. Ręczne dostrajanie 160 przepisów do
    ±2% dawało dwie złe rzeczy naraz: godziny arytmetyki i bazę, w której każda
    poprawka składnika wymaga przeliczenia całej pozycji od nowa.

    Współczynnik szukamy PRZEGLĄDEM SIATKI, nie dzieleniem. Ilości są zaokrąglane
    do 5 g (tyle da się odmierzyć w kuchni), a zaokrąglenie potrafi przesunąć
    posiłek o kilkanaście kilokalorii — więc „idealny" współczynnik policzony
    przed zaokrągleniem wcale nie jest najlepszy po nim.

 3. **Przerywa import na wszystkim, co wygląda na pomyłkę:** nieznany produkt,
    inna liczba przepisów niż zadeklarowana, powtórzony identyfikator, porcja
    wymagająca skalowania spoza rozsądnego zakresu, trafienie w cel gorsze niż
    3%. Cicha interpretacja dałaby jadłospis policzony z wartości, których nikt
    nie zatwierdził.

Nie wymaga żadnych zależności spoza biblioteki standardowej.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'data-source'
PRODUCTS_JSON = SOURCE / 'produkty.json'
RECIPES_DIR = SOURCE / 'przepisy'
RECIPES_TS = ROOT / 'src' / 'data' / 'recipes.ts'

#: Pliki źródłowe w kolejności dnia — jeden plik na slot.
#: Osobne pliki, nie jeden wielki: przy 160 przepisach plik na 4000 linii
#: przestaje być czytelny, a każdy slot i tak edytuje się osobno.
RECIPE_FILES = [
    ('breakfast', 'sniadania.json'),
    ('lunch', 'obiady.json'),
    ('afternoon', 'po-pracy.json'),
    ('dinner', 'kolacje.json'),
]

# ─────────────────────────────────────────── cele kaloryczne slotów

#: Kaloryczność, pod którą pisana jest baza — środek zakresu 2500–3000.
DESIGN_KCAL = 2750
#: Rezerwa na słodką przekąskę. MUSI zgadzać się z `SWEET_SNACK`.
SNACK_KCAL = 200

#: Rozkład na posiłki. MUSI zgadzać się z `DEFAULT_MEAL_SPLIT` w presetProfile.ts.
#: Pilnuje tego test `recipes.test.ts` — dwie kopie tych liczb bez testu
#: rozjechałyby się przy pierwszej korekcie, a rozjazd byłby niewidoczny:
#: przepisy nadal by się generowały, tylko celowałyby w inny talerz.
MEAL_SPLIT = {
    'breakfast': 0.24,
    'lunch': 0.30,
    'afternoon': 0.22,
    'dinner': 0.24,
}

SLOT_ORDER = ['breakfast', 'lunch', 'afternoon', 'dinner']
#: MINIMALNA liczba przepisów w slocie. Miesiąc bez powtórki zużywa 28
#: (obiad przy gotowaniu na zapas: 14), więc 40 zostawia zapas na wykluczenia
#: — bez zapasu solver wpada w awaryjny powrót do pełnej listy, czyli w to
#: samo, czemu wykluczenia mają zapobiegać. Więcej wolno, mniej nie.
MIN_RECIPES_PER_SLOT = 40

#: Zakres skalowania porcji przez solver — pole `minScale`/`maxScale` przepisu.
MIN_SCALE = 0.75
MAX_SCALE = 1.25

#: Krok zaokrąglania gramatur — 5 g jak `STEP` w `domain/diet/scaling.ts`,
#: ale dla małych ilości 1 g.
#:
#: Powód jest arytmetyczny, nie kosmetyczny: przy 5 g oliwa wyliczona na 7 g
#: schodzi do 5 i posiłek traci 18 kcal. Na jednym składniku to trzy procent
#: obiadu — czyli tyle, ile wynosi cała dopuszczalna rozbieżność. Krok 1 g
#: poniżej 25 g dotyczy dokładnie tych składników, które waży się na wadze
#: kuchennej (oliwa, orzechy, miód, pestki), i nie dotyka niczego, co odmierza
#: się na oko.
GRAM_STEP = 5
SMALL_AMOUNT_G = 25
SMALL_GRAM_STEP = 1
PIECE_STEP = 0.5

#: Granice, poza którymi import się przerywa.
MAX_DEVIATION_PCT = 3.0
MIN_PORTION_FACTOR = 0.60
MAX_PORTION_FACTOR = 1.60


class ImportError_(Exception):
    pass


def slot_target_kcal(slot: str) -> float:
    return (DESIGN_KCAL - SNACK_KCAL) * MEAL_SPLIT[slot]


# ─────────────────────────────────────────────────────────── narzędzia


def slug(text: str, limit: int = 40) -> str:
    ascii_text = unicodedata.normalize('NFKD', text.replace('ł', 'l').replace('Ł', 'L'))
    ascii_text = ascii_text.encode('ascii', 'ignore').decode('ascii').lower()
    out = re.sub(r'[^a-z0-9]+', '-', ascii_text).strip('-')
    return out[:limit].rstrip('-')


def ts(value) -> str:
    """Wartość jako literał TypeScriptu."""
    if value is None:
        return 'null'
    if isinstance(value, bool):
        return 'true' if value else 'false'
    if isinstance(value, int):
        return repr(value)
    if isinstance(value, float):
        rounded = round(value, 2)
        return repr(int(rounded)) if rounded == int(rounded) else repr(rounded)
    escaped = str(value).replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n')
    return "'" + escaped + "'"


def ts_list(values) -> str:
    return '[' + ', '.join(ts(v) for v in values) + ']'


def round_step(amount: float, step: float) -> float:
    """Zaokrągla w górę do kroku, nigdy poniżej jednego kroku.

    Odpowiednik `roundAmount` z `domain/diet/scaling.ts`. Ta sama reguła po obu
    stronach jest ważna: solver skaluje TE gramatury dalej, a dwie różne reguły
    zaokrąglania dałyby na ekranie ilość, której nie ma w żadnym z dwóch źródeł.
    """
    steps = round(amount / step)
    return round(max(1, steps) * step, 2)


# ───────────────────────────────────────────────────── wczytywanie


def load_products() -> dict:
    raw = json.loads(PRODUCTS_JSON.read_text(encoding='utf-8'))
    products = {}
    for item in raw['produkty']:
        name = item['nazwa']
        if name in products:
            raise ImportError_(f'Produkt powtórzony w tabeli: {name}')
        unit = item.get('jednostka', 'g')
        if unit not in ('g', 'ml', 'piece'):
            raise ImportError_(f'Nieznana jednostka produktu {name}: {unit}')
        if unit == 'piece' and 'gramyNaSztuke' not in item:
            raise ImportError_(f'Produkt na sztuki bez `gramyNaSztuke`: {name}')
        products[name] = {
            'name': name,
            'unit': unit,
            'per100': (item['kcal'], item['bialko'], item['tluszcz'], item['wegle']),
            'gramsPerPiece': item.get('gramyNaSztuke'),
            'minGram': item.get('minGram'),
        }
    return products


def load_recipes() -> list:
    """Wczytuje cztery pliki slotów w kolejności dnia.

    Slot bierze się z NAZWY PLIKU, nie z pola w rekordzie: pole dałoby się
    ustawić niezgodnie z plikiem, w którym przepis leży, i wtedy śniadanie
    wylądowałoby wśród kolacji bez żadnego sygnału.
    """
    out = []
    for slot, filename in RECIPE_FILES:
        path = RECIPES_DIR / filename
        if not path.exists():
            raise ImportError_(f'Brak pliku źródłowego: {path}')
        raw = json.loads(path.read_text(encoding='utf-8'))
        for recipe in raw['przepisy']:
            recipe['slot'] = slot
            out.append(recipe)
    return out


# ──────────────────────────────────────────────────────── liczenie


def macros_of(ingredients, products) -> tuple:
    """Suma makro dla listy składników `(nazwa, ilość)`.

    Składnik bez ilości („Czosnek", „Sok z cytryny") wnosi ZERO. To nie jest
    przeoczenie: przepis nie podaje ilości, więc każda liczba byłaby zmyślona,
    a zmyślona liczba w makrze jest gorsza niż jej brak — kalorie z niej wchodzą
    do bilansu dnia i nikt ich potem nie odróżni od zmierzonych.
    """
    kcal = protein = fat = carbs = 0.0
    for name, amount in ingredients:
        if amount is None:
            continue
        product = products[name]
        grams = amount * product['gramsPerPiece'] if product['unit'] == 'piece' else amount
        k, p, f, c = product['per100']
        factor = grams / 100.0
        kcal += k * factor
        protein += p * factor
        fat += f * factor
        carbs += c * factor
    return kcal, protein, fat, carbs


def apply_factor(ingredients, products, factor):
    """Skaluje ilości, zaokrąglając każdą do kroku jej jednostki.

    Sztuk NIE skalujemy: pół jajka jeszcze da się rozbić, ale 1,3 jajka już nie,
    a jajko w przepisie zwykle jest jego elementem konstrukcyjnym (omlet, panierka),
    nie wypełniaczem kalorii. Do dobierania porcji zostają więc gramy i mililitry,
    czyli i tak większość każdego przepisu.

    `minGram` z tabeli produktów jest PODŁOGĄ, nie sugestią. Bez niej dopasowanie
    porcji schodziło do „oliwa z oliwek 2 g" i „masło orzechowe 4 g" — liczb
    arytmetycznie poprawnych i kuchennie bezsensownych. Dwa gramy oliwy nie
    pokrywają dna patelni, a przepis, który każe je odmierzyć, przestaje być
    przepisem. Podłoga zabiera dopasowaniu trochę swobody i to jest w porządku:
    brakujące kalorie znajdą się na ryżu, nie na tłuszczu.
    """
    out = []
    for item in ingredients:
        name = item['produkt']
        amount = item.get('ilosc')
        if amount is None:
            out.append((name, None))
            continue
        product = products[name]
        if product['unit'] == 'piece':
            out.append((name, round_step(amount, PIECE_STEP)))
            continue
        scaled = amount * factor
        step = SMALL_GRAM_STEP if scaled < SMALL_AMOUNT_G else GRAM_STEP
        rounded = round_step(scaled, step)
        floor = product['minGram']
        out.append((name, max(rounded, floor) if floor is not None else rounded))
    return out


def fit_portion(recipe, products):
    """Dobiera współczynnik porcji tak, żeby posiłek trafił w cel swojego slotu.

    Przegląd siatki, nie dzielenie: zaokrąglanie do 5 g nie jest ciągłe, więc
    współczynnik policzony jako `cel / surowe kcal` po zaokrągleniu bywa gorszy
    od sąsiada oddalonego o 0,003. Przy remisie wygrywa współczynnik BLIŻSZY
    jedynki, żeby gramatury zostały jak najbliżej tego, co napisał autor.
    """
    target = slot_target_kcal(recipe['slot'])
    raw = macros_of([(i['produkt'], i.get('ilosc')) for i in recipe['skladniki']], products)
    if raw[0] <= 0:
        raise ImportError_(f"{recipe['nazwa']}: przepis bez kalorii — same składniki bez ilości?")

    seed = target / raw[0]
    best = None
    for step in range(-400, 401):
        factor = seed * (1 + step * 0.0015)
        if not (MIN_PORTION_FACTOR <= factor <= MAX_PORTION_FACTOR):
            continue
        scaled = apply_factor(recipe['skladniki'], products, factor)
        kcal = macros_of(scaled, products)[0]
        score = (abs(kcal - target), abs(factor - 1))
        if best is None or score < best[0]:
            best = (score, factor, scaled)

    if best is None:
        raise ImportError_(
            f"{recipe['nazwa']}: porcja wymaga współczynnika spoza zakresu "
            f'{MIN_PORTION_FACTOR}–{MAX_PORTION_FACTOR} (potrzebny ~{seed:.2f}). '
            'Popraw gramatury w źródle — skrypt dobiera wielkość porcji, nie skład.'
        )

    _, factor, scaled = best
    macros = macros_of(scaled, products)
    deviation = (macros[0] - target) / target * 100
    if abs(deviation) > MAX_DEVIATION_PCT:
        raise ImportError_(
            f"{recipe['nazwa']}: {macros[0]:.0f} kcal przy celu {target:.0f} "
            f'({deviation:+.1f}%). Przekroczony limit {MAX_DEVIATION_PCT}%.'
        )
    return factor, scaled, macros, deviation


def label_for(amount, unit) -> str | None:
    """Zapis ilości do pokazania — „1/2 szt", „1 1/2 szt", „150 g".

    UWAGA: na ekran trafia stąd TYLKO zapis dla ilości `None`.
    `formatIngredientAmount` (lib/format.ts) czyta `label` wyłącznie wtedy, gdy
    `amount === null` („2 ząbki", „do smaku") — przy podanej ilości formatuje
    liczbę sam, bo solver skaluje gramatury w locie i zapisana etykieta byłaby
    nieprawdziwa. Gałąź ułamkowa poniżej jest więc dla samego pliku danych,
    a nie dla interfejsu: aplikacja pokaże „0,5 szt", nie „1/2 szt", i tak ma
    być — pilnuje tego `format.test.ts`, a „0,5 kromki" obok trzyma tę samą
    konwencję. Pierwsze przepisy z połówką jajka (kuchnia azjatycka) pokazały,
    że te dwa opisy sobie przeczyły; prawdziwy jest ten z `format.ts`.
    """
    if amount is None:
        return None
    if unit != 'piece':
        return f'{amount:g} {unit}'
    whole = int(amount)
    half = abs(amount - whole - 0.5) < 1e-9
    if not half:
        return f'{whole} szt'
    return '1/2 szt' if whole == 0 else f'{whole} 1/2 szt'


# ───────────────────────────────────────────────────────── zapis TS

HEADER = """import type {{ Recipe }} from '@/domain/types'

/**
 * PLIK GENEROWANY — nie edytuj ręcznie.
 *
 * Źródło: `data-source/przepisy/*.json` + `data-source/produkty.json`
 * Generator: `scripts/import/import_recipes.py`
 *
 * Baza {total} przepisów: {counts}.
 *
 * MAKRO JEST LICZONE ZE SKŁADNIKÓW, jedną drogą, z tabeli wartości odżywczych
 * w `produkty.json`. To odwrotnie niż w FitPlannerze, gdzie makro było podane
 * w arkuszu trenera, a bazy produktów świadomie nie było — tam istniało
 * zewnętrzne źródło, którego druga metoda liczenia mogłaby się nie trzymać.
 * Tutaj takiego źródła nie ma, więc jedno wyliczenie jest tańsze i pewniejsze:
 * zmiana gramatury nie ma jak rozjechać się z kaloriami.
 *
 * WIELKOŚĆ PORCJI DOBIERA IMPORTER. Autor przepisu podaje proporcje, a skrypt
 * przemnaża ważone składniki przez jeden współczynnik, żeby posiłek trafił
 * w cel kaloryczny swojego slotu przy diecie {design} kcal:
 * {targets}.
 * Wszystkie {total} przepisów mieści się w ±{tol}% swojego celu.
 *
 * `minScale`/`maxScale` ({min_scale}–{max_scale}) to swoboda solvera: skaluje porcje
 * o najwyżej 25%, co pokrywa cały zakres od 2500 do 3000 kcal dziennie —
 * z zapasem po obu stronach, więc żaden cel nie stoi na granicy zakresu.
 */
export const RECIPES: Recipe[] = [
"""

FOOTER = """]

export const RECIPES_BY_ID: ReadonlyMap<string, Recipe> = new Map(
  RECIPES.map((r) => [r.id, r]),
)
"""


def write_recipes(rows) -> None:
    counts = {slot: sum(1 for r in rows if r['slot'] == slot) for slot in SLOT_ORDER}
    slot_names = {
        'breakfast': 'śniadań',
        'lunch': 'obiadów',
        'afternoon': 'posiłków po pracy',
        'dinner': 'kolacji',
    }
    slot_singular = {
        'breakfast': 'śniadanie',
        'lunch': 'obiad',
        'afternoon': 'posiłek po pracy',
        'dinner': 'kolacja',
    }
    header = HEADER.format(
        total=len(rows),
        counts=', '.join(f'{counts[s]} {slot_names[s]}' for s in SLOT_ORDER),
        design=DESIGN_KCAL,
        targets=', '.join(
            f'{slot_singular[s]} ~{slot_target_kcal(s):.0f} kcal' for s in SLOT_ORDER
        ),
        tol=int(MAX_DEVIATION_PCT),
        min_scale=str(MIN_SCALE).replace('.', ','),
        max_scale=str(MAX_SCALE).replace('.', ','),
    )

    out = [header]
    for row in rows:
        out.append('  {\n')
        out.append(f"    id: {ts(row['id'])},\n")
        out.append(f"    name: {ts(row['name'])},\n")
        out.append(f"    slot: {ts(row['slot'])},\n")
        out.append('    ingredients: [\n')
        for ing in row['ingredients']:
            parts = [
                f"name: {ts(ing['name'])}",
                f"amount: {ts(ing['amount'])}",
                f"unit: {ts(ing['unit'])}",
            ]
            if ing['label'] is not None:
                parts.append(f"label: {ts(ing['label'])}")
            out.append('      { ' + ', '.join(parts) + ' },\n')
        out.append('    ],\n')
        out.append(f"    spices: {ts_list(row['spices'])},\n")
        out.append('    steps: [\n')
        for step in row['steps']:
            out.append(f'      {ts(step)},\n')
        out.append('    ],\n')
        out.append(f"    prepMinutes: {ts(row['prepMinutes'])},\n")
        if row.get('prepNote'):
            out.append(f"    prepNote: {ts(row['prepNote'])},\n")
        m = row['macros']
        out.append(
            '    macros: { '
            f"kcal: {ts(m[0])}, proteinG: {ts(m[1])}, fatG: {ts(m[2])}, carbsG: {ts(m[3])}"
            ' },\n'
        )
        out.append(f'    minScale: {ts(MIN_SCALE)},\n')
        out.append(f'    maxScale: {ts(MAX_SCALE)},\n')
        out.append('  },\n')
    out.append(FOOTER)

    RECIPES_TS.write_text(''.join(out), encoding='utf-8')


# ─────────────────────────────────────────────────────────── główna


def main() -> int:
    if not PRODUCTS_JSON.exists():
        print(f'Brak pliku źródłowego: {PRODUCTS_JSON}', file=sys.stderr)
        return 1

    products = load_products()
    source = load_recipes()

    seen_ids = set()
    seen_names = set()
    rows = []
    stats = {slot: [] for slot in SLOT_ORDER}

    for index, recipe in enumerate(source, start=1):
        name = recipe['nazwa']
        slot = recipe['slot']
        if slot not in MEAL_SPLIT:
            raise ImportError_(f'{name}: nieznany slot „{slot}"')
        if name in seen_names:
            raise ImportError_(f'Nazwa przepisu powtórzona: {name}')
        seen_names.add(name)

        for ing in recipe['skladniki']:
            if ing['produkt'] not in products:
                missing = ing['produkt']
                raise ImportError_(f'{name}: produkt „{missing}" nie istnieje w produkty.json')

        prefix = {'breakfast': 'b', 'lunch': 'l', 'afternoon': 'a', 'dinner': 'd'}[slot]
        recipe_id = f'{prefix}{index:03d}-{slug(name, 36)}'
        if recipe_id in seen_ids:
            raise ImportError_(f'Identyfikator powtórzony: {recipe_id}')
        seen_ids.add(recipe_id)

        factor, scaled, macros, deviation = fit_portion(recipe, products)

        ingredients = []
        for ing_name, amount in scaled:
            unit = products[ing_name]['unit']
            ingredients.append(
                {
                    'name': ing_name,
                    'amount': amount,
                    'unit': unit,
                    'label': label_for(amount, unit),
                }
            )

        rows.append(
            {
                'id': recipe_id,
                'name': name,
                'slot': slot,
                'ingredients': ingredients,
                'spices': recipe.get('przyprawy', []),
                'steps': recipe['wykonanie'],
                'prepMinutes': recipe['czasMin'],
                'prepNote': recipe.get('uwagaCzasowa'),
                'macros': (
                    round(macros[0]),
                    round(macros[1], 1),
                    round(macros[2], 1),
                    round(macros[3], 1),
                ),
            }
        )
        stats[slot].append((macros, deviation, factor))

    for slot in SLOT_ORDER:
        count = len(stats[slot])
        if count < MIN_RECIPES_PER_SLOT:
            raise ImportError_(
                f'Slot {slot}: {count} przepisów, minimum to {MIN_RECIPES_PER_SLOT}. '
                'Dolna granica jest twarda, bo od niej zależy miesiąc bez powtórki.'
            )

    write_recipes(rows)

    print(f'{RECIPES_TS.relative_to(ROOT)}: {len(rows)} przepisów\n')
    print(f'{"slot":<12}{"cel":>6}{"śr. kcal":>10}{"P":>7}{"F":>7}{"C":>7}{"maks. odch.":>13}')
    day = [0.0, 0.0, 0.0, 0.0]
    for slot in SLOT_ORDER:
        entries = stats[slot]
        n = len(entries)
        avg = [sum(e[0][i] for e in entries) / n for i in range(4)]
        worst = max(abs(e[1]) for e in entries)
        for i in range(4):
            day[i] += avg[i]
        print(
            f'{slot:<12}{slot_target_kcal(slot):>6.0f}{avg[0]:>10.0f}'
            f'{avg[1]:>7.1f}{avg[2]:>7.1f}{avg[3]:>7.1f}{worst:>12.1f}%'
        )
    print(
        f'\nDzień z przepisów (bez przekąski): {day[0]:.0f} kcal, '
        f'B {day[1]:.0f} g, T {day[2]:.0f} g, W {day[3]:.0f} g'
    )
    print(
        f'Z przekąską ({SNACK_KCAL} kcal): {day[0] + SNACK_KCAL:.0f} kcal '
        f'przy celu projektowym {DESIGN_KCAL} kcal'
    )
    print(
        f'Zakres bazy przy skalowaniu {MIN_SCALE}–{MAX_SCALE}: '
        f'{day[0] * MIN_SCALE + SNACK_KCAL:.0f}–{day[0] * MAX_SCALE + SNACK_KCAL:.0f} kcal'
    )
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ImportError_ as error:
        print(f'IMPORT PRZERWANY: {error}', file=sys.stderr)
        sys.exit(2)
