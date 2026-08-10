import { useState } from 'react'
import { Link } from 'react-router'
import type { Macros, Profile } from '@/domain/types'
import { DEFAULT_PLAN_WEEKS, type PlanTimeline } from '@/domain/training/planGenerator'
import {
  missingPlanInputs,
  PLAN_INPUT_GAP_LABELS,
  type PlanInputGap,
} from '@/domain/training/planInputs'
import { startOfWeek, todayIso } from '@/domain/dates'
import { planRepo, type ExtendedPlanResult } from '@/db/planRepo'
import { dietRepo, type GenerateWeekResult } from '@/db/dietRepo'
import { shoppingRepo } from '@/db/shoppingRepo'
import {
  formatDateLong,
  formatDistance,
  formatPace,
  sessionsLabel,
  weeksLabel,
} from '@/lib/format'
import { Button, Callout, Card, SectionTitle } from '@/components/ui'

/**
 * Generowanie jest jawną akcją użytkownika, nie efektem ubocznym wejścia
 * na ekran. Powód: generator zwraca ostrzeżenia (brak sprzętu na jakiś
 * wzorzec ruchowy, dni bez rozwiązania w diecie) i te ostrzeżenia trzeba
 * pokazać w momencie, w którym użytkownik ich oczekuje.
 */

function usePlanGeneration(profile: Profile) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ExtendedPlanResult | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setFailed(null)
    try {
      /**
       * DOPISUJE dwa tygodnie, których jeszcze nie ma — nie zaczyna planu od nowa.
       * Każde kolejne kliknięcie dokłada następne dwa, więc plan rośnie zamiast
       * podmieniać te same tygodnie. Nowy plan powstaje tylko wtedy, gdy nie ma
       * do czego dopisać (patrz `extendOrGenerate`).
       */
      setResult(await planRepo.extendOrGenerate(profile, todayIso()))
    } catch (cause) {
      // Bramka danych wejściowych rzuca wyjątek — patrz `MissingPlanInputsError`.
      setFailed(cause instanceof Error ? cause.message : 'Nie udało się wygenerować planu.')
    } finally {
      setBusy(false)
    }
  }

  return { busy, result, failed, generate }
}

/**
 * Brak punktu wyjścia w cardio — plan się nie utworzy.
 *
 * Karta ZASTĘPUJE przycisk generowania, nie stoi obok niego: przycisk, który
 * zawsze skończy się odmową, jest gorszy od jego braku. Prowadzimy prosto tam,
 * gdzie te dane się uzupełnia.
 */
function MissingInputsCard({ gaps }: { gaps: PlanInputGap[] }) {
  return (
    <Card>
      <SectionTitle hint="Plan bez tych liczb stanąłby na presecie dla przeciętnej początkującej — wyglądałby wiarygodnie i dotyczyłby kogoś innego.">
        Brakuje danych do planu
      </SectionTitle>
      <Callout tone="warn" title="Uzupełnij w profilu">
        <ul className="list-disc pl-4">
          {gaps.map((gap) => (
            <li key={gap}>{PLAN_INPUT_GAP_LABELS[gap]}</li>
          ))}
        </ul>
      </Callout>
      <div className="mt-3">
        <Link to="/profil" className="block">
          <Button className="w-full">Przejdź do profilu</Button>
        </Link>
      </div>
    </Card>
  )
}

export function PlanSetupCard({ profile }: { profile: Profile }) {
  const { busy, result, failed, generate } = usePlanGeneration(profile)
  const gaps = missingPlanInputs(profile)

  if (gaps.length > 0) return <MissingInputsCard gaps={gaps} />

  return (
    <Card>
      <SectionTitle hint="Plan powstaje na dwa tygodnie do przodu i opiera się na tym, co już zrobiłeś: ciężary i dystanse biorą się z Twoich sesji, nie z założeń. Rytm bloków 3 + 1 (trzy tygodnie narastającej objętości, czwarty to deload) biegnie dalej przy każdym odnowieniu.">
        Brak planu treningowego
      </SectionTitle>
      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? 'Generowanie…' : `Wygeneruj plan na ${weeksLabel(DEFAULT_PLAN_WEEKS)}`}
      </Button>
      <GenerationNotes result={result} failed={failed} />
    </Card>
  )
}

/**
 * Odnowienie planu po ostatnim tygodniu.
 *
 * Bez tego plan kończył się w ciszy: sesji nie było, a ekran nie mówił,
 * dlaczego i co dalej. Nowy plan przenosi osiągnięte ciężary z logu, więc
 * odnowienie nie cofa dorobku.
 */
