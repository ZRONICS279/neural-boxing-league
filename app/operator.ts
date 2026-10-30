/** Who is allowed to drive the league, and how they prove it.
 *
 * The controls used to be behind a shared secret pasted into a box, which is
 * one string away from anybody who has ever seen a screenshot of it. They are
 * behind a wallet now: one address operates the league, the panel is not drawn
 * at all for anyone else, and the server checks a signature rather than a
 * password. Both sides read this file so there is one answer to "who is the
 * operator" instead of a client-side opinion and a server-side one.
 *
 * The address is public information — hiding it would buy nothing. What the
 * server trusts is the signature over the pass below, which only the private
 * key behind that address can produce. */
export const FORGE_OPERATOR = "0x52FD1109d9Aa34Ef2E3Bd4f51bB06a9Aa22e364a";

export function isOperator(address: string | null | undefined) {
  return typeof address === "string" &&
    address.toLowerCase() === FORGE_OPERATOR.toLowerCase();
}

/** How long one signature is good for. Long enough that a night on the desk is
 *  a single wallet popup, short enough that a pass left on a borrowed machine
 *  stops working the same day. */
export const OPERATOR_PASS_MS = 12 * 60 * 60 * 1000;

/** What the operator actually signs. Plain lines rather than a blob, because
 *  this is the text the wallet shows them before they approve it. */
export function operatorPassMessage(address: string, expires: number) {
  return [
    "Forge League admin pass",
    `Address: ${address}`,
    `Expires: ${new Date(expires).toISOString()}`,
  ].join("\n");
}

export interface OperatorPass {
  address: string;
  expires: number;
}

/** Read a pass back out of its own text. Returns null on anything that is not
 *  exactly the message above — a pass that has been edited is not a pass, and
 *  the signature is checked against the text as it arrived either way. */
export function parseOperatorPass(message: string): OperatorPass | null {
  const lines = message.split("\n");
  if (lines.length !== 3 || lines[0] !== "Forge League admin pass") return null;
  const address = lines[1].startsWith("Address: ") ? lines[1].slice(9) : null;
  const expires = lines[2].startsWith("Expires: ")
    ? Date.parse(lines[2].slice(9))
    : Number.NaN;
  if (!address || !Number.isFinite(expires)) return null;
  return { address, expires };
}
