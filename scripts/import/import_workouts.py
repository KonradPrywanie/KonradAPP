# -*- coding: utf-8 -*-
"""Import planu treningowego z arkusza do `src/data/workouts.ts`.

    python scripts/import/import_workouts.py

Źródłem prawdy jest `data-source/Plan_Treningowy_FBW_Holistyczny_v5.xlsx` —
`src/data/workouts.ts` jest GENEROWANY i nie należy go edytować ręcznie.
Poprawka w arkuszu plus ponowne uruchomienie tego skryptu jest jedyną
przewidzianą drogą zmiany tych danych.

PRZEPISY MAJĄ WŁASNY IMPORTER: `scripts/import/import_recipes.py`, czytający
JSON-y z `data-source/`. Dwa źródła, dwa skrypty — bo dieta i trening zmieniają
się niezależnie i nie ma powodu, żeby poprawka w przepisie wymagała obecności
arkusza treningowego (ani odwrotnie).

Skrypt jest ostentacyjnie surowy: brakujący wzorzec ruchowy, nieznany zapis
serii albo pusta komórka przerywa import wyjątkiem. Cicha interpretacja
„jakoś to będzie" dałaby trening policzony z wartości, których nikt nie
zatwierdził.

Wymaga `openpyxl` (pip install openpyxl).
"""
from __future__ import annotations

import re
import sys
import unicodedata
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'data-source'
TRAINING_XLSX = SOURCE / 'Plan_Treningowy_FBW_Holistyczny_v5.xlsx'
WORKOUTS_TS = ROOT / 'src' / 'data' / 'workouts.ts'

# ─────────────────────────────────────────────────────────── narzędzia


class ImportError_(Exception):
    pass


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
    if isinstance(value, (int, float)):
        return repr(round(value, 3) if isinstance(value, float) else value)
    text = str(value)
    escaped = text.replace('\\', '\\\\').replace("'", "\\'").replace('\n', '\\n')
    return "'" + escaped + "'"


def ts_list(values) -> str:
    return '[' + ', '.join(ts(v) for v in values) + ']'


def cells(sheet):
    return [
        ['' if c is None else str(c).strip() for c in row]
        for row in sheet.iter_rows(values_only=True)
    ]


def header_index(rows, first_column: str = 'Lp.') -> int:
    """Wiersz nagłówków szukany po treści, nie po numerze.

    Arkusze mają nad tabelą tytuł, podtytuł i pusty wiersz odstępu — sztywny
    indeks przestałby działać po dodaniu jednej linijki w nagłówku.
    """
    for index, row in enumerate(rows):
        if row and row[0] == first_column:
            return index
    raise ImportError_(f'Nie znalazłem wiersza nagłówków (kolumna A = {first_column!r})')


# ──────────────────────────────────────────────────────────── przepisy

SLOT_BY_CATEGORY = {
    'Obiad': 'lunch',
    'Posiłek po pracy': 'afternoon',
    'Kolacja': 'dinner',
}

AMOUNT_PATTERNS = [
    # „150g", „30 g" — gramy wygrywają zawsze, także gdy stoją za sztukami
    # („2 duże szt 150g" to 150 g, nie dwie sztuki po 150 g).
    (re.compile(r'(?:^|\s)(\d+(?:[.,]\d+)?)\s*g\.?$'), 'g'),
    (re.compile(r'^(\d+(?:[.,]\d+)?)\s*ml\.?$'), 'ml'),
    (re.compile(r'^1/2\s*szt\.?$'), 'half'),
    (re.compile(r'^(\d+(?:[.,]\d+)?)\s*szt\.?$'), 'piece'),
    (re.compile(r'^(\d+(?:[.,]\d+)?)\s*(?:ząbki|ząbek|ząbka)$'), 'piece'),
]


def parse_sets_reps(text: str):
    compact = re.sub(r'\s+', ' ', text.strip())
    match = SETS_REPS.match(compact)
    if not match:
        raise ImportError_(f'Nieznany zapis serii: {text!r}')
    sets = int(match.group(1))
    sets_max = int(match.group(2)) if match.group(2) else sets
    reps = int(match.group(3))
    reps_max = int(match.group(4)) if match.group(4) else reps
    return sets, sets_max, reps, reps_max, bool(match.group(5))


