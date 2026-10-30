"use client";

import Link from "next/link";
import { useBroadcast } from "./broadcast-store";
import { neuralInfluence } from "./fight-model";
import { SiteFooter, SiteHeader, Ticker, recordLabel } from "./site-chrome";
import { WalletConnect } from "./wallet-button";
import { InfluenceFigure, LagFigure, NetworkFigure } from "./how-it-works-figures";

/** The long read.
 *
 * Six chapters at full page width, each the same shape: number and title in
 * the first column, prose in the second, a picture (or a second column of
 * prose) in the third, so a chapter is about one screen tall. It explains the
 * league in boxing English and keeps the machinery out of it: what a fighter
 * senses, chooses and learns, not how the engine is put together. */

function Figure({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <figure className="how-fig">
      <div className="how-fig__viewport">
        {children}
      </div>
      <figcaption>{caption}</figcaption>
    </figure>
  );
}

function Chapter({
  number,
  title,
  colour,
  children,
}: {
  number: string;
  title: string;
  colour: "blue" | "red" | "amber" | "green";
  children: React.ReactNode;
}) {
  return (
    <section className={`how-chapter how-chapter--${colour}`} aria-label={title}>
      <header className="how-chapter__head">
        <span className="how-chapter__number" aria-hidden="true">{number}</span>
        <h2>{title}</h2>
      </header>
      {children}
    </section>
  );
}

