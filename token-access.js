// Token-gated access (Labr). Holding at least ACCESS_MIN of ACCESS_TOKEN gives:
//   - the ACCESS_ROLE in the server (channel permissions do the rest),
//   - use of the host's AI keys, capped per day by how much is held,
//   - eligibility for treasury payouts.
// Wallets come from Connect (the wallet a handle resolves to), balances from an
// eth_call on the token's chain. Everything that does IO is injected so the
// rules can be tested without Discord, Connect or an RPC.

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const AMOUNT = /^\d+(\.\d+)?$/;

/** Human amount ("1000", "2.5") to base units. */
export function parseUnits(value, decimals) {
  const s = String(value).trim();
  if (!AMOUNT.test(s)) throw new Error(`not an amount: ${value}`);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`${value} has more than ${decimals} decimals`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

/**
 * Reads the ACCESS_* settings. Returns null when ACCESS_TOKEN is unset, which
 * leaves the bot exactly as it was. Throws on a setting that is present but
 * wrong, so a typo stops the bot at startup instead of quietly opening access.
 *
 *   ACCESS_TOKEN=0x...              token contract (required to turn this on)
 *   ACCESS_CHAIN_ID=8453            chain the token lives on (default Base)
 *   ACCESS_RPC_URL=https://...      JSON-RPC for that chain (default: Base public RPC)
 *   ACCESS_MIN=1000                 tokens a member must hold
 *   ACCESS_ROLE=Holder              role given to holders
 *   ACCESS_EXEMPT_ROLES=Maintainer,Contributor   keep access without holding
 *   ACCESS_AI_TIERS=1000:20,10000:100            held:AI messages per day (UTC)
 *   ACCESS_RECHECK_MIN=360          minutes between full member rechecks
 */
export function parseAccessConfig(env) {
  const token = String(env.ACCESS_TOKEN ?? '').trim();
  if (!token) return null;
  if (!ADDR.test(token)) throw new Error('ACCESS_TOKEN must be a 0x token address');
  const chainId = Number(env.ACCESS_CHAIN_ID ?? 8453);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('ACCESS_CHAIN_ID must be a chain id');
  const rpcUrl = String(env.ACCESS_RPC_URL ?? '').trim() || (chainId === 8453 ? 'https://mainnet.base.org' : '');
  if (!rpcUrl) throw new Error('ACCESS_RPC_URL is required for a chain other than Base');
  const min = String(env.ACCESS_MIN ?? '').trim();
  if (!AMOUNT.test(min) || Number(min) <= 0) throw new Error('ACCESS_MIN must be a positive number of tokens');
  const tiersRaw = String(env.ACCESS_AI_TIERS ?? '').trim() || `${min}:20`;
  const tiers = tiersRaw.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const [held, perDay] = t.split(':').map((x) => x.trim());
    if (!AMOUNT.test(held ?? '') || !/^\d+$/.test(perDay ?? '')) throw new Error(`ACCESS_AI_TIERS entry "${t}" must look like 1000:20`);
    return { held, perDay: Number(perDay) };
  });
  const recheckMin = Number(env.ACCESS_RECHECK_MIN ?? 360);
  if (!(recheckMin >= 5)) throw new Error('ACCESS_RECHECK_MIN must be at least 5');
  const list = (v) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return {
    token: token.toLowerCase(),
    chainId,
    rpcUrl,
    min,
    role: String(env.ACCESS_ROLE ?? '').trim() || 'Holder',
    exemptRoles: new Set(list(env.ACCESS_EXEMPT_ROLES ?? 'Maintainer,Contributor')),
    tiers,
    recheckMs: recheckMin * 60_000,
    cacheMs: 10 * 60_000,
  };
}

/** Messages per day for a balance: the highest tier it reaches, 0 below all. */
export function perDayFor(balance, tiers) {
  let best = 0;
  for (const t of tiers) if (balance >= t.heldUnits && t.perDay > best) best = t.perDay;
  return best;
}