def parse_rest(text: str) -> int:
    match = REST.match(re.sub(r'\s+', ' ', text.strip()))
    if not match:
        raise ImportError_(f'Nieznany zapis odpoczynku: {text!r}')
    return int(match.group(1))


def parse_weight(text: str):
    """Ciężar startowy w kg albo None, gdy arkusz nie podaje liczby wprost.

    None dostają: masa własnego ciała, „Gryf + …" (nie znamy masy gryfu
    konkretnej suwnicy) oraz asysta maszyny — tam większa liczba znaczy
    ŁATWIEJ, więc wpisanie jej jako obciążenia odwróciłoby progresję.
    """
    raw = re.sub(r'\s+', ' ', text.strip())

    # „Gryf + 5-10 kg" i „Asysta ok. 30-35 kg" MAJĄ liczbę, ale nie jest ona
    # obciążeniem: masa gryfu zależy od suwnicy, a asysta odejmuje ciężar
    # (więcej = łatwiej), więc progresja liczona z niej działałaby wstecz.
    if raw.lower().startswith('gryf') or 'asysta' in raw.lower():
        return None

    # Liczba wygrywa nad „lub masa rąk": jeśli arkusz podaje kilogramy, to jest
    # ciężar startowy, a wariant bez obciążenia zostaje w etykiecie.
    match = WEIGHT_RANGE.search(raw) or WEIGHT_SINGLE.search(raw)
    if match:
        return float(match.group(1).replace(',', '.'))

    if BODYWEIGHT.search(raw):
        return None
    return None


def parse_tempo(text: str):
    parts = [p.strip() for p in text.split('\n') if p.strip()]
    if not parts:
        raise ImportError_('Puste tempo')
    code = parts[0]
    if not re.match(r'^\d{4}$', code):
        raise ImportError_(f'Nieznany zapis tempa: {text!r}')
    note = parts[1].strip('()') if len(parts) > 1 else None
    return code, note


def bullets(text: str):
    return [re.sub(r'^[•\-\s]+', '', line).strip() for line in text.split('\n') if line.strip()]


def read_workout(sheet, letter: str):
    rows = cells(sheet)
    # „PLAN TRENINGOWY: TRENING A (FBW A)" → „Trening A (FBW A)". Tytuł arkusza
    # jest nagłówkiem dokumentu, a w aplikacji stoi w nazwie sesji na liście dnia.
    title = re.sub(r'^PLAN TRENINGOWY:\s*', '', rows[0][0]).strip()
    title = re.sub(r'^TRENING ([AB])\b', lambda m: f'Trening {m.group(1)}', title)
    focus = rows[1][0]
    head = header_index(rows)
    if rows[head][2] != 'Nazwa Ćwiczenia':
        raise ImportError_(f'{letter}: nieoczekiwane nagłówki {rows[head][:3]}')

    slots = []
    for row in rows[head + 1 :]:
        variant_label = row[1].strip()
        if variant_label not in ('GŁÓWNE', 'ALTERNATYWA 1', 'ALTERNATYWA 2'):
            continue

        name = row[2]
        if name not in PATTERNS:
            raise ImportError_(f'{letter}: brak wzorca ruchowego dla {name!r} — dopisz do PATTERNS')

        sets, sets_max, reps, reps_max, per_side = parse_sets_reps(row[8])
        tempo_code, tempo_note = parse_tempo(row[6])
        variant = {'GŁÓWNE': 'main', 'ALTERNATYWA 1': 'alt1', 'ALTERNATYWA 2': 'alt2'}[variant_label]

        if variant == 'main':
            slots.append({'index': len(slots) + 1, 'main': None, 'alternatives': []})
        if not slots:
            raise ImportError_(f'{letter}: alternatywa przed ćwiczeniem głównym')

        exercise = {
            'id': f'{letter.lower()}{slots[-1]["index"]}'
            + ('' if variant == 'main' else f'-{variant}')
            + f'-{slug(name, 28)}',
            'name': name,
            'pattern': PATTERNS[name],
            'variant': variant,
            'muscles': row[3],
            'description': row[4],
            'cues': bullets(row[5]),
            'tempo': tempo_code,
            'tempoNote': tempo_note,
            'restSec': parse_rest(row[7]),
            'restLabel': re.sub(r'\s+', ' ', row[7].strip()),
            'sets': sets,
            'setsMax': sets_max,
            'reps': reps,
            'repsMax': reps_max,
            'perSide': per_side,
            'startWeightKg': parse_weight(row[9]),
            'startWeightLabel': re.sub(r'\s+', ' ', row[9].strip()),
        }

        if variant == 'main':
            slots[-1]['main'] = exercise
        else:
            slots[-1]['alternatives'].append(exercise)

    if len(slots) != 5:
        raise ImportError_(f'{letter}: oczekiwano 5 ćwiczeń głównych, jest {len(slots)}')
    for s in slots:
        if len(s['alternatives']) != 2:
            raise ImportError_(f'{letter}: ćwiczenie {s["index"]} ma {len(s["alternatives"])} alternatyw')

    return {'id': letter, 'name': title, 'focus': focus, 'slots': slots}