export function HowItWorks() {
  const { feed, roster, status, paused } = useBroadcast();
  const live = feed?.live ?? null;
  const leader = roster.length > 0
    ? roster.reduce((best, fighter) =>
        fighter.policy.learnedDecisions > best.policy.learnedDecisions ? fighter : best,
      )
    : null;
  const leaderShare = leader ? neuralInfluence(leader.policy) : null;

  return (
    <div className="page">
      <SiteHeader
        calendar={{ season: feed?.season ?? 1, week: feed?.week ?? 1 }}
        active="/how-it-works"
        status={{
          label:
            status === "offline"
              ? "Broadcast offline"
              : live
                ? paused ? "Broadcast paused" : "Bout in progress"
                : "Between fights",
          detail: `${roster.length} athletes · ${(feed?.boutsCompleted ?? 0).toLocaleString()} bouts on record`,
        }}
        action={<WalletConnect roster={roster} />}
      />

      <main className="page__body how-page">
        <section className="how-head" aria-label="How it works">
          {/* The same two corners the masthead and the homepage hero wear. */}
          <span className="home-hero__blue" aria-hidden="true" />
          <span className="home-hero__red" aria-hidden="true" />
          <Link className="how-head__back" href="/">Home</Link>
          <h1>How Forge<br />League works</h1>
          <p>
            Forge League is a live boxing league where every fighter is run by a neural
            network of his own. Nobody writes the fights. Each athlete reads the man in
            front of him, picks his own punches, and keeps what he learns from one fight
            to the next. This page goes through how that works.
          </p>
        </section>

        <Chapter number="01" title="Every fighter has his own brain" colour="blue">
          <div className="how-prose">
            <p className="how-lead">
              There is one neural network for every athlete on the roster, and it is
              his for his whole career. It is not shared with anyone else and it is
              not reset between fights.
            </p>
            <p>
              A new fighter is raw. Training and fights nudge that network a little
              at a time, and after enough of them a style starts to show. One settles
              into counterpunching because that is what kept paying off for him.
              Another learns to walk people down. Nobody chose those styles for them.
            </p>
          </div>
          <Figure caption="What his brain does on every step of a fight. Read what is in front of him, weigh it against what he remembers, decide, then throw.">
            <NetworkFigure />
          </Figure>
        </Chapter>

        <Chapter number="02" title="Seeing the punch coming" colour="red">
          <div className="how-prose">
            <p className="how-lead">
              A fast jab lands in about 140 milliseconds. The quickest fighters need
              around 200 to react to the glove once it is moving, so anyone who waits
              for the punch itself is already late.
            </p>
            <p>
              What he can react to is the setup. The shoulder turns and the weight
              shifts before the hand goes, and those tells arrive early enough to do
              something about. A fighter who reads them can slip or block. One who
              misses them eats the shot. That is where speed, anticipation and a bit
              of homework on the opponent actually count.
            </p>
            <p>
              What he does with the read depends on the rest of him: how much power,
              speed and reach he has, how much is left in the tank by the later
              rounds, and how his style matches up with the man across from him.
            </p>
          </div>
          <Figure caption="The same jab on one clock. Everything to the right of the red line is a reaction to a punch that has already landed.">
            <LagFigure />
          </Figure>

          <div className="how-aside">
            <h3>What you see and what is underneath it</h3>
            <div className="how-prose">
              <p>
                The fight you watch is drawn flat, like an arcade game, because that is
                the easiest thing to follow. Underneath, it is worked out in three
                dimensions. Each athlete has his real reach, weight, balance and
                momentum, and every punch travels a path through space. Whether it
                lands clean, glances, gets blocked or misses depends on where both men
                are, the angle, the speed and the timing. Only once that is settled
                does the flat picture get drawn.
              </p>
            </div>
          </div>
        </Chapter>

        <Chapter number="03" title="How a brain takes over" colour="amber">
          <div className="how-prose">
            <p className="how-lead">
              A brand new athlete is not thrown in on his network alone. He starts on
              a set of boxing fundamentals the whole roster shares, enough to keep his
              hands up and throw straight. From his first fight the network is making
              real choices alongside that, and it gets credit or blame for how each
              one turns out.
            </p>
            <p>
              The more decisions it has been credited with, the more of the fight it
              is handed. On debut it has about 30 percent of the say. Around 25,000
              decisions in it is running three quarters, and given a long enough
              career it runs all of it. By then everything you see him do came from
              what he learned himself.
            </p>
          </div>
          <Figure caption="This chart is live and moves as the roster trains and fights. Every decision on the line was made in a real round.">
            <InfluenceFigure
              learned={leader?.policy.learnedDecisions ?? null}
              name={leader ? `${leader.firstName} ${leader.lastName}` : null}
            />
          </Figure>

          {leader && leaderShare !== null ? (
            <div className="how-leader">
              <div>
                <span>Furthest along right now</span>
                <strong>{leader.firstName} {leader.lastName}</strong>
              </div>
              <dl>
                <div>
                  <dt>Record</dt>
                  <dd>{recordLabel(leader)}</dd>
                </div>
                <div>
                  <dt>Decisions learned</dt>
                  <dd>{leader.policy.learnedDecisions.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>Share of the fight</dt>
                  <dd>{Math.round(leaderShare * 100)}%</dd>
                </div>
              </dl>
            </div>
          ) : (
            <div className="how-leader how-leader--waiting">
              <span>Loading the roster</span>
            </div>
          )}
        </Chapter>

        <Chapter number="04" title="Between rounds" colour="green">
          <div className="how-prose">
            <p className="how-lead">
              When the bell goes, each fighter has a coach in his corner, and the
              coach is a language model. It looks at the round that just happened,
              the scoring, the pace, how much the fighter has left and what the other
              man keeps doing, and gives him a plan for the next three minutes,
              whether that is going to the body, backing off to breathe, or cutting
              the ring off.
            </p>
          </div>
          <div className="how-prose">
            <p>
              The fighter takes that plan into the next round, but he still throws
              every punch himself. The corner can tell him what to try. It cannot
              land it for him.
            </p>
          </div>
        </Chapter>

        <Chapter number="05" title="What he keeps after a fight" colour="blue">
          <div className="how-prose">
            <p className="how-lead">
              After the final bell both fighters go back over the fight. What worked,
              he keeps. What got him hit, he does less of. By the next time he trains
              or fights that is already part of him, so win or lose he is a slightly
              different fighter the next time out.
            </p>
          </div>
          <div className="how-prose">
            <p>
              He also keeps a file on everyone he has fought. When two of them meet
              again both come in knowing something about the other, so a rematch is
              never the first fight played twice.
            </p>
          </div>
        </Chapter>

        <Chapter number="06" title="Between fight nights" colour="green">
          <div className="how-prose">
            <p className="how-lead">
              A new card goes up every six hours. In between, the whole roster is in
              the gym. They spar, work on the decisions that cost them, and bank the
              experience that gets the network a bigger say in the fight. You can
              watch it on the <Link href="/training">training page</Link>.
            </p>
          </div>
          <div className="how-prose">
            <p>
              The body trains too. Power, endurance, balance and durability all come
              up through work over a career, and a good decision still needs the legs
              and the lungs behind it to count for anything.
            </p>
          </div>
        </Chapter>

        <section className="how-close" aria-label="Where to go next">
          <h2>That is the<br />whole thing.</h2>
          <div className="how-close__copy">
            <p>
              Nobody is controlling the fighters and nothing is written in advance. If
              you want to see it, the ring is where the fights are, the gym is always
              open, and you can get in there against one of them yourself.
            </p>
            <div className="how-close__actions">
              <Link className="button button--amber" href="/ring">Go to the ring</Link>
              <Link className="button" href="/training">Watch training</Link>
              <Link className="button" href="/play">Fight one yourself</Link>
            </div>
          </div>
        </section>
      </main>
      <SiteFooter />

      <Ticker notice="Nothing in the ring is scripted." />
    </div>
  );
}
