// Typed @names (not Discord mentions) are looked up among the server's members,
// in channels and in DMs; model text from separate rounds doesn't run together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'bot.js'), 'utf8');
const grab = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\b[\\s\\S]*?\\n}`, 'm'));
  if (!m) throw new Error(`Could not find function ${name} in bot.js`);
  return m[0];
};
const build = (names, deps) =>
  new Function(...Object.keys(deps), `${names.map(grab).join('\n')}\nreturn { ${names.join(', ')} };`)(...Object.values(deps));

function members(list) {
  const map = new Map(list.map((u) => [u.id, { id: u.id, user: { username: u.username, globalName: u.globalName ?? null, bot: !!u.bot }, displayName: u.globalName ?? u.username, nickname: null }]));
  return {
    has: (id) => map.has(id),
    filter: (fn) => {
      const hits = [...map.values()].filter(fn);
      return { size: hits.length, first: () => hits[0], values: () => hits.values() };
    },
  };
}
const guild = { members: { cache: members([
  { id: '1', username: 'justin.ahn.eth' },
  { id: '2', username: 'guillaumefi', globalName: 'Guillaume' },
  { id: '9', username: 'testing', bot: true },
]) } };
const make = (activeGuild) => build(['resolvePlainNames'], { activeGuild, ensureMembersFetched: async () => {} });
const msg = (content, { inGuild = true, author = '1' } = {}) => ({
  content, guild: inGuild ? guild : null, author: { id: author }, client: { user: { username: 'testing' } },
});

test('a typed @name resolves to the member, in a channel', async () => {
  const r = await make(guild).resolvePlainNames(msg('send 0.01 USDC to @guillaumefi'));
  assert.deepEqual(r.users, [{ id: '2', username: 'guillaumefi', globalName: 'Guillaume' }]);
  assert.match(r.note, /@guillaumefi = Discord ID 2/);
});

test('in a DM it resolves against the bot\'s server, for a member of it', async () => {
  const r = await make(guild).resolvePlainNames(msg('send 0.01 USDC to @guillaumefi', { inGuild: false }));
  assert.equal(r.users[0]?.id, '2');
  const display = await make(guild).resolvePlainNames(msg('pay @Guillaume 1 USDC', { inGuild: false }));
  assert.equal(display.users[0]?.id, '2', 'display name works too');
});

test('a DM from someone outside the server gets no member lookup', async () => {
  const r = await make(guild).resolvePlainNames(msg('send to @guillaumefi', { inGuild: false, author: '77' }));
  assert.deepEqual(r, { users: [], note: '' });
});

test('no server known: nothing resolved, nothing invented', async () => {
  assert.deepEqual(await make(null).resolvePlainNames(msg('send to @guillaumefi', { inGuild: false })), { users: [], note: '' });
});

test('model text from separate rounds is separated by a blank line', () => {
  const { joinText } = build(['joinText'], {});
  assert.equal(joinText('', 'Hi'), 'Hi');
  assert.equal(joinText('Let me look it up first.', 'Found them.'), 'Let me look it up first.\n\nFound them.');
  assert.equal(joinText('a\n', 'b'), 'a\nb');
  assert.equal(joinText('a', ''), 'a');
});
