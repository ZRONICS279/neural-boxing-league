"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BOXING_MODEL, type BoutState, type Fighter } from "./fight-model";
import { decodeTimeline, type FightTimeline } from "./fight-timeline";
import { boutFromTimeline } from "./timeline-play";
import { FightCanvas, type FightDrill } from "./fight-canvas";
import { SpeakerIcon } from "./fight-stage";
import { useSound } from "./sound";
import { formatClock } from "./site-chrome";

interface GymScene {
  id: FightDrill;
  tab: string;
  label: string;
  detail: string;
  duration: number;
}

const GYM_SCENES: GymScene[] = [
  {
    id: "sparring",
    tab: "Sparring",
    label: "Guarded sparring",
    detail: "A practice round against a partner from his own division.",
    duration: 22,
  },
  {
    id: "reflex",
    tab: "Reflex balls",
    label: "Projectile evasion",
    detail: "Read the release, slip outside the line, recover the stance.",
    duration: 14,
  },
  {
    id: "heavy-bag",
    tab: "Heavy bag",
    label: "Combination power",
    detail: "Drive from the floor and bring every hand straight back to guard.",
    duration: 14,
  },
  {
    id: "conditioning",
    tab: "Push-ups",
    label: "Shoulder endurance",
    detail: "Short, clean sets under fatigue. Hips and shoulders move as one line.",
    duration: 12,
  },
  {
    id: "footwork",
    tab: "Footwork",
    label: "Ladder and cone work",
    detail: "Small exits, balanced feet, and no crossing under pressure.",
    duration: 15,
  },
];

/** How many canned practice rounds sit in public/gym-reels/. */
const GYM_REELS = 6;

/** Decoded reels, kept for the tab's life — six small files, fetched once. */
const reelCache = new Map<number, Promise<FightTimeline>>();

function loadReel(index: number) {
  let held = reelCache.get(index);
  if (!held) {
    held = fetch(`/gym-reels/reel-${index}.json`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status));
        return response.text();
      })
      .then(decodeTimeline);
    held.catch(() => reelCache.delete(index));
    reelCache.set(index, held);
  }
  return held;
}

function trainingPartner(roster: Fighter[], trainee: Fighter, cycle: number) {
  const sameDivision = roster.filter(
    (fighter) => fighter.id !== trainee.id && fighter.weightClass === trainee.weightClass,
  );
  const pool = sameDivision.length ? sameDivision : roster.filter((fighter) => fighter.id !== trainee.id);
  return pool[cycle % Math.max(1, pool.length)] ?? trainee;
}

interface TrainingGymFeedProps {
  trainee: Fighter;
  roster: Fighter[];
  isTraining: boolean;
  cycles: number;
  checkpoints: number;
  rewardGain: number;
}

