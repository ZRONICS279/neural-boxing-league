"use client";

import { REPLAY_SPEEDS, type ArchivedFight } from "./archive";
import { useRewatch } from "./archive-store";
import { BoutTale, FightStage } from "./fight-stage";
import { BOXING_MODEL, type Fighter } from "./fight-model";
import { formatClock } from "./site-chrome";

/** A fight that is over, watched again.
 *
 * The same stage the live broadcast draws on, fed by the same recording — the
 * fight was captured once, server-side, as the chunks that aired, and a rewatch
 * plays those back frame for frame. Nothing that could rebuild the fight — no
 * seed, no policies — ever reaches this side of the wire.
 *
 * Which is also why the transport can do things a live bout's cannot. A
 * broadcast is pinned to a clock everybody shares, so there is no pausing it and
 * no running it fast. A rewatch belongs to one person, so it pauses, restarts,
 * and runs up to twelve times over — a three-round fight in well under a
 * minute — without any of that meaning anything to anybody else. */
export function FightReplay({
  fight,
  blue,
  red,
}: {
  fight: ArchivedFight;
  blue: Fighter;
  red: Fighter;
}) {
  const rewatch = useRewatch(fight);
  const winner = fight.winnerId === blue.id ? blue : fight.winnerId === red.id ? red : null;

  return (
    <>
      <div className="replay-bar">
        <div className="replay-bar__transport">
          <button
            type="button"
            className="replay-bar__play"
            onClick={() => (rewatch.playing ? rewatch.pause() : rewatch.play())}
          >
            <span aria-hidden="true">{rewatch.playing ? "❙❙" : "▶"}</span>
            {rewatch.playing ? "Pause" : rewatch.ended ? "Watch again" : "Play"}
          </button>
          <button type="button" className="replay-bar__restart" onClick={rewatch.restart}>
            <span aria-hidden="true">↺</span>
            From the bell
          </button>
        </div>

        {/* Not a scrubber. Seeking backwards means rebuilding the fight from
            the opening bell, which is fast but is not what a dragged thumb
            promises, and a bar that only moves one way is an honest bar. */}
        <div className="replay-bar__track" role="presentation">
          <span
            className="replay-bar__fill"
            style={{ width: `${Math.round(rewatch.progress * 100)}%` }}
          />
        </div>

        <span className="replay-bar__clock">
          R{rewatch.bout?.round ?? 1}/{fight.totalRounds} ·{" "}
          {rewatch.bout && rewatch.bout.breakTime > 0
            ? "Corner"
            : formatClock(rewatch.bout?.roundTime ?? BOXING_MODEL.roundSeconds)}
        </span>

        <div className="replay-bar__speeds" role="group" aria-label="Replay speed">
          {REPLAY_SPEEDS.map((speed) => (
            <button
              key={speed}
              type="button"
              className="replay-bar__speed"
              aria-pressed={rewatch.speed === speed}
              onClick={() => rewatch.setSpeed(speed)}
            >
              {speed}×
            </button>
          ))}
        </div>
      </div>

      {rewatch.bout ? (
        <FightStage
          bout={rewatch.bout}
          frames={rewatch.frames}
          voice={rewatch.voice}
          blue={blue}
          red={red}
          winnerName={winner?.lastName ?? null}
          playbackRate={rewatch.speed}
          panels={false}
          verdict={rewatch.ended ? (
            <div className="bout-final" role="status" aria-live="polite">
              <span className="bout-final__label">Final</span>
              <strong className="bout-final__winner">
                {winner ? `${winner.firstName} ${winner.lastName}` : "Draw"}
              </strong>
              <span className="bout-final__method">
                {fight.finish === "Decision" || fight.finish === "Draw"
                  ? `by ${fight.finish.toLowerCase()} after ${fight.totalRounds} rounds`
                  : `by ${fight.finish} in round ${fight.round}`}
              </span>
              <BoutTale bout={rewatch.bout} blue={blue} red={red} />
            </div>
          ) : null}
        />
      ) : (
        <div className="broadcast__waiting" role="status">
          <strong>Loading the fight</strong>
          <small>Starting from the opening bell.</small>
        </div>
      )}
    </>
  );
}
