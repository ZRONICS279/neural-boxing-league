/** Records a scheduled bout into the timeline wire format.
 *
 * This is the only place the engine and the codec meet: the bout is stepped
 * through the exact replay path a browser used to run — directives applied on
 * their recorded ticks and all — while the codec's own playback model runs
 * alongside it. Whenever the model's prediction stops matching the engine
 * (an action changed, a punch landed, a timer paused) a record is emitted
 * carrying the truth, so playback is exact by construction rather than by
 * assumption. */
import { createAnnouncer } from "../app/announcer.ts";
import { boutTickCeiling, replayBout, type ScheduledBout } from "../app/broadcast.ts";
import { BOXING_MODEL, type BoutFighter, type BoutState } from "../app/simulation.ts";
import {
  BODY_LERP_FIELDS,
  BOUT_LERP_FIELDS,
  FIGHTER_HOLD_FIELDS,
  FIGHTER_LERP_FIELDS,
  TIMELINE_STRIDE,
  chunkCapture,
  encodeTimeline,
  predictedElapsed,
  type ActionRecord,
  type FacingRecord,
  type FootRecord,
  type ImpactRecord,
  type TimelineCapture,
  type TimelineRecord,
  type TimelineSide,
  type TimelineVoiceLine,
} from "../app/fight-timeline.ts";

const SIDES: TimelineSide[] = ["left", "right"];

function actionRecordOf(fighter: BoutFighter, side: TimelineSide, tick: number): ActionRecord {
  return {
    tick,
    side,
    kind: "action",
    action: fighter.action,
    elapsed: fighter.actionElapsed,
    duration: fighter.actionDuration,
    hand: fighter.punchHand,
    zone: fighter.punchAimZone,
    extension: fighter.punchExtensionTarget,
  };
}

function impactRecordOf(fighter: BoutFighter, side: TimelineSide, tick: number): ImpactRecord {
  return {
    tick,
    side,
    kind: "impact",
    strike: fighter.lastStrikeKind,
    zone: fighter.lastImpactZone,
    impactJ: fighter.lastImpactJ,
    counter: fighter.lastImpactCounter,
    thrown: fighter.thrown,
    landed: fighter.landed,
    blocked: fighter.blocked,
    knockdowns: fighter.knockdowns,
  };
}

function actionDrifted(model: ActionRecord, fighter: BoutFighter, tick: number, dt: number) {
  return (
    model.action !== fighter.action ||
    model.duration !== fighter.actionDuration ||
    model.hand !== fighter.punchHand ||
    model.zone !== fighter.punchAimZone ||
    model.extension !== fighter.punchExtensionTarget ||
    Math.abs(predictedElapsed(model, tick, dt) - fighter.actionElapsed) > 1e-6
  );
}

function impactDrifted(model: ImpactRecord, fighter: BoutFighter) {
  return (
    model.strike !== fighter.lastStrikeKind ||
    model.zone !== fighter.lastImpactZone ||
    model.impactJ !== fighter.lastImpactJ ||
    (model.counter ?? false) !== fighter.lastImpactCounter ||
    model.thrown !== fighter.thrown ||
    model.landed !== fighter.landed ||
    model.blocked !== fighter.blocked ||
    model.knockdowns !== fighter.knockdowns
  );
}

/** Steps `bout` from the opening bell to the final one and returns the raw
 *  capture. The bout must still carry its athlete snapshots — recording is a
 *  server-side act, done once, on the same profiles the result was scored on. */