def read_warmup(sheet):
    rows = cells(sheet)
    start = next(i for i, r in enumerate(rows) if r[0].strip() == 'Krok') + 1
    steps = []
    for row in rows[start:]:
        if not re.match(r'^\d+$', row[0].strip()):
            break
        steps.append(
            {
                'step': int(row[0]),
                'element': row[1],
                'name': row[2],
                'description': row[3],
                'duration': re.sub(r'\s*\n\s*', ' ', row[4]).strip(),
                'purpose': row[5],
            }
        )
    if not steps:
        raise ImportError_('Nie znalazłem kroków rozgrzewki')

    legend = []
    for row in rows:
        match = re.match(r'^(\d)\.\s*Cyfra', row[0].strip())
        if match:
            legend.append({'digit': int(match.group(1)), 'meaning': row[1]})
    if len(legend) != 4:
        raise ImportError_(f'Legenda tempa ma {len(legend)} pozycji, oczekiwano 4')

    return steps, legend


def exercise_ts(ex, indent: str, prefix: str = ''):
    lines = [indent + prefix + '{']
    inner = indent + '  '
    lines.append(f"{inner}id: {ts(ex['id'])},")
    lines.append(f"{inner}name: {ts(ex['name'])},")
    lines.append(f"{inner}pattern: {ts(ex['pattern'])},")
    lines.append(f"{inner}variant: {ts(ex['variant'])},")
    lines.append(f"{inner}muscles: {ts(ex['muscles'])},")
    lines.append(f"{inner}description: {ts(ex['description'])},")
    lines.append(f'{inner}cues: [')
    for cue in ex['cues']:
        lines.append(f'{inner}  {ts(cue)},')
    lines.append(f'{inner}],')
    lines.append(f"{inner}tempo: {ts(ex['tempo'])},")
    if ex['tempoNote']:
        lines.append(f"{inner}tempoNote: {ts(ex['tempoNote'])},")
    lines.append(f"{inner}restSec: {ex['restSec']},")
    lines.append(f"{inner}restLabel: {ts(ex['restLabel'])},")
    lines.append(f"{inner}sets: {ex['sets']},")
    lines.append(f"{inner}setsMax: {ex['setsMax']},")
    lines.append(f"{inner}reps: {ex['reps']},")
    lines.append(f"{inner}repsMax: {ex['repsMax']},")
    lines.append(f"{inner}perSide: {ts(ex['perSide'])},")
    lines.append(f"{inner}startWeightKg: {ts(ex['startWeightKg'])},")
    lines.append(f"{inner}startWeightLabel: {ts(ex['startWeightLabel'])},")
    lines.append(indent + '},')
    return lines


