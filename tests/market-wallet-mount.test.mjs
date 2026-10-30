import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import * as market from "../app/market.ts";

const ACCOUNT = "0x1111111111111111111111111111111111111111";
const source = readFileSync(new URL("../app/market-panel.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("market-panel.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const board = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "MarketBoard");
const trades = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "YourTrades");

/** Run the real ticket's hooks with batched state updates. In particular, all
 *  mount effects see the initial render, even if an earlier effect set state.
 *  That ordering is what let the holdings read erase a restored connection. */
function ticket({ address = ACCOUNT, failRead = false } = {}) {
  const states = [];
  const effects = [];
  const listeners = new Set();
  let stateIndex = 0;
  let effectIndex = 0;
  let pending = [];
  let dirty = false;
  let refresh = 0;
  let connectCalls = 0;
  const bump = () => { refresh += 1; dirty = true; };
  const jsx = (type, props) => typeof type === "function" ? type(props) : ({ type, props });
  const quote = {
    boutId: 1, quoted: true, blue: 50, red: 50, closed: false, resolved: false,
    asksBlue: [], asksRed: [], bidsBlue: [], bidsRed: [], trades: [], history: [],
  };
  const booked = {
    ok: true, booked: true, quote, clob: "book", reader: "reader", collateral: "token",
    collateralDecimals: 6, collateralSymbol: "USDC", chainId: 1,
  };
  const setAddress = (next) => {
    if (address === next) return;
    address = next;
    for (const listener of listeners) listener(address);
  };
  const context = {
    ...market,
    exports: {},
    module: { exports: {} },
    require: () => ({ jsx, jsxs: jsx, Fragment: "fragment" }),
    useState(initial) {
      const i = stateIndex++;
      if (!(i in states)) states[i] = initial;
      return [states[i], (value) => {
        const next = typeof value === "function" ? value(states[i]) : value;
        if (!Object.is(next, states[i])) { states[i] = next; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const i = effectIndex++;
      if (effects[i] && deps.every((value, j) => Object.is(value, effects[i].deps[j]))) return;
      pending.push(() => {
        effects[i]?.cleanup?.();
        effects[i] = { deps, cleanup: effect() };
      });
    },
    useMemo: (factory) => factory(),
    useMarketFeed: () => ({ feed: booked, booked, quote, refresh, bump }),
    openingOdds: () => ({ blue: 50, red: 50 }),
    subscribeAccount(listener) {
      listeners.add(listener);
      listener(address);
      return () => listeners.delete(listener);
    },
    subscribeWallets: () => () => {},
    async requestAccount() { connectCalls += 1; setAddress(ACCOUNT); return ACCOUNT; },
    ensureChain: async () => {},
    readAccount: async (account) => {
      if (failRead) throw new Error("Wrong network");
      return {
        address: account, balance: 100_000_000n, allowance: 0n, blueShares: 0n,
        redShares: 0n, blueEscrow: 0n, redEscrow: 0n, claimable: 0n, pending: 0n,
      };
    },
    readOpenOrders: async () => [],
    faucetCalldata: async () => null,
    SLIPPAGE: 3,
    FAUCET_AMOUNT: 1_000n,
    QUICK_STAKES: [5, 25, 100],
    MarketChart: "chart",
    OrderBook: "book",
    RecentFills: "fills",
  };
  const code = ts.transpileModule(`${trades.getText(file)}\n${board.getText(file)}\nmodule.exports = MarketBoard;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, context);
  return {
    setAddress,
    get connectCalls() { return connectCalls; },
    async render() {
      for (let pass = 0; pass < 12; pass++) {
        dirty = false;
        stateIndex = 0;
        effectIndex = 0;
        pending = [];
        const tree = context.module.exports({
          night: 1, blue: { id: "cole", lastName: "Cole" },
          red: { id: "talos", lastName: "Talos" }, active: true,
        });
        for (const effect of pending) effect();
        await new Promise(setImmediate);
        if (!dirty) return tree;
      }
      assert.fail("ticket did not settle after its effects ran");
    },
  };
}

function nodes(tree) {
  if (!tree || typeof tree !== "object") return [];
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  return [tree, ...nodes(tree.props?.children)];
}

function text(tree) {
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  if (Array.isArray(tree)) return tree.map(text).join("");
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}

test("opening the trading ticket after connecting preserves the account through mount effects", async () => {
  const panel = ticket();
  const tree = await panel.render();
  assert.doesNotMatch(text(tree), /Connect (?:a )?wallet|Not connected/);
  assert.match(text(tree), /0x1111…1111/);
  assert.ok(nodes(tree).some((node) => node.type === "button" && node.props.type === "submit"));
  assert.equal(panel.connectCalls, 0);
});

test("the ticket's connect button updates it and a later disconnect clears it", async () => {
  const panel = ticket({ address: null });
  let tree = await panel.render();
  const connect = nodes(tree).find((node) => node.type === "button" && text(node) === "Connect wallet");
  assert.ok(connect);
  connect.props.onClick();
  tree = await panel.render();
  assert.doesNotMatch(text(tree), /Connect (?:a )?wallet|Not connected/);
  assert.equal(panel.connectCalls, 1);
  panel.setAddress(null);
  tree = await panel.render();
  assert.match(text(tree), /Connect wallet/);
  assert.doesNotMatch(text(tree), /0x1111…1111/);
});

test("a failed holdings read shows a connected wallet and an actionable retry", async () => {
  const tree = await ticket({ failRead: true }).render();
  assert.doesNotMatch(text(tree), /Connect (?:a )?wallet|Not connected/);
  assert.match(text(tree), /0x1111…1111/);
  assert.match(text(tree), /Your wallet is connected/);
  assert.ok(nodes(tree).some((node) => node.type === "button" && text(node) === "Retry position"));
});
