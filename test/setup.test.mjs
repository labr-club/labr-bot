// npm run setup: the pieces that decide what gets written and checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTENTS, missingIntents, inviteUrl, BOT_PERMISSIONS, looksUnset, parseEnv, renderEnv,
  checkDiscord, enableIntents, checkAnthropic, checkConnect, botGuilds, chainChoices,
} from '../scripts/setup.mjs';

const all = INTENTS.reduce((m, i) => m | i.limited, 0);

test('intents: full or limited flag both count; missing ones are named', () => {
  assert.deepEqual(missingIntents(all), []);
  assert.deepEqual(missingIntents((1 << 18) | (1 << 14) | (1 << 12)), [], 'verified-app flags count too');
  assert.deepEqual(missingIntents(0).map((i) => i.name), ['Message Content', 'Server Members', 'Presence']);
  assert.deepEqual(missingIntents(1 << 19).map((i) => i.name), ['Server Members', 'Presence']);
});

test('invite link asks for exactly the permissions Labr uses, including Manage Roles', () => {
  const u = new URL(inviteUrl('123'));
  assert.equal(u.searchParams.get('client_id'), '123');
  assert.equal(u.searchParams.get('scope'), 'bot');
  const p = BigInt(u.searchParams.get('permissions'));
  for (const bit of [10n, 11n, 13n, 14n, 15n, 16n, 28n]) assert.ok(p & (1n << bit), `bit ${bit}`);
  assert.equal(p & (1n << 3n), 0n, 'never Administrator');
});

test('env: placeholders count as unset; values are parsed and rewritten with Labr defaults first', () => {
  assert.ok(looksUnset('your_discord_bot_token_here'));
  assert.ok(looksUnset(''));
  assert.ok(!looksUnset('abc'));
  const old = parseEnv('DISCORD_TOKEN=your_discord_bot_token_here\nBRAVE_SEARCH_API_KEY="brave"\n# c\nGEMINI_API_KEY=\nMAX_SEND_USD=25\n');
  assert.equal(old.get('BRAVE_SEARCH_API_KEY'), 'brave');
  const out = renderEnv({ DISCORD_TOKEN: 't', ANTHROPIC_API_KEY: 'a', QUIDLI_API_KEY: 'q', MASTER_ENCRYPTION_KEY: 'm', SYSTEM_PROMPT_FILE: 'labr-prompt.txt', OWNER_USES_HOST_KEY: 'false' }, old);
  const env = parseEnv(out);
  assert.equal(env.get('DISCORD_TOKEN'), 't');
  assert.equal(env.get('SYSTEM_PROMPT_FILE'), 'labr-prompt.txt');
  assert.equal(env.get('OWNER_USES_HOST_KEY'), 'false');
  assert.equal(env.get('BRAVE_SEARCH_API_KEY'), 'brave', 'other settings are kept');
  assert.equal(env.get('MAX_SEND_USD'), '25');
  assert.ok(!env.has('GEMINI_API_KEY'), 'empty leftovers are dropped');
  assert.ok(!env.has('DISCORD_ALLOWED_GUILDS'), 'nothing invented');
  assert.ok(out.indexOf('DISCORD_TOKEN') < out.indexOf('BRAVE_SEARCH_API_KEY'));
});

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('discord check: owner comes from the app or its team; a bad token says what to do', async () => {
  const solo = await checkDiscord('t', async () => reply(200, { id: 'A', name: 'Bot', owner: { id: 'U1' }, flags: all }));
  assert.deepEqual(solo, { ok: true, appId: 'A', name: 'Bot', ownerId: 'U1', flags: all });
  const team = await checkDiscord('t', async () => reply(200, { id: 'A', name: 'Bot', owner: { id: 'TEAMUSER' }, team: { owner_user_id: 'U2' }, flags: 0 }));
  assert.equal(team.ownerId, 'U2');
  const badTok = await checkDiscord('t', async () => reply(401, {}));
  assert.equal(badTok.ok, false);
  assert.match(badTok.why, /Reset Token/);
});

test('intents are switched on through the API when Discord allows it, and re-read to confirm', async () => {
  let flags = 1 << 19;
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(init.method ?? 'GET');
    if (init.method === 'PATCH') { flags = JSON.parse(init.body).flags; return reply(200, {}); }
    return reply(200, { id: 'A', name: 'B', owner: { id: 'U' }, flags });
  };
  assert.deepEqual(await enableIntents('t', flags, fetchImpl), []);
  assert.equal(flags, all, 'only the limited flags are sent');
  assert.deepEqual(calls, ['PATCH', 'GET']);

  const refuses = async (url, init = {}) => (init.method === 'PATCH' ? reply(403, {}) : reply(200, { id: 'A', flags: 0 }));
  assert.deepEqual((await enableIntents('t', 0, refuses)).map((i) => i.name), ['Message Content', 'Server Members', 'Presence'], 'falls back to the manual step');
  assert.deepEqual(await enableIntents('t', all, async () => { throw new Error('no call expected'); }), [], 'nothing to do');
});

