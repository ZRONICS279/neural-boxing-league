"use client";

import { BOXING_MODEL, neuralInfluence } from "./fight-model";

/** The pictures on the long read.
 *
 * Where a figure states a number the simulation owns, it reads the constant
 * rather than restating it, so it cannot quietly disagree with the engine. All
 * of them are inline SVG on the page's own colour tokens, because a figure that
 * does not follow the theme reads as an embed rather than part of the page. */

/* ------------------------------------------------------------- the network */

/** Evenly spaced dot centres for one layer of the diagram. */
function column(count: number, top: number, bottom: number) {
  if (count === 1) return [(top + bottom) / 2];
  const step = (bottom - top) / (count - 1);
  return Array.from({ length: count }, (_, index) => top + index * step);
}

interface Layer {
  x: number;
  /** How many dots are drawn — a shape, not a count. */
  shown: number;
  label: string;
  caption: string;
  colour: string;
}

/** The policy, drawn as a shape rather than a spec sheet.
 *
 * The dot counts are illustrative, deliberately — the page does not publish the
 * real layer sizes. The loop on the memory column is the whole reason this
 * network is worth drawing at all. */
export function NetworkFigure() {
  const layers: Layer[] = [
    {
      x: 44,
      shown: 9,
      label: "READ",
      caption: "the fight",
      colour: "var(--blue)",
    },
    {
      x: 148,
      shown: 8,
      label: "THINK",
      caption: "his own brain",
      colour: "var(--muted)",
    },
    {
      x: 252,
      shown: 7,
      label: "REMEMBER",
      caption: "past experience",
      colour: "var(--amber)",
    },
    {
      x: 356,
      shown: 6,
      label: "DECIDE",
      caption: "his own plan",
      colour: "var(--green)",
    },
    {
      x: 452,
      shown: 9,
      label: "ACT",
      caption: "commit to it",
      colour: "var(--red)",
    },
  ];

  const dots = layers.map((layer) => column(layer.shown, 46, 214));

  return (
    <svg className="how-fig__svg" viewBox="0 0 496 268" role="img" aria-label="A custom neural brain reading the fight, remembering experience, making a decision, and acting on it">
      {/* Everything to everything, faint enough to read as texture. */}
      {dots.slice(0, -1).map((from, index) =>
        from.map((y1) =>
          dots[index + 1].map((y2) => (
            <line
              key={`${index}-${y1}-${y2}`}
              className="how-fig__link"
              x1={layers[index].x + 5}
              y1={y1}
              x2={layers[index + 1].x - 5}
              y2={y2}
              stroke="var(--line)"
              strokeWidth="0.5"
              opacity="0.5"
            />
          )),
        ),
      )}

      {/* The recurrence: memory feeding tonight's cells back into the next tick. */}
      <path
        d="M252 26 C 300 8, 300 8, 300 46 L 300 214 C 300 250, 300 250, 252 234"
        fill="none"
        stroke="var(--amber)"
        strokeWidth="1.1"
        strokeDasharray="3 3"
        opacity="0.75"
      />
      {/* A quiet patch keeps the annotation legible without letting its second
          line run into the nearest decision node. */}
      <rect x="302" y="112" width="49" height="32" fill="var(--panel-low)" opacity="0.94" />
      <text x="306" y="125" className="how-fig__tick" textAnchor="start" fill="var(--amber)">
        carried
      </text>
      <text x="306" y="137" className="how-fig__tick" textAnchor="start" fill="var(--amber)">
        forward
      </text>

      {layers.map((layer, index) => (
        <g key={layer.label}>
          {dots[index].map((y) => (
            <circle
              key={y}
              cx={layer.x}
              cy={y}
              r="4"
              fill="var(--panel-low)"
              stroke={layer.colour}
              strokeWidth="1.4"
            />
          ))}
          <text x={layer.x} y="246" className="how-fig__tick" textAnchor="middle" fill={layer.colour}>
            {layer.label}
          </text>
          <text x={layer.x} y="260" className="how-fig__note" textAnchor="middle">
            {layer.caption}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* ------------------------------------------------------------------- lag */

/** A punch and the reaction window it leaves, shown on the same axis. */
export function LagFigure() {
  const ms = (value: number) => 20 + (value / 340) * 372;

  const rows: { y: number; label: string; to: number; colour: string; note: string }[] = [
    { y: 44, label: "EARLY TELL", to: 70, colour: "var(--amber)", note: "the shoulder and weight shift first" },
    { y: 98, label: "FAST JAB", to: 138, colour: "var(--red)", note: "hand leaves, punch lands" },
    { y: 152, label: "QUICK REACTION", to: 200, colour: "var(--blue)", note: "the fastest athletes can respond" },
    { y: 206, label: "SLOWER REACTION", to: 300, colour: "var(--muted)", note: "anticipation matters even more here" },
  ];

  return (
    <svg className="how-fig__svg" viewBox="0 0 480 262" role="img" aria-label="A timeline showing the early tell, a fast jab landing, and the reaction windows available to quicker and slower athletes">
      {[0, 100, 200, 300].map((tick) => (
        <g key={tick}>
          <line x1={ms(tick)} y1="16" x2={ms(tick)} y2="228" stroke="var(--line-soft)" strokeWidth="1" />
          <text x={ms(tick)} y="244" className="how-fig__tick" textAnchor="middle">
            {tick}
          </text>
        </g>
      ))}
      <text x="464" y="244" className="how-fig__note" textAnchor="end">
        milliseconds
      </text>

      {/* Where the jab has already landed — everything to the right of this line
          is a fighter reacting to something that is over. */}
      <line x1={ms(138)} y1="16" x2={ms(138)} y2="228" stroke="var(--red)" strokeWidth="1" strokeDasharray="2 3" opacity="0.6" />

      {rows.map((row) => (
        <g key={row.label}>
          <text x={ms(0)} y={row.y - 12} className="how-fig__tick" textAnchor="start" fill={row.colour}>
            {row.label}
          </text>
          <rect
            className="how-fig__bar"
            x={ms(0)}
            y={row.y - 6}
            width={ms(row.to) - ms(0)}
            height="14"
            fill={row.colour}
            opacity="0.24"
          />
          <line x1={ms(row.to)} y1={row.y - 9} x2={ms(row.to)} y2={row.y + 11} stroke={row.colour} strokeWidth="2" />
          <text x={ms(row.to) + 7} y={row.y + 5} className="how-fig__label" textAnchor="start" fill={row.colour}>
            {row.to}
          </text>
          <text x={ms(0)} y={row.y + 24} className="how-fig__note" textAnchor="start">
            {row.note}
          </text>
        </g>
      ))}
    </svg>
  );
}

/* --------------------------------------------------------------- the dial */

/** The influence dial against a career, with a real athlete standing on it.
 *
 * `neuralInfluence` is the actual function, sampled — so the curve bends exactly
 * the way the fight does. */
export function InfluenceFigure({
  learned,
  name,
}: {
  learned: number | null;
  name: string | null;
}) {
  const maxDecisions = 120_000;
  const x = (decisions: number) => 46 + (Math.min(decisions, maxDecisions) / maxDecisions) * 402;
  // The dial runs from its floor to floor + range; 130% is a hair of headroom
  // above the ceiling so the curve does not graze the top of the frame.
  const y = (share: number) => 178 - (share / 1.3) * 152;

  const path = Array.from({ length: 81 }, (_, step) => {
    const decisions = (step / 80) * maxDecisions;
    const share = neuralInfluence({ learnedDecisions: decisions });
    return `${step === 0 ? "M" : "L"}${x(decisions).toFixed(1)} ${y(share).toFixed(1)}`;
  }).join(" ");

  const here = learned === null ? null : neuralInfluence({ learnedDecisions: learned });

  return (
    <svg className="how-fig__svg" viewBox="0 0 480 232" role="img" aria-label="The influence of a fighter's neural brain rising with credited decisions">
      {[30, 60, 90, 120].map((percent) => (
        <g key={percent}>
          <line x1="46" y1={y(percent / 100)} x2="448" y2={y(percent / 100)} stroke="var(--line-soft)" strokeWidth="1" />
          <text x="40" y={y(percent / 100) + 4} className="how-fig__tick" textAnchor="end">
            {percent}%
          </text>
        </g>
      ))}

      <path d={`${path} L448 178 L46 178 Z`} fill="var(--amber)" opacity="0.07" />
      <path className="how-fig__draw" d={path} pathLength="1" fill="none" stroke="var(--amber)" strokeWidth="2" />

      <circle cx={x(0)} cy={y(neuralInfluence({ learnedDecisions: 0 }))} r="4" fill="var(--muted)" />
      {/* Suppressed when the live marker is sitting on top of it, which is where
          a league only a few nights old puts its deepest brain. */}
      {learned === null || learned > maxDecisions * 0.09 ? (
        <text x={x(0) + 9} y={y(neuralInfluence({ learnedDecisions: 0 })) + 14} className="how-fig__note" textAnchor="start">
          debut
        </text>
      ) : null}

      {here !== null && learned !== null ? (
        <g>
          <line x1={x(learned)} y1={y(here)} x2={x(learned)} y2="178" stroke="var(--blue)" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={x(learned)} cy={y(here)} r="5" fill="var(--blue)" />
          {/* Under the dot, not over it — above the marker is where the curve
              itself runs, and a label sitting on the line is unreadable. */}
          <text
            x={Math.min(x(learned) + 11, 296)}
            y={y(here) + 16}
            className="how-fig__label"
            textAnchor="start"
            fill="var(--blue)"
          >
            {name}
          </text>
          <text
            x={Math.min(x(learned) + 11, 296)}
            y={y(here) + 29}
            className="how-fig__note"
            textAnchor="start"
          >
            {Math.round(here * 100)}% · {learned.toLocaleString()} credited decisions
          </text>
        </g>
      ) : null}

      <line x1="46" y1="178" x2="448" y2="178" stroke="var(--line)" strokeWidth="1" />
      {[0, 30_000, 60_000, 90_000, 120_000].map((decisions) => (
        <text key={decisions} x={x(decisions)} y="196" className="how-fig__tick" textAnchor="middle">
          {decisions === 0 ? "0" : `${decisions / 1000}k`}
        </text>
      ))}
      <text x="247" y="216" className="how-fig__note" textAnchor="middle">
        credited decisions
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------- the ledger */

/** Credit assignment, drawn as the thing it is: one bar per decision, sized by
 *  how much better or worse his position got in the tick after it.
 *  The shape is hand-picked to read as a plausible exchange — a jab that opens a
 *  man up, the right hand it paid for, a lazy step, the hook that billed him. */
const EXCHANGE: { delta: number; note?: string }[] = [
  { delta: 0.18, note: "jab" },
  { delta: 0.06 },
  { delta: 0.52, note: "right hand" },
  { delta: 0.11 },
  { delta: -0.09 },
  { delta: -0.44, note: "lazy step" },
  { delta: -0.62, note: "hook taken" },
  { delta: -0.12 },
  { delta: 0.21 },
  { delta: 0.35, note: "back on it" },
];

export function LedgerFigure() {
  const width = 448;
  const slot = width / EXCHANGE.length;
  const mid = 96;

  return (
    <svg className="how-fig__svg" viewBox="0 0 480 208" role="img" aria-label="A sequence of decisions rewarded or penalised according to what happened next">
      <line x1="16" y1={mid} x2="464" y2={mid} stroke="var(--line)" strokeWidth="1" />
      <text x="16" y="20" className="how-fig__tick" textAnchor="start" fill="var(--green)">
        REWARDED
      </text>
      <text x="16" y="192" className="how-fig__tick" textAnchor="start" fill="var(--red)">
        PENALISED
      </text>

      {EXCHANGE.map((entry, index) => {
        const height = Math.abs(entry.delta) * 116;
        const up = entry.delta >= 0;
        return (
          <g key={index}>
            <rect
              x={16 + index * slot + slot * 0.22}
              y={up ? mid - height : mid}
              width={slot * 0.56}
              height={height}
              fill={up ? "var(--green)" : "var(--red)"}
              opacity="0.78"
            />
            {entry.note ? (
              <text
                x={16 + index * slot + slot / 2}
                y={up ? mid - height - 6 : mid + height + 13}
                className="how-fig__note"
                textAnchor="middle"
              >
                {entry.note}
              </text>
            ) : null}
          </g>
        );
      })}

      <text x="240" y="204" className="how-fig__tick" textAnchor="middle">
        ONE SECOND · {Math.round(1 / BOXING_MODEL.physicsStepSeconds)} DECISIONS · BOTH FIGHTERS LEARN
      </text>
    </svg>
  );
}
