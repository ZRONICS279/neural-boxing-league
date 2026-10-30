"use client";

import { useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";

import {
  CAMERA_DEFAULT,
  SOLO_CURRICULA,
  arcadeCamera,
  createEffects,
  drawWorld,
  easeCamera,
  trackImpacts,
  type CameraState,
  type PoseFrame,
  type ReplayPayload,
  type SceneEffects,
} from "./arcade-renderer";

interface ReplayBuffer {
  id: number;
  endReason: ReplayPayload["endReason"];
  curriculum: string;
  frames: PoseFrame[];
}

interface Native3dViewerProps {
  available: boolean;
  status: string;
  targetName: string;
  curriculum: string;
  episodeSeconds: number;
  generation: number;
  episodes: number;
  coachFocus: string;
  evaluationGate: {
    accepted?: boolean;
    learning_advanced?: boolean;
    upright_seconds?: number;
    minimum_upright_seconds?: number;
    commanded_distance?: number;
    minimum_commanded_distance?: number;
    autonomous?: boolean;
    teacher_weight?: number;
    footwork_goal_reached?: boolean;
    footwork_remaining_distance_m?: number;
  } | null;
}

const PROJECTILE_CURRICULA = new Set(["projectile_evasion", "impact_recovery"]);

const CURRICULUM_OBJECTIVES: Record<string, string> = {
  balance: "Stay upright and keep center of mass over both feet",
  footwork: "Cross the ring from one rope to the opposite rope under neural control",
  moving_strikes: "Throw complete punches while advancing, retreating, and circling",
  projectile_evasion: "See incoming reflex balls and move clear without losing balance",
  impact_recovery: "Absorb physical impacts, recover the base, and stay standing",
  scripted_defense: "Read attacks and defend without losing position",
  self_play: "Integrate locomotion, defense, and striking against a learned rival",
};

export function Native3dViewer({
  available,
  status,
  targetName,
  curriculum,
  episodeSeconds,
  generation,
  episodes,
  coachFocus,
  evaluationGate,
}: Native3dViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const framesRef = useRef<PoseFrame[]>([]);
  const activeReplayIdRef = useRef<number | null>(null);
  const activeEndReasonRef = useRef<ReplayPayload["endReason"]>("waiting");
  const pendingReplayRef = useRef<ReplayBuffer | null>(null);
  const frameIndexRef = useRef(0);
  const playheadRef = useRef(0);
  const holdUntilRef = useRef(0);
  const playingRef = useRef(true);
  const curriculumRef = useRef(curriculum);
  const cameraRef = useRef<CameraState>({ ...CAMERA_DEFAULT });
  const manualCameraRef = useRef(false);
  const effectsRef = useRef<SceneEffects>(createEffects());
  const labelsRef = useRef({ blue: targetName, red: "Rival" });
  const episodeSecondsRef = useRef(episodeSeconds);
  const dragRef = useRef({ active: false, x: 0, y: 0 });
  const [playing, setPlaying] = useState(true);
  const [autoCamera, setAutoCamera] = useState(true);
  const [replayState, setReplayState] = useState<"waiting" | "ready" | "error">("waiting");
  const [frameStats, setFrameStats] = useState({
    time: 0,
    frames: 0,
    blueForce: 0,
    redForce: 0,
    stamina: 1,
    guardStability: 1,
    equilibrium: 1,
    activeControl: 1,
    jointFatigue: 0,
    impactEnergy: 0,
    impactVelocity: 0,
    effectiveMass: 0,
    impactZone: "none",
    strikeKind: "none",
    rotationalImpulse: 0,
    neurologicalLoad: 0,
    powerShot: false,
    knockout: false,
    knockoutCause: "none",
    projectileHits: 0,
    projectileDodges: 0,
    projectileDeflections: 0,
    projectileImpulse: 0,
    projectileForce: 0,
    projectileSpeed: 0,
    endReason: "waiting" as ReplayPayload["endReason"],
  });
  const isSoloCurriculum = SOLO_CURRICULA.has(curriculum);
  const isProjectileCurriculum = PROJECTILE_CURRICULA.has(curriculum);
  const objective = CURRICULUM_OBJECTIVES[curriculum] ?? "Develop the current physical skill";
  const isRingCrossing = curriculum === "footwork";
  const evaluationLabel = isRingCrossing
    && typeof evaluationGate?.commanded_distance === "number"
    && typeof evaluationGate.minimum_commanded_distance === "number"
    ? `${evaluationGate.commanded_distance.toFixed(1)} / ${evaluationGate.minimum_commanded_distance.toFixed(1)} m`
    : typeof evaluationGate?.upright_seconds === "number"
      && typeof evaluationGate.minimum_upright_seconds === "number"
      ? `${evaluationGate.upright_seconds.toFixed(1)} / ${evaluationGate.minimum_upright_seconds.toFixed(1)} s`
      : "Measuring";
  const gateState = evaluationGate?.accepted
    ? "verified"
    : evaluationGate?.learning_advanced
      ? "brain updated"
      : "searching";

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    curriculumRef.current = curriculum;
  }, [curriculum]);

  useEffect(() => {
    labelsRef.current = { blue: targetName, red: "Rival" };
    episodeSecondsRef.current = episodeSeconds;
  }, [targetName, episodeSeconds]);

  useEffect(() => {
    if (!available) {
      framesRef.current = [];
      activeReplayIdRef.current = null;
      pendingReplayRef.current = null;
      const resetTimer = window.setTimeout(() => setReplayState("waiting"), 0);
      return () => window.clearTimeout(resetTimer);
    }
    let mounted = true;
    let timer = 0;
    const poll = async () => {
      try {
        const response = await fetch("/api/sim3d/replay?frames=180", { cache: "no-store" });
        const payload = await response.json() as ReplayPayload;
        if (!response.ok || !payload.available || !Array.isArray(payload.frames)) {
          throw new Error("Replay unavailable.");
        }
        if (mounted) {
          const completed = payload.replayId > 0
            && payload.endReason !== "waiting"
            && payload.frames.length > 1;
          if (!completed) {
            setReplayState("waiting");
            return;
          }
          const replay: ReplayBuffer = {
            id: payload.replayId,
            endReason: payload.endReason,
            curriculum: payload.curriculum,
            frames: payload.frames,
          };
          if (activeReplayIdRef.current === null || !framesRef.current.length) {
            framesRef.current = replay.frames;
            activeReplayIdRef.current = replay.id;
            activeEndReasonRef.current = replay.endReason;
            curriculumRef.current = replay.curriculum;
            frameIndexRef.current = 0;
            playheadRef.current = replay.frames[0]?.time ?? 0;
            holdUntilRef.current = 0;
          } else if (replay.id !== activeReplayIdRef.current) {
            pendingReplayRef.current = replay;
          }
          setReplayState("ready");
        }
      } catch {
        if (mounted) setReplayState("error");
      } finally {
        if (mounted) timer = window.setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [available]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let animationFrame = 0;
    let lastTime = performance.now();
    let width = 0;
    let height = 0;

    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    resize();

    const render = (time: number) => {
      const frames = framesRef.current;
      if (playingRef.current && frames.length > 1) {
        if (frameIndexRef.current < frames.length - 1) {
          playheadRef.current += Math.min(100, time - lastTime) / 1000;
          while (
            frameIndexRef.current < frames.length - 1
            && frames[frameIndexRef.current + 1].time <= playheadRef.current
          ) {
            frameIndexRef.current += 1;
          }
          holdUntilRef.current = 0;
        } else {
          if (!holdUntilRef.current) {
            holdUntilRef.current = time + (activeEndReasonRef.current === "fall" ? 1500 : 900);
          }
          const pending = pendingReplayRef.current;
          if (pending && time >= holdUntilRef.current) {
            framesRef.current = pending.frames;
            activeReplayIdRef.current = pending.id;
            activeEndReasonRef.current = pending.endReason;
            curriculumRef.current = pending.curriculum;
            pendingReplayRef.current = null;
            frameIndexRef.current = 0;
            playheadRef.current = pending.frames[0]?.time ?? 0;
            holdUntilRef.current = 0;
          }
        }
      }
      lastTime = time;
      const frame = frames[frameIndexRef.current] ?? null;
      if (!manualCameraRef.current) {
        cameraRef.current = easeCamera(
          cameraRef.current,
          arcadeCamera(frame, curriculumRef.current),
          0.09,
        );
      }
      trackImpacts(effectsRef.current, frame, time);
      drawWorld(
        context,
        width,
        height,
        frame,
        cameraRef.current,
        curriculumRef.current,
        effectsRef.current,
        labelsRef.current,
        episodeSecondsRef.current,
        activeEndReasonRef.current,
        time,
      );
      animationFrame = window.requestAnimationFrame(render);
    };
    animationFrame = window.requestAnimationFrame(render);
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const frames = framesRef.current;
      const frame = frames[frameIndexRef.current];
      const blue = frame?.contacts?.blue.groundForces;
      const red = frame?.contacts?.red.groundForces;
      const physiology = frame?.physiology?.blue;
      const impact = frame?.impacts?.blue;
      const projectile = frame?.projectileDrill?.blue;
      setFrameStats({
        time: frame?.time ?? 0,
        frames: frames.length,
        blueForce: (blue?.left ?? 0) + (blue?.right ?? 0),
        redForce: (red?.left ?? 0) + (red?.right ?? 0),
        stamina: physiology?.stamina ?? 1,
        guardStability: physiology?.guardStability ?? 1,
        equilibrium: physiology?.equilibrium ?? 1,
        activeControl: physiology?.activeControl ?? 1,
        jointFatigue: physiology?.jointFatigue ?? 0,
        impactEnergy: (impact?.head_energy_j ?? 0) + (impact?.body_energy_j ?? 0),
        impactVelocity: impact?.closing_velocity_mps ?? 0,
        effectiveMass: impact?.effective_mass_kg ?? 0,
        impactZone: impact?.anatomical_zone ?? "none",
        strikeKind: impact?.strike_kind ?? "none",
        rotationalImpulse: impact?.rotational_impulse_nms ?? 0,
        neurologicalLoad: physiology?.neurologicalLoad ?? 0,
        powerShot: impact?.power_shot ?? false,
        knockout: physiology?.knockout ?? false,
        knockoutCause: physiology?.knockoutCause ?? "none",
        projectileHits: projectile?.hits ?? 0,
        projectileDodges: projectile?.dodges ?? 0,
        projectileDeflections: projectile?.deflections ?? 0,
        projectileImpulse: projectile?.hit_impulse_ns ?? 0,
        projectileForce: projectile?.peak_force_n ?? 0,
        projectileSpeed: projectile?.incoming_speed_mps ?? 0,
        endReason: activeEndReasonRef.current,
      });
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  function takeManualCamera() {
    manualCameraRef.current = true;
    setAutoCamera(false);
  }

  function releaseManualCamera() {
    manualCameraRef.current = false;
    setAutoCamera(true);
  }

  function startOrbit(event: PointerEvent<HTMLCanvasElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
  }

  function orbit(event: PointerEvent<HTMLCanvasElement>) {
    if (!dragRef.current.active) return;
    takeManualCamera();
    const deltaX = event.clientX - dragRef.current.x;
    const deltaY = event.clientY - dragRef.current.y;
    cameraRef.current.yaw -= deltaX * 0.007;
    cameraRef.current.pitch = Math.max(-0.08, Math.min(1.18, cameraRef.current.pitch + deltaY * 0.006));
    dragRef.current = { active: true, x: event.clientX, y: event.clientY };
  }

  function endOrbit(event: PointerEvent<HTMLCanvasElement>) {
    dragRef.current.active = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function zoom(event: WheelEvent<HTMLCanvasElement>) {
    event.preventDefault();
    takeManualCamera();
    cameraRef.current.distance = Math.max(3.2, Math.min(12, cameraRef.current.distance + event.deltaY * 0.006));
  }

  return (
    <section className="native-viewer" id="native-physics" aria-label="Native three-dimensional training world">
      <div className="native-viewer__heading">
        <div>
          <span className="eyebrow">Live MuJoCo policy rollout</span>
          <strong>Native 3D training world</strong>
        </div>
        <div className="native-viewer__controls">
          <span className={`loop-state loop-state--${status}`}>{available ? status : "not connected"}</span>
          <button className="button button--quiet" type="button" onClick={() => setPlaying((current) => !current)} disabled={!frameStats.frames}>
            {playing ? "Freeze replay" : "Play replay"}
          </button>
          <button className={`button button--quiet ${autoCamera ? "button--blue" : ""}`} type="button" onClick={releaseManualCamera}>
            {autoCamera ? "Fight camera" : "Free camera"}
          </button>
        </div>
      </div>
      <div className="native-viewer__objective">
        <span>{isProjectileCurriculum ? "Perception / impact curriculum" : isSoloCurriculum ? "Solo motor curriculum" : "Contact curriculum"}</span>
        <strong>{objective}</strong>
        <small>
          {`Coach: ${coachFocus.replaceAll("_", " ")} · `}
          {curriculum === "projectile_evasion"
            ? `Delayed, noisy ball sightings enter recurrent memory · no supplied velocity, direction, target, or future trajectory · ${episodeSeconds.toFixed(0)} s horizon`
            : curriculum === "impact_recovery"
              ? `Physical padded-ball impulse · active muscle recovery · ${episodeSeconds.toFixed(0)} s horizon`
              : isSoloCurriculum
                ? `No punches, damage, or opponent rewards · active muscle control · ${episodeSeconds.toFixed(0)} s horizon`
                : `Active ragdoll · adaptive strike IK · momentum contacts · ${episodeSeconds.toFixed(0)} s horizon`}
        </small>
      </div>
      <div className="native-viewer__viewport">
        <canvas
          ref={canvasRef}
          onPointerDown={startOrbit}
          onPointerMove={orbit}
          onPointerUp={endOrbit}
          onPointerCancel={endOrbit}
          onDoubleClick={releaseManualCamera}
          onWheel={zoom}
          role="img"
          aria-label={isProjectileCurriculum
            ? "Perspective view of one articulated MuJoCo athlete reacting to physical incoming reflex balls"
            : isSoloCurriculum
              ? "Perspective view of one articulated MuJoCo athlete learning a solo motor skill with contact-force vectors"
              : "Perspective view of two articulated MuJoCo athletes and their contact-force vectors inside a boxing ring"}
        >
          Live 3D pose replay for the native boxing simulator.
        </canvas>
        <div className="native-viewer__legend" aria-hidden="true">
          <span><i className="native-viewer__swatch native-viewer__swatch--blue" /> {targetName}</span>
          {!isSoloCurriculum ? <span><i className="native-viewer__swatch native-viewer__swatch--red" /> Curriculum partner</span> : null}
          {isProjectileCurriculum ? <span><i className="native-viewer__swatch native-viewer__swatch--projectile" /> Physical reflex ball</span> : null}
          <span><i className="native-viewer__swatch native-viewer__swatch--force" /> Ground force / center of mass</span>
        </div>
        {replayState !== "ready" ? (
          <div className="native-viewer__empty">
            <strong>{replayState === "error" ? "Replay link interrupted" : available ? "Waiting for a completed rollout" : "Native simulator not connected"}</strong>
            <small>{available ? "Training can continue while the next physical episode is prepared." : "Start the local MuJoCo service to expose articulated poses."}</small>
          </div>
        ) : null}
      </div>
      <div className="native-viewer__telemetry" aria-live="polite">
        <span><small>Skill / generation</small><strong>{curriculum.replaceAll("_", " ")} · G{generation} · {gateState}</strong></span>
        <span><small>{isRingCrossing ? "Ring crossing / episodes" : "Upright gate / episodes"}</small><strong>{evaluationLabel} · {episodes}</strong></span>
        <span><small>Stamina / joint fatigue</small><strong>{(frameStats.stamina * 100).toFixed(0)}% / {(frameStats.jointFatigue * 100).toFixed(0)}%</strong></span>
        <span><small>{isSoloCurriculum ? "Muscle control / equilibrium" : "Guard stability / equilibrium"}</small><strong>{((isSoloCurriculum ? frameStats.activeControl : frameStats.guardStability) * 100).toFixed(0)}% / {(frameStats.equilibrium * 100).toFixed(0)}%</strong></span>
        <span>
          <small>{curriculum === "projectile_evasion" ? "Dodged / deflected / hit · speed" : curriculum === "impact_recovery" ? "Ball force / impulse / speed" : isSoloCurriculum ? "Ground reaction" : "Effective mass / speed / energy"}</small>
          <strong>
            {curriculum === "projectile_evasion"
              ? `${frameStats.projectileDodges} / ${frameStats.projectileDeflections} / ${frameStats.projectileHits} · ${frameStats.projectileSpeed.toFixed(1)} m/s`
              : curriculum === "impact_recovery"
                ? `${frameStats.projectileForce.toFixed(0)} N / ${frameStats.projectileImpulse.toFixed(1)} Ns / ${frameStats.projectileSpeed.toFixed(1)} m/s`
                : isSoloCurriculum
                  ? `${frameStats.blueForce.toFixed(0)} N`
                  : `${frameStats.effectiveMass.toFixed(1)} kg / ${frameStats.impactVelocity.toFixed(1)} m/s / ${frameStats.impactEnergy.toFixed(0)} J`}
          </strong>
        </span>
        {!isSoloCurriculum ? (
          <span>
            <small>Contact anatomy / rotational load</small>
            <strong>
              {frameStats.impactZone === "none"
                ? "No glove contact"
                : `${frameStats.powerShot ? "POWER " : ""}${frameStats.strikeKind.toUpperCase()} · ${frameStats.impactZone.replaceAll("_", " ")} / ${frameStats.rotationalImpulse.toFixed(2)} N·m·s`}
            </strong>
          </span>
        ) : null}
        <span>
          <small>Replay / episode end</small>
          <strong>
            {frameStats.time.toFixed(2)} s / {frameStats.knockout ? `KO · ${frameStats.knockoutCause}` : frameStats.endReason}
          </strong>
        </span>
      </div>
    </section>
  );
}
