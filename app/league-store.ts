"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LeagueState } from "./fight-model";
import { GENESIS_BILL } from "./genesis-bill";

/** Adopts a league only in the shape this build writes.
 *
 * Older saves used to be migrated by the engine's own upgrader, but the engine
 * no longer ships to the browser. A stale local save is simply let go — the
 * durable worker's checkpoint re-covers anybody who had one — and a server
 * payload is trusted only when it speaks the current version. */
function adoptLeague(value: unknown): LeagueState | null {
  if (!value || typeof value !== "object") return null;
  const league = value as LeagueState;
  if (league.version !== GENESIS_BILL.version) return null;
  if (!Array.isArray(league.roster) || league.roster.length < 2) return null;
  return league;
}

/** Career save, persistent training worker, and native 3D service state.
 *
 * The live ring and the training lab are separate pages now, and both need the
 * same roster, the same worker telemetry, and the same connection status. The
 * hooks below own that shared plumbing so each page only writes its own screen. */

const STORAGE_KEY = "forge-league-save-v6";
const PREVIOUS_STORAGE_KEY = "forge-league-save-v5";

export type TrainingBudget = "1" | "5" | "continuous";

export interface TrainingLoopTelemetry {
  status: "idle" | "running" | "working" | "paused" | "complete" | "error";
  targetId: string | null;
  cycles: number;
  bouts: number;
  physicsSteps: number;
  candidates: number;
  checkpoints: number;
  startFitness: number;
  currentFitness: number;
  rewardGain: number;
  updatedAt: number;
}

export interface TrainingApiPayload {
  available: boolean;
  serverTime?: number;
  error?: string;
  job: (TrainingLoopTelemetry & {
    remainingCycles: number | null;
    pauseRequested: boolean;
    lastError: string | null;
    updatedAt: number;
  }) | null;
  league?: unknown;
}

export interface Sim3dStatus {
  available: boolean;
  status: "not-connected" | "unreachable" | "paused" | "running" | "working" | "error";
  targetId: string | null;
  pinnedScenario?: string | null;
  scenarios?: string[];
  lastError?: string | null;
  lastEvaluationGate?: {
    accepted: boolean;
    learning_advanced?: boolean;
    reward_improved: boolean;
    finite_state: boolean;
    upright_seconds: number;
    minimum_upright_seconds: number;
    commanded_distance?: number;
    minimum_commanded_distance?: number;
    autonomous?: boolean;
    teacher_weight?: number;
    footwork_goal_reached?: boolean;
    footwork_remaining_distance_m?: number;
  } | null;
  training: {
    generation: number;
    episodes: number;
    physics_steps: number;
    accepted_checkpoints: number;
  } | null;
  curriculum: {
    name: string;
    episode_seconds: number;
    domain_randomization: number;
  } | null;
  coach?: {
    reviews: number;
    successes: number;
    failures: number;
    focus: string;
    challenge_scale: number;
    exploration_scale: number;
    experienceRecords: number;
    independentState: boolean;
    last_review: {
      keep: string[];
      change: string[];
    } | null;
  };
  athleteTraining?: Record<string, {
    generation: number;
    episodes: number;
    acceptedCheckpoints: number;
    curriculum: string;
    coachFocus: string;
    experienceRecords: number;
  }>;
  physics: {
    engine?: string;
    physicsHz: number;
    motorHz: number;
    degreesOfFreedomPerAthlete: number;
    motorsPerAthlete: number;
    athletes: number;
    contactDerivedGroundForce: boolean;
    activeRagdollMuscles?: boolean;
    fatigueLimitedForce?: boolean;
    jacobianStrikeGuidance?: boolean;
    momentumResolvedImpacts?: boolean;
    physicalProjectileDrills?: boolean;
    projectileObservationFeatures?: number;
    bodyMassKg?: { blue: number; red: number };
    anthropometrics?: Record<"blue" | "red", {
      athleteId: string;
      heightM: number;
      reachM: number;
      massKg: number;
    }>;
    trainableSurvivalInstinct?: boolean;
    reachValidatedContacts?: boolean;
    replayFrames?: number;
  };
}

export const EMPTY_TRAINING_TELEMETRY: TrainingLoopTelemetry = {
  status: "idle",
  targetId: null,
  cycles: 0,
  bouts: 0,
  physicsSteps: 0,
  candidates: 0,
  checkpoints: 0,
  startFitness: 0,
  currentFitness: 0,
  rewardGain: 0,
  updatedAt: 0,
};

export const DISCONNECTED_SIM3D: Sim3dStatus = {
  available: false,
  status: "not-connected",
  targetId: null,
  training: null,
  curriculum: null,
  physics: {
    physicsHz: 500,
    motorHz: 50,
    degreesOfFreedomPerAthlete: 39,
    motorsPerAthlete: 33,
    athletes: 2,
    contactDerivedGroundForce: true,
  },
};