test('anthropic and connect checks', async () => {
  let sent;
  assert.equal((await checkAnthropic('k', async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return reply(200, {}); })).ok, true);
  assert.match(sent.url, /\/v1\/messages$/, 'a real request, not a model listing');
  assert.equal(sent.body.max_tokens, 1);
  assert.match((await checkAnthropic('k', async () => reply(401, { error: { message: 'invalid x-api-key' } }))).why, /rejected/);
  const broke = await checkAnthropic('k', async () => reply(400, { error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }));
  assert.equal(broke.noCredit, true);
  assert.match(broke.why, /no credit.*billing/);
  assert.deepEqual(await checkAnthropic('k', async () => reply(529, {})), { ok: true, busy: true }, 'overloaded still means the key works');
  assert.match((await checkAnthropic('k', async () => reply(403, { error: { message: 'no access' } }))).why, /can't use/);

  const tools = { connect_me: { profile: { username: 'ana' } }, connect_drop_balance: { walletAddress: '0xabc' } };
  const mcp = async (url, init) => {
    const { params } = JSON.parse(init.body);
    assert.equal(init.headers['x-api-key'], 'k');
    return reply(200, { result: { content: [{ type: 'text', text: JSON.stringify(tools[params.name]) }] } });
  };
  assert.deepEqual(await checkConnect('k', mcp), { ok: true, username: 'ana', smartSendWallet: '0xabc', lowGas: false });
  assert.match((await checkConnect('k', async () => reply(401, {}))).why, /connect\.quid\.li/);
  const noSmartSend = async (url, init) => {
    const { params } = JSON.parse(init.body);
    if (params.name === 'connect_drop_balance') return reply(200, { result: { isError: true, content: [{ type: 'text', text: 'Smart Send not enabled' }] } });
    return mcp(url, init);
  };
  assert.equal((await checkConnect('k', noSmartSend)).smartSendWallet, null);
});

test('guilds the bot is in', async () => {
  assert.deepEqual(await botGuilds('t', async () => reply(200, [{ id: '1', name: 'S', icon: null }])), [{ id: '1', name: 'S' }]);
  assert.deepEqual(await botGuilds('t', async () => reply(401, {})), []);
});

import { checkOpenAICompatible, checkGemini, checkProvider, checkNous, PROVIDERS } from '../scripts/setup.mjs';

test('providers: four choices, Anthropic first and marked recommended', () => {
  assert.deepEqual(PROVIDERS.map((p) => p.id), ['anthropic', 'openai', 'gemini', 'hermes']);
  assert.match(PROVIDERS[0].label, /recommended/);
});

test('OpenAI-compatible check: one-token request; bad key, no credit, wrong model, busy', async () => {
  const cfg = { baseURL: 'https://x/v1', key: 'k', model: 'm', billing: 'https://bill' };
  let sent;
  assert.deepEqual(await checkOpenAICompatible(cfg, async (url, init) => { sent = { url, init }; return reply(200, {}); }), { ok: true });
  assert.equal(sent.url, 'https://x/v1/chat/completions');
  assert.equal(sent.init.headers.authorization, 'Bearer k');
  assert.equal(JSON.parse(sent.init.body).max_tokens, 1);
  assert.match((await checkOpenAICompatible(cfg, async () => reply(401, { error: { message: 'bad' } }))).why, /rejected/);
  const broke = await checkOpenAICompatible(cfg, async () => reply(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }));
  assert.equal(broke.noCredit, true);
  assert.match(broke.why, /https:\/\/bill/);
  assert.match((await checkOpenAICompatible(cfg, async () => reply(404, { error: { code: 'model_not_found', message: 'nope' } }))).why, /can't use m/);
  assert.deepEqual(await checkOpenAICompatible(cfg, async () => reply(429, { error: { message: 'Rate limit reached' } })), { ok: true, busy: true });
});

test('Gemini check: picks a Flash model the key can use, then tries it', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push([init.method ?? 'GET', url.replace(/key=[^&]+/, 'key=K')]);
    if (!init.method) return reply(200, { models: [
      { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.0-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] });
    return reply(200, {});
  };
  assert.deepEqual(await checkGemini('K', undefined, fetchImpl), { ok: true, model: 'gemini-3.0-flash', busy: false });
  assert.match(calls[1][1], /models\/gemini-3\.0-flash:generateContent/);
  assert.equal((await checkGemini('K', 'gemini-2.5-pro', fetchImpl)).model, 'gemini-2.5-pro', 'a model already set is kept');
  assert.match((await checkGemini('K', undefined, async () => reply(400, {}))).why, /rejected/);
  assert.match((await checkGemini('K', undefined, async () => reply(200, { models: [] }))).why, /no Gemini model/);
});