export function PlanRenewalCard({
  profile,
  timeline,
}: {
  profile: Profile
  timeline: PlanTimeline
}) {
  const { busy, result, failed, generate } = usePlanGeneration(profile)
  const gaps = missingPlanInputs(profile)
  const copy = renewalCopy(timeline)

  if (gaps.length > 0) return <MissingInputsCard gaps={gaps} />

  return (
    <Card>
      <SectionTitle hint={copy.hint}>{copy.title}</SectionTitle>

      <Button
        variant={timeline.isFinished ? 'primary' : 'ghost'}
        onClick={generate}
        disabled={busy}
        className="w-full"
      >
        {busy ? 'Generowanie…' : copy.action}
      </Button>

      <GenerationNotes result={result} failed={failed} />
    </Card>
  )
}

/**
 * Trzy sytuacje: plan wyczerpany, ostatni tydzień, środek planu.
 *
 * Wszystkie trzy mają TĘ SAMĄ akcję — dopisanie kolejnych dwóch tygodni.
 * Nazwa mówi „dopisz", bo tak to teraz działa: tygodnie doklejają się na końcu
 * planu, a każde kolejne kliknięcie dokłada następne dwa. Dotychczasowe
 * tygodnie zostają na miejscu wraz z logami — nic nie jest archiwizowane ani
 * podmieniane. Ciężary, dystanse i pozycja w cyklu przechodzą z tego, co
 * zostało zrobione.
 */
function renewalCopy(timeline: PlanTimeline): { title: string; hint: string; action: string } {
  const action = `Dopisz kolejne ${weeksLabel(DEFAULT_PLAN_WEEKS)}`
  const carryOver =
    'Dopisane tygodnie startują od tego, co faktycznie zrobiłeś: cięższe serie, dłuższy bieg ' +
    'i dłuższy dystans w basenie podnoszą punkt wyjścia. Wcześniejsze tygodnie i zalogowane ' +
    'treningi zostają nietknięte.'

  const lastDate = formatDateLong(timeline.lastDate)

  if (timeline.isFinished) {
    return {
      title: 'Plan się zakończył',
      hint: `Plan obejmował okres do ${lastDate}. ${carryOver}`,
      action,
    }
  }
  if (timeline.isFinalWeek) {
    return {
      title: 'Plan kończy się w tym tygodniu',
      hint: `Ostatni dzień to ${lastDate}. Możesz dopisać kolejne dwa tygodnie już teraz — ${carryOver}`,
      action,
    }
  }
  return {
    title: 'Kolejne dwa tygodnie',
    hint: `Dwa tygodnie doklejone na końcu planu, za ${lastDate}. ${carryOver} Rytm bloków 3 + 1 biegnie dalej, więc deload wypadnie w swoim terminie.`,
    action,
  }
}

