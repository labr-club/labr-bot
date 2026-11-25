/**
 * Labr token access: config, balance rules, AI caps, and the bot.js pieces that
 * use them (holder-only host key, payout holder check).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseUnits, parseAccessConfig, perDayFor, createErc20Reader, createTokenAccess,
  createDailyCounter, walletFromLookup, shortWallet,
} from '../token-access.js';
import { parseExclude, groundCheck } from '../payout-proposal.js';

const TOKEN = '0x' + 'ab'.repeat(20);
const W1 = '0x' + '11'.repeat(20);
const W2 = '0x' + '22'.repeat(20);

test('parseUnits handles whole and fractional amounts', () => {
  assert.equal(parseUnits('1000', 18), 1000n * 10n ** 18n);
  assert.equal(parseUnits('2.5', 6), 2_500_000n);
  assert.equal(parseUnits('0.000001', 6), 1n);
  assert.throws(() => parseUnits('0.0000001', 6));
  assert.throws(() => parseUnits('-1', 6));
  assert.throws(() => parseUnits('1e3', 6));
});

test('config: off without ACCESS_TOKEN, strict when on', () => {
  assert.equal(parseAccessConfig({}), null);
  assert.throws(() => parseAccessConfig({ ACCESS_TOKEN: 'nope', ACCESS_MIN: '1' }), /0x token address/);
  assert.throws(() => parseAccessConfig({ ACCESS_TOKEN: TOKEN }), /ACCESS_MIN/);
  assert.throws(() => parseAccessConfig({ ACCESS_TOKEN: TOKEN, ACCESS_MIN: '0' }), /ACCESS_MIN/);
  assert.throws(() => parseAccessConfig({ ACCESS_TOKEN: TOKEN, ACCESS_MIN: '1', ACCESS_AI_TIERS: '100-20' }), /ACCESS_AI_TIERS/);
  assert.throws(() => parseAccessConfig({ ACCESS_TOKEN: TOKEN, ACCESS_MIN: '1', ACCESS_CHAIN_ID: '1' }), /ACCESS_RPC_URL/);

  const cfg = parseAccessConfig({ ACCESS_TOKEN: TOKEN.toUpperCase().replace('0X', '0x'), ACCESS_MIN: '1000' });
  assert.equal(cfg.token, TOKEN);
  assert.equal(cfg.chainId, 8453);
  assert.equal(cfg.rpcUrl, 'https://mainnet.base.org');
  assert.equal(cfg.role, 'Holder');
  assert.deepEqual([...cfg.exemptRoles], ['Maintainer', 'Contributor']);
  assert.deepEqual(cfg.tiers, [{ held: '1000', perDay: 20 }], 'default: one tier at the minimum');
  assert.equal(cfg.recheckMs, 360 * 60_000);

  const tiered = parseAccessConfig({ ACCESS_TOKEN: TOKEN, ACCESS_MIN: '1000', ACCESS_AI_TIERS: '1000:20, 10000:100', ACCESS_ROLE: 'Member' });
  assert.deepEqual(tiered.tiers, [{ held: '1000', perDay: 20 }, { held: '10000', perDay: 100 }]);
  assert.equal(tiered.role, 'Member');
});

test('perDayFor picks the highest tier reached', () => {
  const tiers = [{ heldUnits: 100n, perDay: 20 }, { heldUnits: 1000n, perDay: 100 }];
  assert.equal(perDayFor(99n, tiers), 0);
  assert.equal(perDayFor(100n, tiers), 20);
  assert.equal(perDayFor(999n, tiers), 20);
  assert.equal(perDayFor(5000n, tiers), 100);
});

function rpcStub(balances, { decimals = 18, symbol = 'LABR' } = {}) {
  const calls = [];
  const enc = (s) => {
    const hex = Buffer.from(s).toString('hex');
    return '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + hex.padEnd(64, '0');
  };
  const fetchImpl = async (url, init) => {
    const { params: [{ to, data }] } = JSON.parse(init.body);
    calls.push({ url, to, data });
    let result;
    if (data === '0x313ce567') result = '0x' + decimals.toString(16).padStart(64, '0');
    else if (data === '0x95d89b41') result = enc(symbol);
    else if (data.startsWith('0x70a08231')) {
      const who = '0x' + data.slice(-40);
      result = '0x' + (balances[who] ?? 0n).toString(16).padStart(64, '0');
    } else throw new Error('unexpected call ' + data);
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) };
  };
  return { fetchImpl, calls };
}

test('erc20 reader encodes balanceOf and decodes decimals and symbol', async () => {
  const { fetchImpl, calls } = rpcStub({ [W1]: 42n }, { decimals: 6, symbol: 'OSC' });
  const r = createErc20Reader({ rpcUrl: 'https://rpc.test', token: TOKEN, fetchImpl });
  assert.equal(await r.decimals(), 6);
  assert.equal(await r.symbol(), 'OSC');
  assert.equal(await r.balanceOf(W1.toUpperCase().replace('0X', '0x')), 42n);
  assert.equal(calls.at(-1).data, '0x70a08231' + '0'.repeat(24) + W1.slice(2));
  assert.equal(calls.at(-1).to, TOKEN);
});

test('erc20 reader surfaces RPC errors instead of reading them as zero', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { message: 'execution reverted' } }) });
  const r = createErc20Reader({ rpcUrl: 'x', token: TOKEN, fetchImpl });
  await assert.rejects(r.balanceOf(W1), /execution reverted/);
  const down = createErc20Reader({ rpcUrl: 'x', token: TOKEN, fetchImpl: async () => ({ ok: false, status: 503 }) });
  await assert.rejects(down.balanceOf(W1), /503/);
});

function makeAccess({ balances, wallets, now = () => 0, tiers = '1000:20,10000:100' }) {
  const cfg = parseAccessConfig({ ACCESS_TOKEN: TOKEN, ACCESS_MIN: '1000', ACCESS_AI_TIERS: tiers });
  const { fetchImpl, calls } = rpcStub(balances);
  const resolved = [];
  const access = createTokenAccess({
    cfg,
    resolve: async (r) => { resolved.push(r); return wallets[r.id ?? r.username] ?? null; },
    reader: createErc20Reader({ rpcUrl: 'x', token: TOKEN, fetchImpl }),
    now,
  });
  return { access, calls, resolved };
}
const units = (n) => BigInt(n) * 10n ** 18n;

test('check: holder at the minimum, tiers by holdings, no wallet means no access', async () => {
  const { access } = makeAccess({
    balances: { [W1]: units(1000), [W2]: units(999) },
    wallets: { alice: W1, bob: W2 },
  });
  await assert.rejects(access.check({ type: 'discord', id: 'alice' }), /not ready/);
  assert.deepEqual(await access.ready(), { decimals: 18, symbol: 'LABR' });
  assert.deepEqual(await access.check({ type: 'discord', id: 'alice' }), { wallet: W1, holder: true, perDay: 20 });
  assert.deepEqual(await access.check({ type: 'discord', id: 'bob' }), { wallet: W2, holder: false, perDay: 0 });
  assert.deepEqual(await access.check({ type: 'discord', id: 'nobody' }), { wallet: null, holder: false, perDay: 0 });
});

test('check: balances are cached for 10 minutes unless fresh is asked for', async () => {
  let t = 0;
  const balances = { [W1]: units(20000) };
  const { access, calls } = makeAccess({ balances, wallets: { alice: W1 }, now: () => t });
  await access.ready();
  assert.equal((await access.check({ type: 'discord', id: 'alice' })).perDay, 100);
  balances[W1] = 0n;
  const reads = () => calls.filter((c) => c.data.startsWith('0x70a08231')).length;
  assert.equal((await access.check({ type: 'discord', id: 'alice' })).perDay, 100, 'cached');
  assert.equal(reads(), 1);
  assert.equal((await access.check({ type: 'discord', id: 'alice' }, { fresh: true })).holder, false, 'fresh read');
  balances[W1] = units(5000);
  t = 11 * 60_000;
  assert.equal((await access.check({ type: 'discord', id: 'alice' })).perDay, 20, 'cache expired');
});

test('daily counter: caps per user per UTC day, a refused message is not counted', () => {
  let t = Date.parse('2026-12-01T23:59:00Z');
  const c = createDailyCounter({ now: () => t });
  assert.equal(c.take('u', 2), true);
  assert.equal(c.take('u', 2), true);
  assert.equal(c.take('u', 2), false);
  assert.equal(c.used('u'), 2);
  assert.equal(c.take('other', 2), true, 'per user');
  assert.equal(c.take('u', 0), false, 'zero cap blocks');
  t = Date.parse('2026-12-02T00:00:01Z');
  assert.equal(c.used('u'), 0, 'resets at 00:00 UTC');
  assert.equal(c.take('u', 2), true);
});

test('walletFromLookup and shortWallet', () => {
  assert.equal(walletFromLookup({ results: [{ ethWalletAddress: W1 }] }), W1);
  assert.equal(walletFromLookup(JSON.stringify({ results: [{ ethWalletAddress: W1 }] })), W1);
  assert.equal(walletFromLookup({ status: 'processing' }), null);
  assert.equal(walletFromLookup('not json'), null);
  assert.equal(walletFromLookup({ results: [{ ethWalletAddress: '0x12' }] }), null);
  assert.equal(shortWallet(W1), '0x1111…1111');
});

test('payout exclude: names are parsed strictly and must be in the request', () => {
  assert.deepEqual(parseExclude(' @Bob, alice ,bob'), ['alice', 'bob']);
  assert.deepEqual(parseExclude(undefined), []);
  assert.throws(() => parseExclude('a b'), /not a GitHub username/);
  const ask = 'pay o/r 100 for the last 7 days, leave out bob and alice';
  assert.equal(groundCheck({ repo: 'o/r', budget: '100', since: '7d', exclude: 'bob,alice' }, ask), null);
  assert.match(groundCheck({ repo: 'o/r', budget: '100', since: '7d', exclude: 'carol' }, ask), /carol/);
  assert.equal(groundCheck({ repo: 'o/r', budget: '100', since: '7d' }, ask), null, 'no exclude is fine');
});

// ─── bot.js pieces ───────────────────────────────────────────────────────────

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bot.js'), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\b[\\s\\S]*?\\n}`, 'm'));
  if (!m) throw new Error(`Could not find function ${name} in bot.js`);
  return m[0];
};
const build = (names, deps) =>
  new Function(...Object.keys(deps), `${names.map(grab).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));
const member = (...roles) => ({ roles: { cache: { map: (f) => roles.map((name) => f({ name })) } } });

test('host key: the holder role unlocks it, and only holder-only members are capped', () => {
  const deps = {
    ACCESS: { role: 'Holder' },
    BOT_OWNER_ID: 'owner',
    HOST_KEY_USERS: new Set(['listed']),
    HOST_KEY_ROLES: new Set(['Maintainer', 'Contributor']),
  };
  const { mayUseHostKey, hostKeyViaHolderOnly } = build(['mayUseHostKey', 'hostKeyViaHolderOnly'], deps);
  assert.equal(mayUseHostKey('u', 'u', member('Holder')), true);
  assert.equal(mayUseHostKey('u', 'u', member()), false);
  assert.equal(hostKeyViaHolderOnly('u', 'u', member('Holder')), true, 'capped');
  assert.equal(hostKeyViaHolderOnly('u', 'u', member('Holder', 'Contributor')), false, 'Contributor is not capped');
  assert.equal(hostKeyViaHolderOnly('owner', 'x', member('Holder')), false, 'owner is not capped');
  assert.equal(hostKeyViaHolderOnly('u', 'listed', member('Holder')), false, 'listed user is not capped');

  const off = build(['mayUseHostKey', 'hostKeyViaHolderOnly'], { ...deps, ACCESS: null });
  assert.equal(off.mayUseHostKey('u', 'u', member('Holder')), false, 'with access off the role means nothing');
  assert.equal(off.hostKeyViaHolderOnly('u', 'u', member('Holder')), false);
});

test('payout holder check: pays only when every paid contributor holds; off means pass-through', async () => {
  const make = (holders, { ready = true, on = true, fail = null } = {}) => build(['payoutHolderCheck', 'gatedPayoutExecute'], {
    ACCESS: { min: '1000' },
    tokenAccess: on ? {
      isReady: ready,
      symbol: 'LABR',
      check: async (r) => { if (fail === r.username) throw new Error('lookup down'); return { holder: holders.includes(r.username) }; },
    } : null,
    roundContributors: () => [{ github: 'alice' }, { github: 'bob' }],
    payoutExecute: async () => ({ status: 'ok', executed: true }),
    console: { log() {} },
  });
  assert.equal((await make(['alice', 'bob']).gatedPayoutExecute({ label: 'r' })).status, 'ok');
  const one = await make(['alice']).gatedPayoutExecute({ label: 'r' });
  assert.equal(one.status, 'refused');
  assert.match(one.error, /@bob doesn't hold at least 1000 LABR/);
  assert.match(one.error, /excluding them/);
  const both = await make([]).gatedPayoutExecute({ label: 'r' });
  assert.match(both.error, /@alice, @bob don't hold/);
  assert.match((await make([], { ready: false }).gatedPayoutExecute({ label: 'r' })).error, /not running/, 'not ready pays nobody');
  assert.match((await make(['alice', 'bob'], { fail: 'bob' }).gatedPayoutExecute({ label: 'r' })).error, /could not check @bob/, 'a failed check pays nobody');
  assert.equal((await make([], { on: false }).gatedPayoutExecute({ label: 'r' })).status, 'ok', 'access off: unchanged');
});