/** Minimal JSON-RPC client for the two ERC-20 reads we need. */
export function createErc20Reader({ rpcUrl, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  let id = 0;
  async function call(data) {
    const res = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to: token, data }, 'latest'] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new Error(`RPC ${body.error.message ?? 'error'}`);
    if (typeof body.result !== 'string' || !body.result.startsWith('0x')) throw new Error('RPC returned no result');
    return body.result === '0x' ? 0n : BigInt(body.result);
  }
  return {
    decimals: async () => Number(await call('0x313ce567')),
    symbol: async () => {
      // Optional and cosmetic: decode a string return, fall back to "tokens".
      try {
        const res = await fetchImpl(rpcUrl, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'eth_call', params: [{ to: token, data: '0x95d89b41' }, 'latest'] }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const hex = (await res.json()).result?.slice(2) ?? '';
        const len = parseInt(hex.slice(64, 128), 16);
        const s = Buffer.from(hex.slice(128, 128 + len * 2), 'hex').toString('utf8').replace(/[^\x20-\x7e]/g, '');
        return s || 'tokens';
      } catch { return 'tokens'; }
    },
    balanceOf: (wallet) => call('0x70a08231' + wallet.toLowerCase().replace(/^0x/, '').padStart(64, '0')),
  };
}

/**
 * The access rules. `resolve({ type, id?, username? })` returns the EVM wallet
 * Connect resolves that handle to (or null); `reader` is createErc20Reader.
 * Errors from Connect or the RPC propagate: callers decide whether a failed
 * check keeps or removes access (removal only ever happens on a real reading).
 */
export function createTokenAccess({ cfg, resolve, reader, now = () => Date.now() }) {
  let minUnits = null;
  let tiers = null;
  let decimals = null;
  let symbol = 'tokens';
  const cache = new Map(); // wallet -> { balance, at }

  async function ready() {
    decimals = await reader.decimals();
    symbol = await reader.symbol();
    minUnits = parseUnits(cfg.min, decimals);
    tiers = cfg.tiers.map((t) => ({ ...t, heldUnits: parseUnits(t.held, decimals) }));
    return { decimals, symbol };
  }

  async function balanceOf(wallet, { fresh = false } = {}) {
    const key = wallet.toLowerCase();
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < cfg.cacheMs) return hit.balance;
    const balance = await reader.balanceOf(key);
    cache.set(key, { balance, at: now() });
    return balance;
  }

  /** { wallet, holder, perDay } for a handle. wallet null = nothing to check. */
  async function check(recipient, opts = {}) {
    if (minUnits === null) throw new Error('token access not ready');
    const wallet = await resolve(recipient);
    if (!wallet || !ADDR.test(wallet)) return { wallet: null, holder: false, perDay: 0 };
    const balance = await balanceOf(wallet, opts);
    return { wallet, holder: balance >= minUnits, perDay: perDayFor(balance, tiers) };
  }

  return {
    ready,
    check,
    get symbol() { return symbol; },
    get min() { return cfg.min; },
    get isReady() { return minUnits !== null; },
  };
}

/**
 * Daily AI-message counter per member, reset at 00:00 UTC. `store` persists
 * counts (get/set by key); a Map works for tests.
 */
export function createDailyCounter({ store = new Map(), now = () => Date.now() } = {}) {
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const key = (userId) => `${userId}:${day()}`;
  return {
    used: (userId) => Number(store.get(key(userId)) ?? 0),
    /** Counts one message if under the cap. Returns false (and counts nothing) at the cap. */
    take(userId, perDay) {
      const k = key(userId);
      const n = Number(store.get(k) ?? 0);
      if (n >= perDay) return false;
      store.set(k, n + 1);
      return true;
    },
  };
}

/** First EVM address in a connect_lookup result, or null. */
export function walletFromLookup(text) {
  try {
    const body = typeof text === 'string' ? JSON.parse(text) : text;
    const w = body?.results?.[0]?.ethWalletAddress;
    return typeof w === 'string' && ADDR.test(w) ? w : null;
  } catch { return null; }
}

export const shortWallet = (w) => (w ? `${w.slice(0, 6)}…${w.slice(-4)}` : '');