export function normalizeSim3dStatus(payload: Partial<Sim3dStatus>): Sim3dStatus {
  return {
    ...DISCONNECTED_SIM3D,
    ...payload,
    physics: {
      ...DISCONNECTED_SIM3D.physics,
      ...payload.physics,
    },
  };
}

/** The career save plus the persistent worker that keeps training it.
 *
 * The league is restored from local storage on mount, written back on every
 * change, and overwritten by the durable worker's checkpoint whenever the
 * server reports a newer one. */
export function useLeagueSync() {
  const [league, setLeague] = useState<LeagueState>(() => GENESIS_BILL);
  const [hydrated, setHydrated] = useState(false);
  const [trainingLoop, setTrainingLoop] = useState<TrainingLoopTelemetry>(
    EMPTY_TRAINING_TELEMETRY,
  );
  const [trainingTargetId, setTrainingTargetId] = useState("malik-okoro");
  const [notice, setNotice] = useState("League simulation ready.");
  const leagueRef = useRef(league);
  const trainingLoopRef = useRef(trainingLoop);

  useEffect(() => {
    leagueRef.current = league;
  }, [league]);

  useEffect(() => {
    trainingLoopRef.current = trainingLoop;
  }, [trainingLoop]);

  const applyTrainingPayload = useCallback((payload: TrainingApiPayload) => {
    const checkpoint = payload.league === undefined
      ? null
      : adoptLeague(payload.league);
    if (checkpoint) {
      leagueRef.current = checkpoint;
      setLeague(checkpoint);
    }
    if (payload.job) {
      const telemetry = {
        status: payload.job.status,
        targetId: payload.job.targetId,
        cycles: payload.job.cycles,
        bouts: payload.job.bouts,
        physicsSteps: payload.job.physicsSteps,
        candidates: payload.job.candidates,
        checkpoints: payload.job.checkpoints,
        startFitness: payload.job.startFitness,
        currentFitness: payload.job.currentFitness,
        rewardGain: payload.job.rewardGain,
        updatedAt: payload.job.updatedAt,
      } satisfies TrainingLoopTelemetry;
      trainingLoopRef.current = telemetry;
      setTrainingLoop(telemetry);
      if (payload.job.targetId) setTrainingTargetId(payload.job.targetId);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const saved =
          window.localStorage.getItem(STORAGE_KEY) ??
          window.localStorage.getItem(PREVIOUS_STORAGE_KEY);
        if (saved) {
          const parsed = adoptLeague(JSON.parse(saved));
          if (parsed) {
            setLeague(parsed);
            setNotice(`Season ${parsed.season}, week ${parsed.week} career save restored.`);
          }
        }
      } catch {
        setNotice("A fresh local league was created.");
      } finally {
        setHydrated(true);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(league));
  }, [hydrated, league]);

  useEffect(() => {
    if (!hydrated) return;
    let mounted = true;
    const refreshLeague = async () => {
      try {
        const response = await fetch("/api/training", { cache: "no-store" });
        if (!response.ok || !mounted) return;
        const payload = await response.json() as TrainingApiPayload;
        if (mounted) applyTrainingPayload(payload);
      } catch {
        // The local league remains usable when persistent storage is unavailable.
      }
    };
    const poll = async () => {
      try {
        const response = await fetch("/api/training/status", { cache: "no-store" });
        if (!response.ok || !mounted) return;
        const payload = await response.json() as TrainingApiPayload;
        const changed = Boolean(
          payload.job && (
            payload.job.cycles !== trainingLoopRef.current.cycles ||
            payload.job.targetId !== trainingLoopRef.current.targetId
          ),
        );
        if (changed) await refreshLeague();
        else if (mounted) applyTrainingPayload(payload);
      } catch {
        // A missed status beat is harmless; the next one carries the same D1 row.
      }
    };
    void refreshLeague();
    const timer = window.setInterval(poll, 5000);
    return () => {
      mounted = false;
      window.clearInterval(timer);
    };
  }, [applyTrainingPayload, hydrated]);

  return {
    league,
    setLeague,
    leagueRef,
    hydrated,
    trainingLoop,
    setTrainingLoop,
    trainingTargetId,
    setTrainingTargetId,
    applyTrainingPayload,
    notice,
    setNotice,
  };
}

/** Connection and training state of the separate native MuJoCo worker. */
export function useSim3dStatus() {
  const [sim3d, setSim3d] = useState<Sim3dStatus>(DISCONNECTED_SIM3D);

  // The native MuJoCo worker is not part of the site right now: nothing is
  // deployed behind /api/sim3d, so the old 8-second poll did nothing but spray
  // 502s into the logs on every training-page visit. The hook keeps its shape
  // and reports the worker permanently disconnected; to bring the 3D lab
  // back, restore the poll loop from git history alongside the worker itself.
  return { sim3d, setSim3d };
}
