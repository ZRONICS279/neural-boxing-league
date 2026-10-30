/** The ringside voice, rendered.
 *
 * Every line the announcer will say over a fight is known the moment the fight
 * is recorded — minutes before its first chunk airs — so the voice is never
 * synthesized live. This is the one call to the speech model, one line at a
 * time; the store decides which lines are worth a request and what to do with
 * the answer, and nothing here touches the database or the card.
 *
 * The announcer's register travels as direction rather than as rate and pitch
 * knobs: a model that is told the moment is a knockdown reads it as one, where
 * the browser's own synthesizer could only be sped up and raised. */

import type { TimelineVoiceLine } from "../app/fight-timeline.ts";

export interface VoiceEnv {
  OPENAI_API_KEY?: string;
  /** The speech model, and which of its voices. Both optional: the defaults are
   *  the instructable model and a voice that carries an arena. */
  OPENAI_VOICE_MODEL?: string;
  OPENAI_VOICE?: string;
}

const VOICE_TIMEOUT_MS = 20_000;
/* A dated snapshot rather than the rolling alias, so the caller does not change
 * voice between two fights on the same card when the alias moves. */
const DEFAULT_MODEL = "gpt-4o-mini-tts-2025-12-15";
const DEFAULT_VOICE = "ash";

/* Who is speaking, then how this particular line is read. Fixed across a fight
 * so the clips cut together as one caller rather than a different man per
 * sentence; only the delivery moves with the register.
 *
 * Written hot on purpose. Asked politely for "a ringside announcer" the model
 * reads the line like a newsreader — measured, even, a beat slow — which is the
 * one thing a fight call must not be. The direction has to overshoot: the
 * arena, the volume, the pace and the emotion all spelled out, and the color
 * register kept quick too, because a slow aside between two shouted calls
 * reads as the broadcast losing interest. The model cannot be sped up by a
 * parameter, so pace lives here as well. */
const BOOTH =
  "Voice affect: a legendary big-fight boxing play-by-play announcer at ringside, calling a world title " +
  "fight LIVE on pay-per-view, shouting over twenty thousand screaming fans. Delivery: HIGH ENERGY, FAST, " +
  "breathless, electric. Speak quickly with punchy emphasis and a sharp, driving rhythm — hit the consonants " +
  "hard, clip the words, let the voice crack with excitement. Never calm, never a narrator, never reading " +
  "copy. Emotion: thrilled, on the edge of your seat, this is the moment of the night. Say the line exactly " +
  "as written, once.";
const DELIVERY: Record<TimelineVoiceLine["register"], string> = {
  alarm: "This is a KNOCKDOWN-level moment: SCREAM it, maximum volume and speed, voice rising to a peak.",
  call: "Rapid-fire play-by-play: quick, punchy, urgent, excited.",
  color: "Still quick and energetic — an excited aside, never slow.",
};

export type VoiceRender =
  | { ok: true; audio: ArrayBuffer }
  /** `again` is whether asking later could go differently. A timeout or a
   *  server error might; a refused key or an empty balance will not, and a
   *  pass that keeps asking after one of those is spending requests on a
   *  known answer. */
  | { ok: false; status: number | null; again: boolean };

/** One line, spoken. Never throws: a voice that cannot be rendered is a line
 *  that stays a caption, and the caller decides what that means for the rest
 *  of the batch. */
export async function renderVoiceLine(
  line: Pick<TimelineVoiceLine, "text" | "register">,
  env: VoiceEnv,
  fetcher: typeof fetch = fetch,
): Promise<VoiceRender> {
  if (!env.OPENAI_API_KEY) return { ok: false, status: null, again: false };
  let response: Response;
  try {
    response = await fetcher("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: env.OPENAI_VOICE_MODEL ?? DEFAULT_MODEL,
        voice: env.OPENAI_VOICE ?? DEFAULT_VOICE,
        input: line.text,
        instructions: `${BOOTH} ${DELIVERY[line.register]}`,
        // MP3 because every browser on the card decodes it natively, Safari
        // included, and a three-second line is a dozen kilobytes.
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(VOICE_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: null, again: true };
  }
  if (!response.ok) {
    // 401 is a key that does not work, 402 and 429 a balance or a quota that
    // has run out — none of them changes between one line and the next.
    const settled = response.status === 401 || response.status === 402 || response.status === 429;
    return { ok: false, status: response.status, again: !settled };
  }
  try {
    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) return { ok: false, status: response.status, again: true };
    return { ok: true, audio };
  } catch {
    return { ok: false, status: response.status, again: true };
  }
}