def write_workouts(workouts, warmup, legend):
    lines = [
        "import type { WarmupStep, Workout, WorkoutExercise, TempoDigit } from '@/domain/types'",
        '',
        '/**',
        ' * PLIK GENEROWANY — nie edytuj ręcznie.',
        ' *',
        f' * Źródło: `data-source/{TRAINING_XLSX.name}`',
        ' * Generator: `scripts/import/import_workbooks.py`',
        ' *',
        ' * Dwa treningi FBW (A i B) po pięć ćwiczeń, każde z dwiema alternatywami',
        ' * „na wypadek zajętej ławki", plus rozgrzewka i legenda tempa ruchu.',
        ' * Serie, powtórzenia, tempo, przerwy i ciężary startowe są WPROST',
        ' * z arkusza — aplikacja ich nie wymyśla i nie dobiera ćwiczeń sama.',
        ' */',
    ]

    for workout in workouts:
        const = f"WORKOUT_{workout['id']}"
        lines.append('')
        lines.append(f'export const {const}: Workout = {{')
        lines.append(f"  id: {ts(workout['id'])},")
        lines.append(f"  name: {ts(workout['name'])},")
        lines.append(f"  focus: {ts(workout['focus'])},")
        lines.append('  slots: [')
        for s in workout['slots']:
            lines.append('    {')
            lines.append(f"      index: {s['index']},")
            lines += exercise_ts(s['main'], '      ', 'main: ')
            lines.append('      alternatives: [')
            for alt in s['alternatives']:
                lines += exercise_ts(alt, '        ')
            lines.append('      ],')
            lines.append('    },')
        lines.append('  ],')
        lines.append('}')

    lines += [
        '',
        'export const WORKOUTS: readonly Workout[] = [WORKOUT_A, WORKOUT_B]',
        '',
        '/** Wszystkie ćwiczenia — główne i alternatywy — po identyfikatorze. */',
        'export const WORKOUT_EXERCISES_BY_ID: ReadonlyMap<string, WorkoutExercise> = new Map(',
        '  WORKOUTS.flatMap((workout) =>',
        '    workout.slots.flatMap((slot) => [slot.main, ...slot.alternatives]),',
        '  ).map((exercise) => [exercise.id, exercise]),',
        ')',
        '',
        '/** Rozgrzewka ogólna — ta sama przed treningiem A i B. */',
        'export const WARMUP: readonly WarmupStep[] = [',
    ]
    for step in warmup:
        lines.append('  {')
        lines.append(f"    step: {step['step']},")
        lines.append(f"    element: {ts(step['element'])},")
        lines.append(f"    name: {ts(step['name'])},")
        lines.append(f"    description: {ts(step['description'])},")
        lines.append(f"    duration: {ts(step['duration'])},")
        lines.append(f"    purpose: {ts(step['purpose'])},")
        lines.append('  },')
    lines += [
        ']',
        '',
        '/** Co znaczy każda cyfra w zapisie tempa (np. 3010). */',
        'export const TEMPO_LEGEND: readonly TempoDigit[] = [',
    ]
    for item in legend:
        lines.append(f"  {{ digit: {item['digit']}, meaning: {ts(item['meaning'])} }},")
    lines += [']', '']

    WORKOUTS_TS.write_text('\n'.join(lines), encoding='utf-8')


def main() -> int:
    if not TRAINING_XLSX.exists():
        print(f'Brak pliku źródłowego: {TRAINING_XLSX}', file=sys.stderr)
        return 1

    book = openpyxl.load_workbook(TRAINING_XLSX, data_only=True)
    workouts = [
        read_workout(book['Trening A (FBW A)'], 'A'),
        read_workout(book['Trening B (FBW B)'], 'B'),
    ]
    warmup, legend = read_warmup(book['Podsumowanie i Wytyczne'])
    write_workouts(workouts, warmup, legend)
    exercises = sum(1 + len(s['alternatives']) for w in workouts for s in w['slots'])
    print(
        f'{WORKOUTS_TS.relative_to(ROOT)}: {len(workouts)} treningi, {exercises} ćwiczeń, '
        f'{len(warmup)} kroki rozgrzewki'
    )
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except ImportError_ as error:
        print(f'IMPORT PRZERWANY: {error}', file=sys.stderr)
        sys.exit(2)
