import { verifyMessage } from "viem";
import { isOperator, parseOperatorPass } from "../app/operator.ts";

export interface AdminEnv {
  FORGE_ADMIN_TOKEN?: string;
}

/** Server-side authorization shared by every state-changing or billable route.
 *
 * Two ways in. The operator signs a dated pass with the wallet that runs the
 * league and the signature is checked here, which is what the panel uses; the
 * shared token stays for the things that have no wallet to sign with — a cron
 * hitting a route by hand, a deploy script — and is only live on deployments
 * that actually set one. */
export async function adminAuthorized(request: Request, env: AdminEnv) {
  return tokenMatches(request, env) || await operatorSigned(request);
}

function tokenMatches(request: Request, env: AdminEnv) {
  const expected = env.FORGE_ADMIN_TOKEN;
  if (!expected) return false;
  const supplied = request.headers.get("x-forge-admin") ?? "";
  if (supplied.length !== expected.length) return false;
  // Constant-time-ish: never bail early on the first differing character.
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= supplied.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

async function operatorSigned(request: Request) {
  const encoded = request.headers.get("x-forge-pass");
  const signature = request.headers.get("x-forge-pass-signature");
  if (!encoded || !signature) return false;

  let message: string;
  try {
    message = atob(encoded);
  } catch {
    return false;
  }

  // Read the claim before spending a signature check on it: an expired pass or
  // one naming somebody else is refused without the elliptic curve maths.
  const pass = parseOperatorPass(message);
  if (!pass || !isOperator(pass.address) || pass.expires <= Date.now()) return false;

  try {
    return await verifyMessage({
      address: pass.address as `0x${string}`,
      message,
      signature: signature as `0x${string}`,
    });
  } catch {
    // A malformed signature is a refusal, not a 500.
    return false;
  }
}
