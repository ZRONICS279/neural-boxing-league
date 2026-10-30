/** One-off sweep of the operator's stranded resting orders.
 *
 * The deployed book caps every account at 500 active orders, and `reclaim` in
 * the worker only ever looks at the current night's card — so rungs left on
 * earlier nights are invisible to it forever and accumulate toward the cap.
 * Once the operator hits 500, every `placeSellOrder`/`placeBuyOrder` the maker
 * sends reverts "UL" and the card airs with an empty ladder. The operator's
 * failures are deliberately silent, so the symptom is just `quoted: false` on
 * every bout while closes and resolutions keep working.
 *
 * This walks `cancelMyOrders` over the operator's whole order index. Cancelled
 * bids refund collateral and cancelled asks return escrowed shares, all to the
 * operator itself — nothing leaves the account. Orders the maker legitimately
 * has resting on the live card are cancelled along with the stale ones, which
 * is fine: the next quoting tick puts them back.
 *
 * Run it with:  npm run market:drain
 *
 * Reads FIGHT_RPC_URL, FIGHT_CHAIN_ID, FIGHT_CLOB_ADDRESS and
 * FIGHT_OPERATOR_KEY from `.env.local` (falling back to the process env), the
 * same values the deployed worker quotes with. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Cancels per transaction. Each one touches a handful of storage slots, so a
 *  batch this size stays well under any sane block gas limit while still
 *  clearing 873 slots in a dozen-odd transactions. */
const BATCH = 60;

/* ------------------------------------------------------------------ env */

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of [".env", ".env.local"]) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].trim();
    }
  }
  return { ...env, ...process.env } as Record<string, string>;
}

const env = loadEnv();
const RPC = env.FIGHT_RPC_URL;
const CLOB = env.FIGHT_CLOB_ADDRESS as Address | undefined;
const KEY = env.FIGHT_OPERATOR_KEY;
const CHAIN_ID = Number(env.FIGHT_CHAIN_ID ?? 0);

if (!RPC || !CLOB || !KEY || !CHAIN_ID) {
  console.error(
    "Missing FIGHT_RPC_URL, FIGHT_CHAIN_ID, FIGHT_CLOB_ADDRESS or FIGHT_OPERATOR_KEY.",
  );
  process.exit(1);
}

/* ------------------------------------------------------------------ chain */

const ABI = [
  {
    type: "function",
    name: "cancelMyOrders",
    stateMutability: "nonpayable",
    inputs: [
      { name: "_startIdx", type: "uint256" },
      { name: "_maxBatch", type: "uint256" },
    ],
    outputs: [{ name: "nextIdx", type: "uint256" }],
  },
  {
    type: "function",
    name: "userOrderCount",
    stateMutability: "view",
    inputs: [{ name: "_user", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "activeOrderCount",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const chain = defineChain({
  id: CHAIN_ID,
  name: "fight-market",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const account = privateKeyToAccount(
  (KEY.startsWith("0x") ? KEY : `0x${KEY}`) as Hex,
);
const reader = createPublicClient({ chain, transport: http(RPC) });
const writer = createWalletClient({ account, chain, transport: http(RPC) });

/** Send one batch, racing the live worker for the account's nonce.
 *
 * The deployed operator quotes from this same account the whole time the
 * league is airing, so a nonce fetched here can be stale by the time the
 * transaction reaches the node. On a nonce collision the send is cheap to
 * retry: nothing was mined, so refetch the pending nonce and go again. */
async function sendBatch(start: bigint) {
  for (let attempt = 1; ; attempt++) {
    const nonce = await reader.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    try {
      const hash = await writer.writeContract({
        address: CLOB!,
        abi: ABI,
        functionName: "cancelMyOrders",
        args: [start, BigInt(BATCH)],
        nonce,
      });
      // A worker transaction mining first on the same nonce orphans ours
      // silently, so a receipt that never comes is also just a lost race —
      // the batch is idempotent (cancelled orders are skipped), re-send it.
      return await reader.waitForTransactionReceipt({ hash, timeout: 60_000 });
    } catch (err) {
      const text = String(err);
      const nonceRace =
        text.includes("nonce too low") ||
        text.includes("NonceTooLow") ||
        text.includes("replacement transaction underpriced") ||
        text.includes("already known") ||
        text.includes("Timed out while waiting");
      if (!nonceRace || attempt >= 10) throw err;
      console.log(
        `nonce ${nonce} raced the live worker (attempt ${attempt}); retrying`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    }
  }
}

async function main() {
  const total = await reader.readContract({
    address: CLOB!,
    abi: ABI,
    functionName: "userOrderCount",
    args: [account.address],
  });
  const activeBefore = await reader.readContract({
    address: CLOB!,
    abi: ABI,
    functionName: "activeOrderCount",
    args: [account.address],
  });
  console.log(
    `operator ${account.address}: ${activeBefore} active of ${total} lifetime orders`,
  );
  if (activeBefore === 0n) {
    console.log("Nothing to drain.");
    return;
  }

  for (let start = 0n; start < total; start += BigInt(BATCH)) {
    const receipt = await sendBatch(start);
    console.log(
      `cancelMyOrders(${start}, ${BATCH}) — ${receipt.status} in block ${receipt.blockNumber}`,
    );
    if (receipt.status !== "success") {
      console.error("Batch reverted; stopping. Re-run to retry from the top.");
      process.exit(1);
    }
  }

  const activeAfter = await reader.readContract({
    address: CLOB!,
    abi: ABI,
    functionName: "activeOrderCount",
    args: [account.address],
  });
  console.log(`Done. Active orders: ${activeBefore} -> ${activeAfter}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
