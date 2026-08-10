/**
 * Podgląd wygenerowanego planu treningowego.
 *
 * Testy pilnują niezmienników (kontuzje, reguły kolizji, periodyzacja), ale nie
 * powiedzą, czy plan wygląda jak plan. To narzędzie do tego służy.
 *
 *   npx vite-node scripts/planReport.ts
 *   npx vite-node scripts/planReport.ts intermediate cut 1,2,4,5
 */
import { WORKOUTS, WORKOUT_EXERCISES_BY_ID } from '@/data/workouts'
import { DEFAULT_PLAN_WEEKS, generatePlan } from '@/domain/training/planGenerator'
import { isoWeekday } from '@/domain/dates'
import type {
  Experience,
  Goal,
  Profile,
  RunPayload,
  StrengthPayload,
  SwimPayload,
  TrainingEmphasis,
  Weekday,
} from '@/domain/types'
import { SWIM_STROKE_LABELS, WEEKDAY_LABELS } from '@/lib/labels'

const [expArg, goalArg, daysArg, emphasisArg, weeksArg] = process.argv.slice(2)
const experience = (expArg ?? 'intermediate') as Experience
const goal = (goalArg ?? 'cut') as Goal
const availableDays = (daysArg ?? '1,2,4,5')
  .split(',')
  .map((d) => Number(d.trim()) as Weekday)
const emphasis = (emphasisArg ?? 'balanced') as TrainingEmphasis
// Domyślnie tyle, ile buduje aplikacja. Dłuższy plan pokazuje deload.
const weeks = Number(weeksArg ?? DEFAULT_PLAN_WEEKS)

const now = new Date().toISOString()
const profile: Profile = {
  id: 'preview',
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  name: 'Podgląd',
  birthYear: 1996,
  sex: 'male',
  heightCm: 180,
  startWeightKg: 80,
  goal,
  activityLevel: 'moderate',
  experience,
  equipment: ['gym', 'dumbbells', 'home', 'running', 'pool'],
  availableDays,
  emphasis,
  sessionMinutes: 60,
  // Przykładowy punkt wyjścia: 5 km w tempie 6:30/km, 10 długości basenu 25 m.
  runBaseline: { distanceM: 5000, paceSecPerKm: 390 },
  swimBaseline: { laps: 10, poolLengthM: 25, stroke: 'breaststroke' },
  diet: { style: 'omnivore', allergens: [], dislikedTags: [], excludedProductIds: [] },
  cooking: { weekdayMinutes: 30, prepStyle: 'daily' },
  injuries: [],
  mealSplit: { lunch: 0.4, afternoon: 0.25, dinner: 0.35 },
  kcalOverride: null,
}

const plan = generatePlan({
  profile,
  // Sobota — pierwszy dzień tygodnia w tej aplikacji.
  startDate: '2026-08-01',
  workouts: WORKOUTS,
  weeks,
  seed: 'podglad',
})

console.log(
  `\nPlan: ${plan.weeks} tyg. | ${experience} | ${goal} | nacisk: ${emphasis} | ` +
    `dni: ${availableDays.map((d) => WEEKDAY_LABELS[d]).join(', ')}\n`,
)
if (plan.warnings.length > 0) {
  console.log('Ostrzeżenia:')
  for (const warning of plan.warnings) console.log(`  ! ${warning}`)
  console.log()
}

// Wszystkie tygodnie planu — przy dwóch domyślnych to całość, a na dłuższym
// podglądzie widać, czy periodyzacja faktycznie coś zmienia.
for (let weekIndex = 0; weekIndex < plan.weeks; weekIndex++) {
  const week = plan.sessions.filter((s) => s.weekIndex === weekIndex)
  const phase = week[0]?.phase ?? '?'
  const from = week[0]?.date ?? '?'
  const to = week.at(-1)?.date ?? '?'
  console.log(`── Tydzień ${weekIndex + 1} (${phase}) ${from} – ${to} ────────────────`)

  for (const session of week) {
    // Dzień tygodnia obok daty — tydzień zaczyna się w sobotę i to musi być
    // widać w podglądzie, inaczej kolejność wygląda na pomyłkę.
    const label = `${WEEKDAY_LABELS[isoWeekday(session.date)]} ${session.date.slice(8)}`.padEnd(7)

    if (session.payload.kind === 'strength') {
      const payload = session.payload as StrengthPayload
      console.log(
        `  ${label} TRENING ${payload.workoutId} (${payload.focus}) — ~${payload.estimatedMinutes} min`,
      )
      for (const exercise of payload.exercises) {
        const meta = WORKOUT_EXERCISES_BY_ID.get(exercise.exerciseId)
        const name = meta?.name ?? exercise.exerciseId
        const first = exercise.sets[0]
        const weight = first?.weightKg === null ? meta?.startWeightLabel ?? '—' : `${first?.weightKg} kg`
        console.log(
          `         ${name.slice(0, 34).padEnd(35)} ${exercise.sets.length}×${first?.reps}` +
            `${meta?.perSide ? '/str' : ''}  ${weight}  tempo ${meta?.tempo ?? '?'}  ` +
            `przerwa ${exercise.restSec}s`,
        )
      }
    } else if (session.payload.kind === 'run') {
      const p = session.payload as RunPayload
      const pace = `${Math.floor(p.targetPaceSecPerKm / 60)}:${String(p.targetPaceSecPerKm % 60).padStart(2, '0')}`
      console.log(
        `  ${label} BIEG  ${(p.distanceM / 1000).toFixed(1)} km @ ${pace}/km, strefa ${p.zone}` +
          `${p.intervals ? `  [${p.intervals}]` : ''}`,
      )
    } else if (session.payload.kind === 'swim') {
      const p = session.payload as SwimPayload
      const perSet = Math.round(p.distanceM / p.sets)
      console.log(
        `  ${label} PŁYWANIE  ${p.distanceM} m = ${p.sets}×${perSet} m, ` +
          `${SWIM_STROKE_LABELS[p.stroke].toLowerCase()}, przerwa ${p.restSec}s`,
      )
    } else {
      console.log(`  ${label} —`)
    }
  }
  console.log()
}
