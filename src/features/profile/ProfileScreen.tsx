import { useState } from 'react'
import { Link } from 'react-router'
import type { Profile } from '@/domain/types'
import { BMI_CATEGORY_LABELS_PL } from '@/domain/calc/bmi'
import { ageFromBirthYear } from '@/domain/calc/bmr'
import {
  activityLabelParts,
  ALLERGEN_LABELS,
  DIET_STYLE_LABELS,
  EQUIPMENT_LABELS,
  EXPERIENCE_LABELS,
  GOAL_LABELS,
  INJURY_LABELS,
  PREP_STYLE_LABELS,
  WEEKDAY_LABELS,
} from '@/lib/labels'
import { SWEET_SNACK } from '@/domain/diet/sweetSnack'
import { todayIso } from '@/domain/dates'
import { formatDistance, formatPace, measurementsLabel, pl } from '@/lib/format'
import { Badge, Button, Callout, Card, SectionTitle, Spinner, Stat } from '@/components/ui'
import { Screen, ScreenHeader } from '@/app/AppShell'
import { useTargets } from '../shared/useTargets'
import { ProfileEditSheet, type ResyncResult } from './ProfileEditSheet'
import { ResetCard } from './ResetCard'
import { WeeklyCheckInCard } from '../today/WeeklyCheckInCard'

