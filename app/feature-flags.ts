/** Keep unfinished public surfaces in the project without advertising them. */
export const SHOW_NATIVE_TRAINING = false;

/** The spoken ringside announcer. One switch for both ends: off, the worker
 *  neither renders clips (no speech-model spend) nor files the rows they would
 *  fill (no D1 writes), and no viewer asks `/api/voice` for anything. The call
 *  itself is still recorded with every fight and still drives the captions —
 *  that costs nothing — so turning this on only ever adds the audio. */
export const ANNOUNCER_VOICE = false;
