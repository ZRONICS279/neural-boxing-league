import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { WalletChoice } from "../app/market.ts";

const ACCOUNT_A = "0x1111111111111111111111111111111111111111";
const ACCOUNT_B = "0x2222222222222222222222222222222222222222";
let pageId = 0;
type Provider = WalletChoice["provider"];

class Wallet implements Provider {
  accounts = [ACCOUNT_A];
  calls: string[] = [];
  handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  read: (() => Promise<unknown>) | null = null;
  connect: (() => Promise<unknown>) | null = null;

  async request({ method }: { method: string; params?: unknown[] }) {
    this.calls.push(method);
    if (method === "eth_accounts") return this.read ? this.read() : this.accounts;
    if (method === "eth_requestAccounts") return this.connect ? this.connect() : this.accounts;
    throw new Error(`Unexpected wallet request: ${method}`);
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(handler);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.get(event)?.delete(handler);
  }

  emit(event: string, value?: unknown) {
    for (const handler of this.handlers.get(event) ?? []) handler(value);
  }
}

function deferred() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Each import is a fresh page's module state. Storage survives a reload,
 *  while the extension has to announce its provider to the new document. */
async function page(t: TestContext, options: {
  selected?: string;
  wallets?: Record<string, Wallet>;
  legacy?: Wallet;
  storage?: Map<string, string>;
} = {}) {
  const storage = options.storage ?? new Map<string, string>();
  if (options.selected) storage.set("forge.wallet", options.selected);
  const browser = Object.assign(new EventTarget(), {
    ethereum: options.legacy,
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "window", original);
    else Reflect.deleteProperty(globalThis, "window");
  });
  const announce = (rdns: string, provider: Wallet) => browser.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", { detail: { info: { rdns, name: rdns }, provider } }),
  );
  browser.addEventListener("eip6963:requestProvider", () => {
    for (const [rdns, wallet] of Object.entries(options.wallets ?? {})) announce(rdns, wallet);
  });
  const market = await import(`../app/market.ts?wallet-page=${++pageId}`) as typeof import("../app/market.ts");
  return { market, storage, browser, announce };
}

test("a fresh visitor does not ask installed wallets for account access", async (t) => {
  const wallet = new Wallet();
  const { market } = await page(t, { wallets: { "io.wallet": wallet }, legacy: wallet });
  const seen: (string | null)[] = [];
  market.subscribeAccount((account) => seen.push(account));
  market.subscribeWallets(() => {});
  assert.equal(await market.connectedAccount(), null);
  wallet.emit("accountsChanged", [ACCOUNT_A]);
  assert.deepEqual(seen, [null]);
  assert.deepEqual(wallet.calls, []);
});

test("refresh restores the selected wallet and navigation immediately receives its account", async (t) => {
  const wallet = new Wallet();
  const { market } = await page(t, { selected: "io.wallet", wallets: { "io.wallet": wallet } });
  const header: (string | null)[] = [];
  const leavePage = market.subscribeAccount((account) => header.push(account));
  market.subscribeWallets(() => {});
  assert.equal(await market.connectedAccount(), ACCOUNT_A);
  assert.deepEqual(header, [null, ACCOUNT_A]);
  leavePage();

  const nextHeader: (string | null)[] = [];
  const ticket: (string | null)[] = [];
  market.subscribeAccount((account) => nextHeader.push(account));
  market.subscribeAccount((account) => ticket.push(account));
  market.subscribeWallets(() => {});
  assert.deepEqual(nextHeader, [ACCOUNT_A]);
  assert.deepEqual(ticket, [ACCOUNT_A]);
  assert.deepEqual(wallet.calls, ["eth_accounts"]);
});

test("a delayed selected extension is never replaced by another injected wallet", async (t) => {
  const other = new Wallet();
  other.accounts = [ACCOUNT_B];
  const selected = new Wallet();
  const { market, announce } = await page(t, { selected: "io.selected", legacy: other });
  const seen: (string | null)[] = [];
  market.subscribeAccount((account) => seen.push(account));
  assert.equal(market.getWallet(), null);
  assert.equal(await market.connectedAccount(), null);
  assert.deepEqual(other.calls, []);

  announce("io.selected", selected);
  assert.equal(await market.connectedAccount(), ACCOUNT_A);
  announce("io.other", other);
  assert.equal(market.getWallet(), selected);
  assert.deepEqual(seen, [null, ACCOUNT_A]);
  assert.deepEqual(selected.calls, ["eth_accounts"]);
  assert.deepEqual(other.calls, []);
});

test("connecting through the ticket remembers the provider for a full reload", async (t) => {
  const wallet = new Wallet();
  const first = await page(t, { legacy: wallet });
  assert.equal(await first.market.requestAccount(), ACCOUNT_A);
  assert.equal(first.storage.get("forge.wallet"), "injected");

  const nextWallet = new Wallet();
  const next = await page(t, { legacy: nextWallet, storage: first.storage });
  assert.equal(await next.market.connectedAccount(), ACCOUNT_A);
  assert.deepEqual(nextWallet.calls, ["eth_accounts"]);
});