export function captureBout(bout: ScheduledBout): TimelineCapture {
  const dt = BOXING_MODEL.physicsStepSeconds;
  let state = replayBout(bout, 0);

  // The ringside call is recorded off the same frames, so what a viewer reads
  // and hears is what this pass wrote down — never a second derivation from
  // the sparser frames the stage publishes. Shown every frame from the first,
  // the engine is a viewer who was there for the walk-out.
  const blue = bout.profiles?.find((fighter) => fighter.id === bout.blueId) ?? null;
  const red = bout.profiles?.find((fighter) => fighter.id === bout.redId) ?? null;
  const announcer = blue && red ? createAnnouncer() : null;
  const voice: TimelineVoiceLine[] = [];

  const channels: Record<string, number[]> = {};
  for (const field of BOUT_LERP_FIELDS) channels[`bout.${field}`] = [];
  for (const side of SIDES) {
    for (const field of FIGHTER_LERP_FIELDS) channels[`${side}.${field}`] = [];
    for (const field of FIGHTER_HOLD_FIELDS) channels[`${side}.${field}`] = [];
    for (const field of BODY_LERP_FIELDS) channels[`${side}.body.${field}`] = [];
  }

  const records: TimelineRecord[] = [];
  const feed: TimelineCapture["feed"] = [];
  const feedWindows: TimelineCapture["feedWindows"] = [];
  const cards: TimelineCapture["cards"] = [];
  const actionModels = {} as Record<TimelineSide, ActionRecord>;
  const impactModels = {} as Record<TimelineSide, ImpactRecord>;
  const facingModels = {} as Record<TimelineSide, FacingRecord>;
  const footModels = {} as Record<TimelineSide, FootRecord>;
  let roundModel = -1;
  let previousFeed: BoutState["events"] = [];
  let cardsSeen = 0;

  const observe = (current: BoutState) => {
    const tick = current.tick;
    if (tick % TIMELINE_STRIDE === 0) {
      for (const field of BOUT_LERP_FIELDS) channels[`bout.${field}`].push(current[field]);
      for (const side of SIDES) {
        const fighter = current[side];
        for (const field of FIGHTER_LERP_FIELDS) channels[`${side}.${field}`].push(fighter[field]);
        for (const field of FIGHTER_HOLD_FIELDS) channels[`${side}.${field}`].push(fighter[field]);
        for (const field of BODY_LERP_FIELDS) {
          channels[`${side}.body.${field}`].push(fighter.body[field]);
        }
      }
    }
    for (const side of SIDES) {
      const fighter = current[side];
      if (!actionModels[side] || actionDrifted(actionModels[side], fighter, tick, dt)) {
        actionModels[side] = actionRecordOf(fighter, side, tick);
        records.push(actionModels[side]);
      }
      if (!impactModels[side] || impactDrifted(impactModels[side], fighter)) {
        impactModels[side] = impactRecordOf(fighter, side, tick);
        records.push(impactModels[side]);
      }
      if (!facingModels[side] || facingModels[side].value !== fighter.facingDirection) {
        facingModels[side] = { tick, side, kind: "facing", value: fighter.facingDirection };
        records.push(facingModels[side]);
      }
      if (!footModels[side] || footModels[side].value !== fighter.body.plantedFoot) {
        footModels[side] = { tick, side, kind: "foot", value: fighter.body.plantedFoot };
        records.push(footModels[side]);
      }
    }
    if (current.round !== roundModel) {
      roundModel = current.round;
      records.push({ tick, kind: "round", round: current.round });
    }
    // The feed is a sliding window (newest unshifted to the front, sliced to
    // eight), so its length says nothing — new entries are whatever sits in
    // front of the previously seen head. Reversed on push so the stored stream
    // runs in append order.
    const head = previousFeed[0];
    let fresh = current.events.length;
    if (head) {
      const found = current.events.findIndex(
        (event) =>
          event.id === head.id &&
          event.time === head.time &&
          event.tone === head.tone &&
          event.text === head.text,
      );
      if (found >= 0) fresh = found;
    }
    for (let i = fresh - 1; i >= 0; i--) {
      feed.push({ tick, event: current.events[i] });
    }
    if (fresh > 0 || current.events.length !== previousFeed.length) {
      feedWindows.push({ tick, window: current.events.length });
    }
    previousFeed = current.events;
    for (; cardsSeen < current.roundCards.length; cardsSeen++) {
      cards.push({ tick, card: current.roundCards[cardsSeen] });
    }
    if (announcer && blue && red) {
      const line = announcer.observe(current, blue, red);
      if (line) {
        voice.push({
          tick,
          line: voice.length,
          text: line.text,
          register: line.register,
          corner: line.corner,
          holdMs: line.holdMs,
        });
      }
    }
  };

  observe(state);
  let guard = 0;
  const ceiling = boutTickCeiling(bout);
  while (state.running && !state.finish && guard < ceiling) {
    const next = replayBout(bout, state.tick + 1, state);
    if (next.tick === state.tick) break;
    state = next;
    observe(state);
    guard += 1;
  }

  const capture: TimelineCapture = {
    tickSeconds: dt,
    stride: TIMELINE_STRIDE,
    startTick: 0,
    ticks: state.tick,
    roundLength: state.roundLength,
    totalRounds: state.totalRounds,
    left: {
      fighterId: state.left.fighterId,
      corner: state.left.corner,
      heightM: state.left.heightM,
      reachM: state.left.reachM,
    },
    right: {
      fighterId: state.right.fighterId,
      corner: state.right.corner,
      heightM: state.right.heightM,
      reachM: state.right.reachM,
    },
    channels,
    records,
    feed,
    feedWindows,
    cards,
    voice,
    result: { winnerId: state.winnerId, finish: state.finish },
  };
  return capture;
}

/** The whole fight as one encoded timeline. */
export function recordBoutTimeline(bout: ScheduledBout): string {
  return encodeTimeline(captureBout(bout));
}

/** The fight as the chunks the store actually keeps. */
export function recordBoutChunks(bout: ScheduledBout) {
  return chunkCapture(captureBout(bout));
}
