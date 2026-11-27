import { useMemo } from 'react';
import { liftRanks } from '../lib/ranks';
import type { LiftRank } from '../lib/ranks';
import type { AppState } from '../lib/types';

/** `liftRanks`, worked out again only when something a rank rests on has changed rather than on every render. */
export function useLiftRanks(state: AppState, { includeActive = false, until = Infinity } = {}): LiftRank[] {
  return useMemo(
    () => liftRanks(state, { includeActive, until }),
    [state.workouts, state.exercises, state.bodyWeights, state.settings.rankStandards, includeActive, until],
  );
}
