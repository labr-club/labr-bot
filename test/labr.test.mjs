/**
 * Labr-only behaviour that lives in bot.js: chain names read from Connect, and
 * the #payouts receipt for sends that run later (scheduled, conditional, watcher).
 *
 * bot.js connects to Discord on import, so the functions are extracted from its
 * source and run with stubbed dependencies, like the other tests here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = readFileSync(join(ROOT, 'bot.js'), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\b[\\s\\S]*?\\n}`, 'm'));
  if (!m) throw new Error(`Could not find function ${name} in bot.js — was it renamed?`);
  return m[0];
};
const build = (names, deps) =>
  new Function(...Object.keys(deps), `${names.map(grab).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));

const quiet = { log() {}, warn() {}, error() {} };

test('chain names come from Connect: a new chain is named, testnets are skipped, the fallback stays for the rest', async () => {
  const CHAIN_NAMES = { 8453: 'Base', 42161: 'Arbitrum' };
  const { loadChainNames } = build(['loadChainNames'], {
    CHAIN_NAMES, QUIDLI_API_KEY: 'k', console: quiet,
    mcpCallTool: async (name) => {
      assert.equal(name, 'connect_get_chains');
      return JSON.stringify({ chains: [
        { chainId: 5042, name: 'Arc', isTestnet: false },
        { chainId: 42161, name: 'Arbitrum One', isTestnet: false },
        { chainId: 4801, name: 'World Chain Sepolia', isTestnet: true },
        { chainId: null, name: 'broken' },
      ] });
    },
  });
  await loadChainNames();
  assert.equal(CHAIN_NAMES[5042], 'Arc');
  assert.equal(CHAIN_NAMES[42161], 'Arbitrum One', "Connect's name wins over the built-in one");
  assert.equal(CHAIN_NAMES[8453], 'Base', 'a chain Connect did not list keeps its fallback name');
  assert.equal(CHAIN_NAMES[4801], undefined);
});

test('the built-in fallback table names every chain the site lists, Arc included', () => {
  const line = SRC.match(/^const CHAIN_NAMES = \{.*\};$/m)?.[0] ?? '';
  for (const name of ['Base', 'Ethereum', 'Optimism', 'Arbitrum', 'Polygon', 'Avalanche', 'World Chain', 'Arc', 'Monad', 'Robinhood Chain', 'Solana']) {
    assert.ok(line.includes(`'${name}'`), `${name} is in CHAIN_NAMES`);
  }
});

function payoutsChannel() {
  const sent = [];
  const ch = { name: 'payouts', isTextBased: () => true, send: async (m) => { sent.push(m); } };
  const activeGuild = { channels: { cache: { find: (fn) => [{ name: 'general', isTextBased: () => true }, ch].find(fn) } } };
  return { sent, activeGuild };
}

test('#payouts receipt: full line when the paying wallet is known', () => {
  const { sent, activeGuild } = payoutsChannel();
  const { postPayoutLog } = build(['formatUnits', 'postPayoutLog'], { activeGuild, CHAIN_NAMES: { 8453: 'Base' }, console: quiet });
  postPayoutLog({
    src: { decimals: 6, symbol: 'USDC', chain: 'Base', who: "@jules's Connect wallet", addr: '0xabc' },
    input: { chainId: 8453, amountInWeiPerRecipient: '2500000', recipients: [{ type: 'discord', id: '1' }, { type: 'github', username: 'kenji-dev' }] },
    senderId: '9', explorerUrl: 'https://basescan.org/tx/0x1', transferHash: '0x1', via: 'scheduled',
  });
  assert.equal(sent.length, 1);
  const text = sent[0].content;
  assert.match(text, /<@9> paid <@1>, github:kenji-dev 2\.5 USDC each on Base \(scheduled\)/);
  assert.match(text, /from @jules's Connect wallet `0xabc`/);
  assert.match(text, /https:\/\/basescan\.org\/tx\/0x1$/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] }, 'a receipt never pings anyone');
});

test('#payouts receipt: still posted when the paying wallet could not be read', () => {
  const { sent, activeGuild } = payoutsChannel();
  const { postPayoutLog } = build(['formatUnits', 'postPayoutLog'], { activeGuild, CHAIN_NAMES: { 5042: 'Arc' }, console: quiet });
  postPayoutLog({ src: null, input: { chainId: 5042, amountInWeiPerRecipient: '1', recipients: [{ type: 'discord', id: '1' }] }, senderId: '9', explorerUrl: null, transferHash: '0xdead', via: 'watcher' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /<@9> paid <@1> on Arc \(watcher\)\ntx `0xdead`$/);
  assert.doesNotMatch(sent[0].content, /undefined|null/);
});

test('#payouts receipt: no channel called payouts means no post and no error', () => {
  const { postPayoutLog } = build(['formatUnits', 'postPayoutLog'], { activeGuild: null, CHAIN_NAMES: {}, console: quiet });
  assert.doesNotThrow(() => postPayoutLog({ src: null, input: {}, senderId: '9', transferHash: '0x1' }));
});

function autoSend({ dropSource, hasKey = true } = {}) {
  const posts = [];
  const fns = build(['logAutoSend'], {
    console: quiet,
    getUserApiKey: () => (hasKey ? 'user-key' : null),
    client: { users: { fetch: async (id) => ({ id, username: 'jules' }) } },
    dropSource: dropSource ?? (async () => ({ label: "@jules's Connect wallet (`0xabc…1234`) on Base", chain: 'Base', symbol: 'USDC', decimals: 6, addr: '0xabc', who: "@jules's Connect wallet" })),
    postPayoutLog: (x) => posts.push(x),
  });
  return { ...fns, posts };
}
const sentResult = { transferHash: '0x1', explorerUrl: 'https://basescan.org/tx/0x1' };
const input = { chainId: 8453, amountInWeiPerRecipient: '1000000', recipients: [{ type: 'discord', id: '1' }] };

test('a later send posts one receipt and returns the "Paid from" line for the sender', async () => {
  const { logAutoSend, posts } = autoSend();
  const line = await logAutoSend({ input, keyToUse: 'user-key', senderId: '9', result: sentResult, via: 'scheduled' });
  assert.equal(line, "\n-# Paid from: @jules's Connect wallet (`0xabc…1234`) on Base");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].via, 'scheduled');
  assert.equal(posts[0].senderId, '9');
  assert.equal(posts[0].transferHash, '0x1');
  assert.equal(posts[0].explorerUrl, 'https://basescan.org/tx/0x1');
});

test('a later send that did not go through posts nothing', async () => {
  const { logAutoSend, posts } = autoSend();
  assert.equal(await logAutoSend({ input, keyToUse: 'k', senderId: '9', result: { error: 'insufficient funds' }, via: 'conditional' }), '');
  assert.equal(posts.length, 0);
});

test('a later send is still recorded when the wallet read fails, and never throws', async () => {
  const unreadable = autoSend({ dropSource: async () => ({ label: null, line: null, problem: null }) });
  assert.equal(await unreadable.logAutoSend({ input, keyToUse: 'k', senderId: '9', result: sentResult, via: 'watcher' }), '');
  assert.equal(unreadable.posts.length, 1);
  assert.equal(unreadable.posts[0].src, null);

  const throwing = autoSend({ dropSource: async () => { throw new Error('boom'); } });
  assert.equal(await throwing.logAutoSend({ input, keyToUse: 'k', senderId: '9', result: sentResult, via: 'watcher' }), '');
});

test('every send path that runs later calls logAutoSend with its own label', () => {
  for (const [fn, via] of [['executeScheduledDrop', 'scheduled'], ['executeConditionalDrop', 'conditional'], ['checkWatchers', 'watcher']]) {
    const body = grab(fn);
    assert.match(body, /await quidliDrop\(/, `${fn} sends through quidliDrop`);
    assert.match(body, new RegExp(`logAutoSend\\(\\{[^}]*via: '${via}'`), `${fn} posts a ${via} receipt`);
  }
});

test('the Labr prompt file exists, names Labr, and carries the chain rule', () => {
  const prompt = readFileSync(join(ROOT, 'labr-prompt.txt'), 'utf8');
  assert.ok(prompt.startsWith('You are Labr'));
  assert.match(prompt, /call connect_get_chains first/);
  assert.doesNotMatch(prompt, /`/, 'no backticks: the prompt may still be embedded in .env');
  assert.doesNotMatch(prompt, /bounty|airdrop/i);
});

test('server allowlist: listed servers stay, others are left, and their messages are ignored', () => {
  const left = [];
  const make = (ids) => new Function('ALLOWED_GUILDS', 'console',
    `${SRC.match(/^const guildAllowed = .*$/m)[0]}\n${grab('leaveIfNotAllowed')}\nreturn { guildAllowed, leaveIfNotAllowed };`)(new Set(ids), quiet);
  const guild = (id) => ({ id, name: `g${id}`, leave: async () => { left.push(id); } });

  const open = make([]);
  assert.equal(open.guildAllowed('1'), true, 'empty allowlist = any server');
  assert.equal(open.leaveIfNotAllowed(guild('1')), false);

  const closed = make(['1560388923770019940']);
  assert.equal(closed.guildAllowed('1560388923770019940'), true);
  assert.equal(closed.leaveIfNotAllowed(guild('1560388923770019940')), false);
  assert.equal(closed.leaveIfNotAllowed(guild('42')), true);
  assert.deepEqual(left, ['42']);

  assert.match(SRC, /client\.on\(Events\.MessageCreate, async \(message\) => \{\n  if \(message\.author\.bot\) return;\n  if \(message\.guild && !guildAllowed\(message\.guild\.id\)\) return;/,
    'a message from a server that is not allowed is dropped before anything else runs');
  assert.match(SRC, /client\.on\(Events\.GuildCreate, \(guild\) => \{ leaveIfNotAllowed\(guild\); \}\);/);
});