function GenerationNotes({
  result,
  failed,
}: {
  result: ExtendedPlanResult | null
  failed: string | null
}) {
  if (failed) {
    return (
      <div className="mt-3">
        <Callout tone="warn" title="Plan nie został utworzony">
          {failed}
        </Callout>
      </div>
    )
  }
  if (!result) return null

  const { run, swim } = result.cardioFromLogs
  const nothingCarried =
    result.carriedLoadCount === 0 && !run && !swim && result.blockOffsetWeeks === 0

  return (
    <div className="mt-3 grid gap-2">
      {/* Co się właśnie stało — dopisanie tygodni wygląda inaczej niż nowy plan,
          a bez tej informacji nie da się poznać, który wariant zadziałał. */}
      <Callout tone="info" title={result.mode === 'extended' ? 'Tygodnie dopisane' : 'Plan utworzony'}>
        {result.mode === 'extended'
          ? `Plan ma teraz ${weeksLabel(result.plan.weeks)}. Dopisane tygodnie ` +
            `${result.firstWeekIndex + 1}–${result.firstWeekIndex + result.addedWeeks} ` +
            `zaczynają się ${formatDateLong(result.firstWeekStart)} ` +
            `(${sessionsLabel(result.sessionCount)}).`
          : `Plan na ${weeksLabel(result.plan.weeks)} od ${formatDateLong(result.firstWeekStart)} ` +
            `(${sessionsLabel(result.sessionCount)}). Poprzedni plan nie sięgał bieżącego tygodnia, ` +
            'więc kolejne tygodnie nie miałyby się czego trzymać — powstał nowy.'}
      </Callout>
      {result.carriedLoadCount > 0 && (
        <Callout tone="info" title="Ciężary przeniesione z historii">
          {result.carriedLoadCount} ćwiczeń dostało obciążenie z Twoich ostatnich sesji.
          Kolejne tygodnie podniesie progresja z tego, co zalogujesz — plan nie zgaduje,
          o ile urośniesz.
        </Callout>
      )}
      {(run || swim) && (
        <Callout tone="info" title="Cardio policzone z odbytych sesji">
          {run && (
            <span className="block">
              Bieganie: {formatDistance(run.distanceM)} w tempie {formatPace(run.paceSecPerKm)}
              /km — z Twojej najdłuższej sesji, nie z danych z profilu.
            </span>
          )}
          {swim && (
            <span className="block">
              Pływanie: {swim.laps} długości ({swim.laps * swim.poolLengthM} m) jako nowy punkt
              wyjścia.
            </span>
          )}
        </Callout>
      )}
      {result.blockOffsetWeeks > 0 && (
        <Callout tone="info">
          Zachowano pozycję w cyklu — nie wracasz do pierwszego tygodnia akumulacji,
          a deload wypadnie w swoim terminie.
        </Callout>
      )}
      {result.warnings.map((warning) => (
        <Callout key={warning} tone="warn">
          {warning}
        </Callout>
      ))}
      {result.warnings.length === 0 && nothingCarried && (
        <Callout tone="info">
          Bez ostrzeżeń. Nic nie zostało przeniesione z historii — to normalne,
          dopóki nie ma zalogowanych treningów.
        </Callout>
      )}
    </div>
  )
}

export function DietSetupCard({
  profile,
  targets,
  weekStart,
}: {
  profile: Profile
  targets: Macros
  weekStart?: string
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<GenerateWeekResult | null>(null)
  // Tak samo jak przy planie (`usePlanGeneration`): nieudane generowanie musi
  // powiedzieć, że się nie udało. Bez tego przycisk wraca do napisu i zostaje
  // pusty ekran „brak jadłospisu" — wygląda jak brak reakcji na kliknięcie.
  const [failed, setFailed] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setFailed(null)
    try {
      const start = startOfWeek(weekStart ?? todayIso())
      const generated = await dietRepo.generateWeek(profile, start, targets)
      setResult(generated)
      // Lista zakupów wynika z jadłospisu — budujemy ją od razu,
      // żeby użytkownik nie musiał pamiętać o drugim kroku.
      if (generated.saved > 0) await shoppingRepo.build(start)
    } catch (cause) {
      setFailed(
        cause instanceof Error
          ? `Nie udało się ułożyć jadłospisu: ${cause.message}`
          : 'Nie udało się ułożyć jadłospisu.',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <SectionTitle
        hint={`Cel: ${targets.kcal} kcal, ${targets.proteinG} g białka, ${targets.fatG} g tłuszczu, ${targets.carbsG} g węglowodanów. Lista zakupów powstanie automatycznie.`}
      >
        Brak jadłospisu na ten tydzień
      </SectionTitle>
      <Button onClick={generate} disabled={busy} className="w-full">
        {busy ? 'Generowanie…' : 'Wygeneruj jadłospis na tydzień'}
      </Button>

      {failed && (
        <div className="mt-3">
          <Callout tone="warn">{failed}</Callout>
        </div>
      )}

      {result && result.failedDates.length > 0 && (
        <div className="mt-3">
          <Callout tone="warn" title="Część dni bez rozwiązania">
            Dla {result.failedDates.join(', ')} wykluczenia z profilu nie pozostawiły żadnej
            opcji dla któregoś posiłku. Poluzuj alergeny lub listę „czego nie jem".
          </Callout>
        </div>
      )}

      {/* Sufit bazy przepisów — liczba dni pod celem zamiast „plan wykonany",
          po którym brakuje dwustu kalorii. Sama liczba wchodzi do TYTUŁU, bo
          to jedyna treść tego ostrzeżenia: wyjaśnianie zakresu bazy pod każdym
          wygenerowanym tygodniem powtarzało to samo akapitem, a jedyna rada,
          jaką dawało („wybierz preset"), przy włączonym presecie była pusta. */}
      {result && result.belowTargetDays.length > 0 && (
        <div className="mt-3">
          <Callout
            tone="warn"
            title={`${result.belowTargetDays.length} z 7 dni wychodzi pod celem kalorycznym`}
          />
        </div>
      )}
    </Card>
  )
}
