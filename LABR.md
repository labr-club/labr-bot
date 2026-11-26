# Labr bot

This repo is the bot that runs as **Labr** in the Labr Discord. It is
[DiscoCentaur](https://github.com/justinquidli/discocentaur) plus the Labr
changes below, kept as commits on top of DiscoCentaur's `main` so they can be
rebased when DiscoCentaur moves.

Base: DiscoCentaur `b764cf1` (2026-11-12).

The `labr-running` branch is a byte-exact snapshot of the code that ran on the
Mac mini before the first update from this repo (2026-11-16). Two things in
`main` were **not** in that running code, so they go live with the first update:
the plain-text @name lookup with the "this pays you" hold (`labr-names.patch`),
and the wording rule (`labr-wording.patch`). Until then the running bot still
said the treasury "funds bounties".

## What Labr adds

| Change | What it does |
|---|---|
| Server allowlist | `DISCORD_ALLOWED_GUILDS`: the bot leaves any server not listed. |
| Who pays | Everyone pays from their own linked Connect key. With `OWNER_USES_HOST_KEY=false` the owner does too. The bot writes the "Paying from / Paid from" line itself. |
| Checks before sending | Balance check, no sends to the bot itself, and a hold for `!confirm` when a recipient or amount is not in the sender's message, when the send pays the sender, or when it is over `MAX_SEND_USD` / `DAILY_SEND_USD`. |
| Receipts | Every Connect send is posted to `#payouts`, including scheduled, conditional and watcher sends. |
| Wallet facts | The bot reads its wallets at startup and answers "what's your wallet" with the treasury only. No balances in public lines. |
| Names | Plain-text @names are looked up among server members. |
| Wording | Treasury "funds paid tasks". The bot never says "bounty" or "airdrop". |
| Chains | Chain names in bot-written lines come from Connect at startup, with a built-in fallback. `DEFAULT_CHAIN=base` (default, gas sponsored) or `solana` sets the chain for sends that name none; setup asks. |
| Prompt | `SYSTEM_PROMPT_FILE=labr-prompt.txt`: the prompt lives in this repo, not inline in `.env`. |
| Payout approval | `!confirm` by default. World ID is opt-in with `PAYOUT_APPROVAL=world_id`. |
| No Minds | The Minds (Animoca Brands) provider is removed: no `!minds` commands, no "switch to minds", no `@animocabrands/minds-client-lib` dependency. The unused `minds_*` columns stay in `users.db`. |

## Token access

Off unless `ACCESS_TOKEN` is set (see `.env.example`). One token, three unlocks:

| Unlock | How |
|---|---|
| The server | Holders get `ACCESS_ROLE` (default `Holder`); Discord channel permissions do the rest. Checked on join, on `!verify`, and for every member every `ACCESS_RECHECK_MIN` (default 6 h). A failed check (Connect or the RPC down) changes nothing. `!verify` never shows a wallet in a channel (linked wallets are private in Connect); the details go by DM. |
| Shared AI key | The holder role counts as a host-key role. Members who have it and nothing else (not the owner, not in `HOST_KEY_ALLOWED_USERS`, no role in `HOST_KEY_ALLOWED_ROLES`) get `ACCESS_AI_TIERS` messages per UTC day, by how much they hold. Counts live in `users.db` (`ai_usage`). |
| Treasury payouts | Right before a payout runs, every contributor it pays must hold the minimum on the wallet their GitHub resolves to. Otherwise nothing is paid and the bot names who to leave out. The payout tool takes `exclude` (GitHub usernames the user wrote) for the re-run. |

Which wallet counts is Connect's answer for the handle: members who hold in another wallet link it at connect.quid.li and pick it as the wallet for their Discord (and GitHub) account. Holdings are read with `balanceOf` on `ACCESS_CHAIN_ID`; one wallet per handle, not a sum.

Setup in Discord: create the `Holder` role, put the bot's role above it, give `@everyone` only `#welcome`, `#rules` and a `#get-access` channel, and open the rest to `Holder`, `Maintainer` and `Contributor`.

## Not covered

- `bankr_swap_and_drop` sends are not posted to `#payouts` (the Labr instance runs without a Bankr key).
- The contributor `payout` tool pays through the payout CLI and reports in the channel it was asked in, not in `#payouts`.
- Scheduled, conditional and watcher sends are checked against the limits when they are created, and are not added to the daily total when they run.

## Contributor payouts: `!confirm` by default, World ID optional

DiscoCentaur `cfb8e1d` made World ID the only way to approve the `payout` tool.
Labr reverses the default: the owner approves a payout with the `!confirm` code,
like any other held send. World ID stays available as an option:

```
PAYOUT_APPROVAL=world_id
WORLD_ID_CLIENT_ID=...
WORLD_ID_CLIENT_SECRET=...
WORLD_ID_TREASURER_SUBS=...
```

With `PAYOUT_APPROVAL=world_id` set but the `WORLD_ID_*` values missing, payouts
are disabled; the bot does not fall back to `!confirm` in that case. The startup
log prints the mode as `Payout approval: ...`.

## Settings the Labr instance uses

```
SYSTEM_PROMPT_FILE=labr-prompt.txt
DISCORD_ALLOWED_GUILDS=<Labr server id>
OWNER_USES_HOST_KEY=false
HOST_KEY_ALLOWED_ROLES=Maintainer,Contributor
# no BANKR_API_KEY on purpose
# optional: MAX_SEND_USD (default 50), DAILY_SEND_USD (default 200)
# token access, once the token exists: ACCESS_TOKEN, ACCESS_MIN, ACCESS_AI_TIERS
```

## Updating the running bot

`deploy/update-labr.sh` does this on the machine that runs the bot. It backs up
the current directory first and stops if the running code differs from what
this repo was built from.

```
bash deploy/update-labr.sh
```

## Tests

```
npm ci
npm run check
```

## Rebasing onto a newer DiscoCentaur

```
git remote add upstream https://github.com/justinquidli/discocentaur
git fetch upstream
git rebase upstream/main
npm run check
```

If DiscoCentaur's built-in prompt changed, merge those changes into
`labr-prompt.txt` as well: the Labr prompt replaces the built-in one, so prompt
fixes upstream do not reach Labr on their own.