test("a legacy wallet injected after page load can restore the saved connection", async (t) => {
  const wallet = new Wallet();
  const { market, browser } = await page(t, { selected: "injected" });
  market.subscribeAccount(() => {});
  assert.equal(await market.connectedAccount(), null);
  browser.ethereum = wallet;
  browser.dispatchEvent(new Event("ethereum#initialized"));
  assert.equal(await market.connectedAccount(), ACCOUNT_A);
});

test("disconnect cancels an unfinished restore and stays disconnected after reload", async (t) => {
  const wallet = new Wallet();
  const reading = deferred();
  wallet.read = () => reading.promise;
  const first = await page(t, { selected: "io.wallet", wallets: { "io.wallet": wallet } });
  const seen: (string | null)[] = [];
  first.market.subscribeAccount((account) => seen.push(account));
  const restore = first.market.connectedAccount();
  first.market.selectWallet(null);
  reading.resolve([ACCOUNT_A]);
  assert.equal(await restore, null);
  wallet.emit("accountsChanged", [ACCOUNT_A]);
  assert.deepEqual(seen, [null]);
  assert.equal(first.storage.has("forge.wallet"), false);

  const nextWallet = new Wallet();
  const next = await page(t, { storage: first.storage, wallets: { "io.wallet": nextWallet } });
  assert.equal(await next.market.connectedAccount(), null);
  assert.deepEqual(nextWallet.calls, []);
});

test("switching wallets ignores the old provider's delayed answer and later events", async (t) => {
  const old = new Wallet();
  const reading = deferred();
  old.read = () => reading.promise;
  const next = new Wallet();
  next.accounts = [ACCOUNT_B];
  const { market } = await page(t, { selected: "io.old", wallets: { "io.old": old, "io.next": next } });
  market.subscribeAccount(() => {});
  const restore = market.connectedAccount();
  market.selectWallet("io.next");
  assert.equal(await market.connectedAccount(), ACCOUNT_B);
  reading.resolve([ACCOUNT_A]);
  await restore;
  old.emit("accountsChanged", [ACCOUNT_A]);
  assert.equal(await market.connectedAccount(), ACCOUNT_B);
  assert.equal(old.handlers.get("accountsChanged")?.size, 0);
});

test("account changes outrank a stale restore, and locking and unlocking update all subscribers", async (t) => {
  const wallet = new Wallet();
  const reading = deferred();
  wallet.read = () => reading.promise;
  const { market } = await page(t, { selected: "io.wallet", wallets: { "io.wallet": wallet } });
  const seen: (string | null)[] = [];
  market.subscribeAccount((account) => seen.push(account));
  const restore = market.connectedAccount();
  wallet.emit("accountsChanged", [ACCOUNT_B]);
  reading.resolve([ACCOUNT_A]);
  assert.equal(await restore, ACCOUNT_B);
  wallet.emit("accountsChanged", []);
  assert.equal(await market.connectedAccount(), null);
  wallet.emit("accountsChanged", [ACCOUNT_B]);
  assert.equal(await market.connectedAccount(), ACCOUNT_B);
  assert.deepEqual(seen, [null, ACCOUNT_B, null, ACCOUNT_B]);
});

test("provider disconnect clears the account and reconnect reads its current permission", async (t) => {
  const wallet = new Wallet();
  const { market } = await page(t, { selected: "io.wallet", wallets: { "io.wallet": wallet } });
  assert.equal(await market.connectedAccount(), ACCOUNT_A);
  wallet.emit("disconnect");
  assert.equal(await market.connectedAccount(), null);
  wallet.accounts = [ACCOUNT_B];
  wallet.emit("connect");
  assert.equal(await market.connectedAccount(), ACCOUNT_B);
  assert.deepEqual(wallet.calls, ["eth_accounts", "eth_accounts"]);
});

test("a refused restore stays disconnected without opening a connect prompt", async (t) => {
  const wallet = new Wallet();
  wallet.read = async () => { throw new Error("Locked"); };
  const { market } = await page(t, { selected: "io.wallet", wallets: { "io.wallet": wallet } });
  assert.equal(await market.connectedAccount(), null);
  assert.deepEqual(wallet.calls, ["eth_accounts"]);
  assert.equal(await market.requestAccount(), ACCOUNT_A);
});

test("a connect approval arriving after disconnect cannot reconnect the page", async (t) => {
  const wallet = new Wallet();
  const approval = deferred();
  wallet.connect = () => approval.promise;
  const { market } = await page(t, { legacy: wallet });
  const connecting = market.requestAccount();
  market.selectWallet(null);
  approval.resolve([ACCOUNT_A]);
  await assert.rejects(connecting, /Wallet selection changed/);
  assert.equal(await market.connectedAccount(), null);
});

test("blocked browser storage still allows a connection across page remounts", async (t) => {
  const wallet = new Wallet();
  const { market, browser } = await page(t, { legacy: wallet });
  browser.localStorage.getItem = () => { throw new Error("Storage blocked"); };
  browser.localStorage.setItem = () => { throw new Error("Storage blocked"); };
  assert.equal(await market.requestAccount(), ACCOUNT_A);
  const nextPage: (string | null)[] = [];
  market.subscribeAccount((account) => nextPage.push(account));
  assert.deepEqual(nextPage, [ACCOUNT_A]);
});