export function ProfileScreen({ profile }: { profile: Profile }) {
  const [editing, setEditing] = useState(false)
  const [resync, setResync] = useState<ResyncResult>({})
  const state = useTargets(profile)

  if (!state) return <Spinner />

  const targets = state.targets

  return (
    <Screen>
      <ScreenHeader
        title={profile.name}
        subtitle={`${ageFromBirthYear(profile.birthYear)} lat · ${profile.heightCm} cm · ${GOAL_LABELS[profile.goal]}`}
        action={<Button onClick={() => setEditing(true)}>Zmień</Button>}
      />

      <Card>
        <SectionTitle hint="Liczone z masy odniesienia z profilu. Codzienne ważenie zasila trend i wykresy, ale nie zmienia celu — masę odniesienia przestawia się tu, przyciskiem „Zmień”.">
          Wyliczenia
        </SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Masa odniesienia"
            value={state.referenceWeightKg}
            unit="kg"
            hint="wejście do wyliczeń"
          />
          <Stat
            label="Masa (trend)"
            value={state.trendWeightKg ?? '—'}
            unit={state.trendWeightKg !== null ? 'kg' : undefined}
            hint={measurementsLabel(state.measurementCount)}
          />
          <Stat
            label="BMI"
            value={targets.bmi}
            hint={BMI_CATEGORY_LABELS_PL[targets.bmiCategory]}
          />
          <Stat
            label="BMR"
            value={targets.bmr}
            unit="kcal"
            hint={targets.bmrFormula === 'katch' ? 'Katch-McArdle' : 'Mifflin-St Jeor'}
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Stat label="TDEE szacowany" value={targets.tdee} unit="kcal" />
          <Stat
            label="TDEE z danych"
            value={state.adaptive?.tdee ?? '—'}
            unit={state.adaptive ? 'kcal' : undefined}
            hint="informacyjnie"
          />
        </div>
        {state.trendWeightKg !== null &&
          Math.abs(state.trendWeightKg - state.referenceWeightKg) >= 2 && (
            <div className="mt-3">
              <Callout title="Trend odjechał od masy odniesienia">
                Trend to {pl(state.trendWeightKg)} kg, a wyliczenia stoją na{' '}
                {pl(state.referenceWeightKg)} kg. To nie błąd — tak działa stabilny cel. Gdy
                różnica robi się istotna, przestaw masę odniesienia przyciskiem „Zmień";
                jadłospis przeliczy się raz.
              </Callout>
            </div>
          )}
        <div className="mt-2 grid grid-cols-4 gap-2">
          <Stat label="Cel" value={targets.kcal} unit="kcal" />
          <Stat label="Białko" value={targets.macros.proteinG} unit="g" />
          <Stat label="Tłuszcz" value={targets.macros.fatG} unit="g" />
          <Stat label="Węgle" value={targets.macros.carbsG} unit="g" />
        </div>
        {profile.kcalOverride != null && (
          <div className="mt-3">
            <Callout tone="warn">
              Cel kaloryczny jest nadpisany ręcznie ({profile.kcalOverride} kcal). Wyliczenie
              automatyczne jest ignorowane, ale minimum bezpieczeństwa obowiązuje.
            </Callout>
          </div>
        )}
      </Card>

      {(resync.plan || resync.diet) && (
        <Callout tone="info" title="Zmiany zostały już zastosowane">
          {resync.plan && (
            <span className="block">
              Plan: przeliczono {resync.plan.updatedSessions} sesji.
              {resync.plan.keptLogged > 0 &&
                ` ${resync.plan.keptLogged} pominięto, bo są już zalogowane.`}
              {resync.plan.keptPast > 0 && ` ${resync.plan.keptPast} z przeszłości bez zmian.`}
            </span>
          )}
          {resync.diet && (
            <span className="block">
              Jadłospis: przeliczono {resync.diet.updatedDays.length} dni.
              {resync.diet.keptLoggedDays.length > 0 &&
                ` ${resync.diet.keptLoggedDays.length} pominięto, bo są tam zalogowane posiłki.`}
            </span>
          )}
          {resync.plan?.warnings.map((warning) => (
            <span key={warning} className="mt-1 block">
              {warning}
            </span>
          ))}
        </Callout>
      )}

      {/* Droga awaryjna do pomiarów: ekran „Dziś" pyta o nie tylko w sobotę,
          więc bez tego jedno przeoczenie kosztowałoby tygodniową dziurę
          w historii, której nie da się odtworzyć. */}
      <WeeklyCheckInCard today={todayIso()} variant="profile" />

      {/* Postępy nie mają zakładki w dolnym pasku — wchodzi się tu. */}
      <Card>
        <SectionTitle hint="Wykresy masy z trendem, objętości treningowej, kalorii i dystansów. Wszystko liczone z tego, co zalogowałeś.">
          Postępy
        </SectionTitle>
        <Link to="/postepy" className="block">
          <Button className="w-full">Zobacz wykresy i statystyki</Button>
        </Link>
      </Card>

      <Card>
        <SectionTitle>Trening</SectionTitle>
        <dl className="grid gap-2 text-sm">
          <Row label="Doświadczenie" value={EXPERIENCE_LABELS[profile.experience]} />
          <Row label="Aktywność" value={activityLabelParts(profile.activityLevel).short} />
          <Row
            label="Dni treningowe"
            value={profile.availableDays.map((d) => WEEKDAY_LABELS[d]).join(', ')}
          />
          <Row label="Czas sesji" value={`${profile.sessionMinutes} min`} />
          <Row
            label="Sprzęt"
            value={profile.equipment.map((e) => EQUIPMENT_LABELS[e]).join(', ') || '—'}
          />
          {profile.equipment.includes('running') && (
            <Row
              label="Punkt wyjścia — bieg"
              value={
                profile.runBaseline
                  ? `${formatDistance(profile.runBaseline.distanceM)} @ ${formatPace(profile.runBaseline.paceSecPerKm)}/km`
                  : 'brak — plan się nie utworzy'
              }
            />
          )}
          {profile.equipment.includes('pool') && (
            <Row
              label="Punkt wyjścia — basen"
              value={
                profile.swimBaseline
                  ? `${profile.swimBaseline.laps} × ${profile.swimBaseline.poolLengthM} m`
                  : 'brak — plan się nie utworzy'
              }
            />
          )}
          {profile.eventDate && <Row label="Data zawodów" value={profile.eventDate} />}
        </dl>
        {profile.injuries.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
              Kontuzje — ćwiczenia z przeciwwskazaniem są wykluczone z planu
            </p>
            <div className="flex flex-wrap gap-1.5">
              {profile.injuries.map((injury) => (
                <Badge key={injury} tone="danger">
                  {INJURY_LABELS[injury]}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card>
        <SectionTitle>Dieta</SectionTitle>
        <dl className="grid gap-2 text-sm">
          <Row label="Styl" value={DIET_STYLE_LABELS[profile.diet.style]} />
          <Row label="Gotowanie" value={PREP_STYLE_LABELS[profile.cooking.prepStyle]} />
          <Row label="Czas na gotowanie" value={`do ${profile.cooking.weekdayMinutes} min`} />
          <Row
            label="Śniadanie / obiad / po pracy / kolacja"
            value={[
              profile.mealSplit.breakfast,
              profile.mealSplit.lunch,
              profile.mealSplit.afternoon,
              profile.mealSplit.dinner,
            ]
              .map((share) => `${Math.round(share * 100)}%`)
              .join(' / ')}
          />
          <Row
            label="Słodka przekąska"
            value={`${SWEET_SNACK.kcal} kcal odłożone z celu`}
          />
        </dl>
        {profile.diet.allergens.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
              Alergie — produkty z tymi alergenami nigdy nie wejdą do jadłospisu
            </p>
            <div className="flex flex-wrap gap-1.5">
              {profile.diet.allergens.map((allergen) => (
                <Badge key={allergen} tone="danger">
                  {ALLERGEN_LABELS[allergen]}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {profile.diet.dislikedTags.length > 0 && (
          <div className="mt-3">
            <p className="mb-1.5 text-xs tracking-wide text-[var(--color-text-dim)] uppercase">
              Czego nie jesz
            </p>
            <div className="flex flex-wrap gap-1.5">
              {profile.diet.dislikedTags.map((tag) => (
                <Badge key={tag}>{tag}</Badge>
              ))}
            </div>
          </div>
        )}
      </Card>

      {/* Kopia zapasowa ukryta na życzenie — kod w `features/backup/BackupCard.tsx`
          i `db/backup.ts` zostaje nietknięty i przetestowany, więc przywrócenie
          jej to dodanie tu jednej linii `<BackupCard />`. */}
      <ResetCard />

      <ProfileEditSheet
        profile={profile}
        open={editing}
        onClose={() => setEditing(false)}
        onSaved={setResync}
      />
    </Screen>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--color-text-dim)]">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  )
}