export function TrainingGymFeed({
  trainee,
  roster,
  isTraining,
  cycles,
  checkpoints,
  rewardGain,
}: TrainingGymFeedProps) {
  const partner = useMemo(
    () => trainingPartner(roster, trainee, cycles),
    [cycles, roster, trainee],
  );
  const [bout, setBout] = useState<BoutState | null>(null);
  const reelRef = useRef<FightTimeline | null>(null);
  const reelTick = useRef(0);
  const [sceneIndex, setSceneIndex] = useState(0);
  const [clock, setClock] = useState({ now: 0, startedAt: 0 });
  const [reducedMotion, setReducedMotion] = useState(false);
  const sound = useSound();
  const scene = GYM_SCENES[sceneIndex];

  // A different training cycle cuts to different canned footage. The reels are
  // recorded practice rounds (see scripts/build-gym-reels.ts); the athletes on
  // the floor are drawn over the recorded motion, so a cut only changes the
  // choreography — never who the header says is training.
  const reelIndex = Math.abs(trainee.seed + cycles) % GYM_REELS;
  useEffect(() => {
    let mounted = true;
    void loadReel(reelIndex)
      .then((reel) => {
        if (!mounted) return;
        reelRef.current = reel;
        reelTick.current = 0;
        setBout(boutFromTimeline(reel, 0, reelIndex, null));
      })
      .catch(() => {
        // Footage that cannot load leaves the last frame up; the gym is
        // background, not a broadcast.
      });
    return () => {
      mounted = false;
    };
  }, [reelIndex]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const apply = () => setReducedMotion(media.matches);
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const current = Date.now();
      setClock({ now: current, startedAt: started });
      if (current - started >= scene.duration * 1000) {
        setSceneIndex((index) => (index + 1) % GYM_SCENES.length);
      }
    }, 250);
    return () => window.clearInterval(timer);
  }, [scene.duration, sceneIndex]);

  useEffect(() => {
    if (scene.id !== "sparring" || reducedMotion) return;
    // 100 ms of footage per 50 ms interval — the gym cam's 2x fast-motion feel —
    // regardless of the recording's tick rate.
    const ticksPerInterval = Math.max(
      1,
      Math.round(0.1 / BOXING_MODEL.physicsStepSeconds),
    );
    const timer = window.setInterval(() => {
      const reel = reelRef.current;
      if (!reel) return;
      // Footage loops: a practice round that runs out simply starts over.
      reelTick.current = (reelTick.current + ticksPerInterval) % (reel.ticks + 1);
      setBout(boutFromTimeline(reel, reelTick.current, reelIndex, null));
    }, 50);
    return () => window.clearInterval(timer);
  }, [reducedMotion, reelIndex, scene.id]);

  const elapsed = clock.startedAt ? (clock.now - clock.startedAt) / 1000 : 0;
  const remaining = Math.max(0, Math.ceil(scene.duration - elapsed));
  const progress = Math.min(100, (elapsed / scene.duration) * 100);
  // The reel's blue corner stands in for the trainee: the readout narrates the
  // recorded motion the athlete on the floor is being drawn over.
  const traineeRuntime = bout?.left ?? null;

  return (
    <section className="training-gym" aria-label="Illustrative training gym feed">
      <header className="training-gym__head">
        <div>
          <span className="eyebrow">Gym cam · illustrative</span>
          <strong>{trainee.firstName} {trainee.lastName} is on the floor</strong>
          <small>
            {scene.id === "sparring"
              ? `Practice partner · ${partner.firstName} ${partner.lastName}`
              : `${trainee.weightClass} · rotation athlete ${roster.findIndex((fighter) => fighter.id === trainee.id) + 1} of ${roster.length}`}
          </small>
        </div>
        <div className="training-gym__clock" aria-live="off">
          <span>Next drill</span>
          <strong>{`0:${String(remaining).padStart(2, "0")}`}</strong>
        </div>
      </header>

      <div className="training-gym__stage">
        {bout ? (
          <FightCanvas
            bout={bout}
            left={trainee}
            right={partner}
            venue="gym"
            drill={scene.id}
          />
        ) : null}
        {/* Same speaker as the ring, same flag under it — a viewer who unmutes
            the broadcast has unmuted the gym, and the other way around. The gym
            itself only plays music: sparring here is background footage, and
            its punches stay silent. */}
        <button
          className="ring-sound"
          type="button"
          onClick={sound.toggle}
          aria-pressed={!sound.muted}
          title={sound.muted ? "Gym music" : "Silence the gym"}
        >
          <SpeakerIcon muted={sound.muted} />
          <span className="sr-only">{sound.muted ? "Turn sound on" : "Turn sound off"}</span>
        </button>
      </div>

      {/* Under the picture, not over it: on a phone the stage is short enough
          that a lower third laid across it hid the fighters' feet. */}
      <div className="training-gym__lower-third">
        <div>
          <span>
            {isTraining ? "Training live" : "Standby"} · {String(sceneIndex + 1).padStart(2, "0")} / {String(GYM_SCENES.length).padStart(2, "0")}
          </span>
          <strong>{scene.label}</strong>
          <small>{scene.detail}</small>
        </div>
        <dl>
          <div><dt>{scene.id === "sparring" ? "Doing" : "Focus"}</dt><dd>{scene.id === "sparring" ? (traineeRuntime?.action ?? "guard").replace(/([A-Z])/g, " $1") : scene.tab}</dd></div>
          <div><dt>Fitness run</dt><dd>{rewardGain >= 0 ? "+" : ""}{rewardGain.toFixed(1)}</dd></div>
          <div><dt>Kept</dt><dd>{checkpoints}</dd></div>
          <div>
            <dt>{scene.id === "sparring" ? "Round time" : "Drill clock"}</dt>
            <dd>{scene.id === "sparring" ? formatClock(bout?.roundTime ?? 0) : `0:${String(remaining).padStart(2, "0")}`}</dd>
          </div>
        </dl>
      </div>

      <div className="training-gym__progress" aria-hidden="true"><i style={{ width: `${progress}%` }} /></div>

      <div className="training-gym__controls" aria-label="Automatic gym drill rotation">
        <div role="list" aria-label="Gym drill sequence">
          {GYM_SCENES.map((option, index) => (
            <div
              className={index === sceneIndex ? "training-gym__scene training-gym__scene--active" : "training-gym__scene"}
              role="listitem"
              aria-current={index === sceneIndex ? "step" : undefined}
              key={option.id}
            >
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{option.tab}</strong>
            </div>
          ))}
        </div>
      </div>

      <p className="training-gym__note">
        The drills shown here are illustrative. They are not a recording of this
        athlete&apos;s actual training run.
      </p>
    </section>
  );
}
