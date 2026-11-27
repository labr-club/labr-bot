# Labr

Putting the agent economy to work. Labr is a Discord bot that pays the people and agents behind a project: it vets contributors by social reputation, checks the work, and splits the reward onchain, in any token, including your own.

It runs on [Quidli Connect](https://connect.quid.li), so anyone can be paid by their Discord, GitHub or X handle, before they have signed up for anything. Labr takes 0%; the payer covers network gas, sponsored on Base.

More at [labr.club](https://labr.club).

## Quick start (about 5 minutes)

You need [Node.js 22](https://nodejs.org) or newer.

```bash
git clone https://github.com/labr-club/labr-bot.git
cd labr-bot
npm install
npm run setup
```

Setup asks for three keys and checks each one as you go:

1. **Discord bot token.** At [discord.com/developers/applications](https://discord.com/developers/applications): New Application, then Bot, then Reset Token. Setup turns on the permissions the bot needs and finds your Discord user ID for you.
2. **An AI key.** Pick a provider: Anthropic (recommended, Labr is tuned for Claude), OpenAI, Google Gemini or Nous Portal (has a free tier). Setup checks the key with a tiny real request, so a key without credit is caught before the bot starts.
3. **Quidli Connect API key**, from [connect.quid.li](https://connect.quid.li). Turn on Smart Send there and fund the wallet setup shows you with what you'll pay out. Setup also asks for your default chain: any chain Connect sends on. Base is the only one with sponsored gas; on the others, keep some of the chain's gas token in the wallet (SOL, ETH, POL...). People can still name any chain in a request.

Then it prints an invite link. Add the bot to your server, setup sees it join, and starts Labr. Your keys stay in `.env` on your machine.

## Using it

- Mention the bot: `@Labr help`, `@Labr send 5 USDC to @mira`, `@Labr how trusted is @kai?`
- Everyone pays from their own wallet: each member DMs the bot `!connect <their Connect API key>` once.
- Create a `#payouts` channel and every payment is posted there.
- A send the bot isn't sure about waits for `!confirm <code>`.

## Optional

- **Paid tasks for merged pull requests.** Clone [contributor-payout](https://github.com/justinquidli/contributor-payout) next to this folder and fill in its `.env`. Then the bot owner can say `@Labr pay the contributors of owner/repo 500 USDC for the last 7 days`: it scores the merged PRs, posts the split and pays after `!confirm`.
- **Token access.** Give server access, the shared AI key and payouts only to holders of a token. See [Token access](LABR.md#token-access).
- **Run it permanently.** `npm i -g pm2`, then `pm2 start labr.config.cjs && pm2 save`. Logs: `pm2 logs labr`.

## Reference

- [LABR.md](LABR.md): what Labr adds to DiscoCentaur, and every Labr setting.
- [docs/discocentaur.md](docs/discocentaur.md): every command and setting of the underlying bot.
- [.env.example](.env.example): all options, with comments.

Run `npm test` before you push.