test('checkProvider routes each provider to its API', async () => {
  const seen = [];
  const f = async (url) => {
    seen.push(new URL(url).host);
    return reply(200, {
      models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }],
      data: [{ id: 'a/b:free', supported_parameters: ['tools'] }],
      choices: [{ message: {} }],
    });
  };
  for (const id of ['anthropic', 'openai', 'hermes', 'gemini']) assert.equal((await checkProvider(id, 'k', {}, f)).ok, true, id);
  assert.deepEqual([...new Set(seen)], ['api.anthropic.com', 'api.openai.com', 'inference-api.nousresearch.com', 'generativelanguage.googleapis.com']);
});

test('Nous check: uses a live free model that answers a tool call, skipping ones that fail', async () => {
  const tried = [];
  const f = async (url, init = {}) => {
    if (!init.method) return reply(200, { data: [
      { id: 'old/gone', supported_parameters: ['tools'] },
      { id: 'x/no-tools:free', supported_parameters: [] },
      { id: 'y/broken:free', supported_parameters: ['tools'] },
      { id: 'z/works:free', supported_parameters: ['tools'] },
    ] });
    const { model, tools } = JSON.parse(init.body);
    tried.push(model);
    assert.ok(tools?.length, 'probes with a tool');
    return model === 'z/works:free' ? reply(200, { choices: [{ message: {} }] }) : reply(400, { message: 'missing tags' });
  };
  assert.deepEqual(await checkNous('k', 'retired/model:free', f), { ok: true, model: 'z/works:free' });
  assert.deepEqual(tried, ['y/broken:free', 'z/works:free'], 'a retired preferred model and tool-less ones are skipped');
  assert.match((await checkNous('k', undefined, async (u, i = {}) => (i.method ? reply(401, {}) : reply(200, { data: [{ id: 'z/w:free', supported_parameters: ['tools'] }] })))).why, /rejected/);
  assert.match((await checkNous('k', undefined, async () => reply(200, { data: [] }))).why, /no free model/);
});

test('Solana as the default chain: setup reads the Solana wallet and warns when SOL is low', async () => {
  const { CHAINS } = await import('../default-chain.js');
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const withSol = (lamports) => async (url, init) => {
    const { params } = JSON.parse(init.body);
    const data = params.name === 'connect_me' ? { profile: { username: 'ana' } }
      : (assert.equal(params.arguments.chainId, 1399811149), { walletAddress: 'So1Wallet', assets: [{ type: 'native', balanceInWei: lamports }] });
    return reply(200, { result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
  };
  const low = await checkConnect('k', withSol('48593'), CHAINS.solana);
  assert.equal(low.smartSendWallet, 'So1Wallet');
  assert.equal(low.lowGas, true);
  assert.equal((await checkConnect('k', withSol('48593121'), CHAINS.solana)).lowGas, false);
});

test('DEFAULT_CHAIN is written to .env', () => {
  assert.match(renderEnv({ DEFAULT_CHAIN: 'solana' }), /DEFAULT_CHAIN=solana/);
});

test('setup offers the chains Connect sends on, Base first; gas warning on any unsponsored chain', async () => {
  const { CHAINS } = await import('../default-chain.js');
  const reply = (status, body) => ({ status, ok: status < 400, json: async () => body });
  const tool = (data) => async () => reply(200, { result: { content: [{ type: 'text', text: JSON.stringify(data) }] } });
  const choices = await chainChoices('k', tool({ chains: [{ chainId: 137, features: { drop: true } }, { chainId: 8453, features: { drop: true } }, { chainId: 4801, isTestnet: true }, { chainId: 42220, features: { drop: false } }] }));
  assert.deepEqual(choices.map((c) => c.slug), ['base', 'polygon']);
  const offline = await chainChoices('k', async () => reply(500, {}));
  assert.equal(offline[0].slug, 'base');
  assert.equal(offline.length, Object.keys(CHAINS).length, 'Connect down: offer every known chain');

  const wallet = (wei) => async (url, init) => {
    const { params } = JSON.parse(init.body);
    return tool(params.name === 'connect_me' ? { profile: { username: 'ana' } } : { walletAddress: '0xw', assets: [{ type: 'native', balanceInWei: wei }] })();
  };
  assert.equal((await checkConnect('k', wallet('0'), CHAINS.polygon)).lowGas, true);
  assert.equal((await checkConnect('k', wallet('5'), CHAINS.polygon)).lowGas, false);
  assert.equal((await checkConnect('k', wallet('0'), CHAINS.base)).lowGas, false, 'Base gas is sponsored');
});
