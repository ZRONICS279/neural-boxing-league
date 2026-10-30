import {
  type Fighter,
  type LeagueState,
  getActionPreferences,
} from "../app/simulation.ts";

/** The public roster keeps career facts and readable tendencies, not the
 * learned matrices or private opponent dossiers that produced them. Lives in
 * its own module because every route that lets an athlete out the door —
 * league, roster, training, archive — has to walk them through here first. */
export function publicFighter(fighter: Fighter): Fighter {
  return {
    ...fighter,
    publicActionPreferences: getActionPreferences(fighter),
    opponentDossiers: {},
    policy: {
      ...fighter.policy,
      weights: [],
      bias: [],
      hiddenWeights: [],
      hiddenBias: [],
      recurrentHiddenWeights: [],
      memoryInputWeights: [],
      memoryWeights: [],
      memoryBias: [],
      intentWeights: [],
      intentMemoryWeights: [],
      intentBias: [],
      outputWeights: [],
      outputMemoryWeights: [],
      intentActionWeights: [],
    },
  };
}

export function publicLeague(league: LeagueState): LeagueState {
  return { ...league, roster: league.roster.map(publicFighter) };
}
