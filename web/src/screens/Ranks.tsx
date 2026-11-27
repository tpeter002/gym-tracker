import { useMemo } from 'react';
import { update } from '../lib/store';
import {
  BODY_REGION_TITLES, BODY_REGIONS, describeLift, DIVISIONS, latestBodyKg, liftRanks, overallRank, rankSetup, rankTitle, stepAfter, TIER_TITLES, TIERS,
} from '../lib/ranks';
import type { LiftRank, OverallRank } from '../lib/ranks';
import type { AppState, RankStandards, WeightUnit } from '../lib/types';
import { weightText } from '../lib/units';
import { Segmented } from '../ui/controls';
import { Link, LinkRow, Page, Section } from '../ui/layout';
import { RankBadge, RankProgress } from '../ui/RankBadge';

export const STANDARDS_OPTIONS = [
  { value: '', label: 'Off' },
  { value: 'men', label: 'Men' },
  { value: 'women', label: 'Women' },
] as const;

export function chooseStandards(standards: RankStandards | ''): void {
  update((draft) => {
    draft.settings.rankStandards = standards;
  });
}

/** Every ranked lift, strongest first, under one rank for the whole lifter. */
export function Ranks({ state }: { state: AppState }) {
  const { unit, rankStandards } = state.settings;
  const bodyKg = latestBodyKg(state);
  const isSetUp = rankSetup(state) !== null;
  const ranks = useMemo(() => liftRanks(state), [state.workouts, state.exercises, state.bodyWeights, rankStandards]);
  const overall = useMemo(() => overallRank(ranks), [ranks]);

  return (
    <Page title="Ranks" large>
      {!isSetUp && (
        <p className="lead">
          Every lift you log earns a rank, from Iron to Legend, by how your best set compares with strong lifters of your body weight.
          {' '}{rankStandards ? 'Log your body weight to see yours.' : 'Choose the standards to measure against to see yours.'}
        </p>
      )}

      {overall.rank && <Overall overall={overall} />}

      {isSetUp && ranks.length === 0 && (
        <p className="lead">Nothing is ranked yet. Finish a workout with a weighted lift, push-ups or pull-ups in it and its rank shows up here.</p>
      )}

      {ranks.length > 0 && (
        <Section title="Lifts" aside={ranks.length} footer="A rank rests on your best working set: its estimated one-rep max for lifts with weight, its reps for bodyweight exercises. Holds and cardio aren't ranked.">
          {ranks.map((rank) => <LiftRow key={rank.exercise.id} rank={rank} unit={unit} />)}
        </Section>
      )}

      <Section
        title="Measured against"
        footer="Ranks use your latest weigh-in, so a lift counts for more at a lower body weight. The standards are rough: a game to make progress visible, not a certificate."
      >
        <div className="row">
          Standards
          <Segmented label="Strength standards" value={rankStandards} options={STANDARDS_OPTIONS} onChange={chooseStandards} />
        </div>
        <LinkRow to="/body">
          Body weight
          <span className="row-value">{bodyKg === null ? 'Log it' : weightText(unit, bodyKg)}</span>
        </LinkRow>
      </Section>

      <Section title="The ladder" footer="Three steps to each tier. Gold begins at a little over half of what Legend takes.">
        <div className="rank-ladder">
          {TIERS.map((tier) => (
            <span key={tier}>
              <RankBadge rank={{ tier, division: DIVISIONS }} size={34} decorative />
              {TIER_TITLES[tier]}
            </span>
          ))}
        </div>
      </Section>
    </Page>
  );
}

function Overall({ overall }: { overall: OverallRank }) {
  const rank = overall.rank!;
  const next = stepAfter(rank);
  return (
    <section className="section" aria-label="Overall rank">
      <div className="card">
        <div className="rank-hero" data-tier={rank.tier}>
          <RankBadge rank={rank} size={104} celebrate decorative />
          <div className="grow">
            <span className="caption secondary">Overall</span>
            <strong>{rankTitle(rank)}</strong>
            <RankProgress rank={rank} />
            <span className="caption secondary">{next ? `Next: ${rankTitle(next)}` : 'The top of the ladder'}</span>
          </div>
        </div>
        {BODY_REGIONS.map((region) => {
          const best = overall.best[region];
          return best ? (
            <Link key={region} to={`/exercises/${best.exercise.id}`} className="row">
              <span className="rank-region">{BODY_REGION_TITLES[region]}</span>
              <span className="grow ellipsis">{best.exercise.name}</span>
              <span className="row-value">{rankTitle(best)}</span>
              <RankBadge rank={best} size={28} decorative />
            </Link>
          ) : (
            <div key={region} className="row">
              <span className="rank-region">{BODY_REGION_TITLES[region]}</span>
              <span className="grow secondary">Nothing ranked yet — it counts as zero</span>
            </div>
          );
        })}
      </div>
      <div className="section-footer">The average of your best push, pull and leg lift.</div>
    </section>
  );
}

function LiftRow({ rank, unit }: { rank: LiftRank; unit: WeightUnit }) {
  const words = describeLift(rank, unit);
  return (
    <LinkRow to={`/exercises/${rank.exercise.id}`}>
      <RankBadge rank={rank} size={44} decorative />
      <span className="grow" data-tier={rank.tier}>
        <span className="title-line">{rank.exercise.name}</span>
        <span className="sub">{rankTitle(rank)} · {words.best}</span>
        <RankProgress rank={rank} />
        {words.next && <span className="sub">{words.next}</span>}
      </span>
    </LinkRow>
  );
}
