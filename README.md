# Pump.fun Fee Monitor Bot

TypeScript monitoring bot for the Pump.fun fee-sharing program. It watches governance events over Solana WebSockets, discovers tokens with fee sharing enabled, tracks social recipient PDAs, and detects social fee claims through PDA lamport balance drops.

## Features

- Watches `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` with `connection.onLogs`
- Decodes Pump fee-sharing events with Anchor `EventParser`
- Detects:
  - fee-sharing config creation
  - fee-share updates
  - authority transfer
  - authority revoke / permanent lock
  - config reset
  - social fee PDA creation
  - social recipient claims via `onAccountChange` balance deltas
- Persists tokens, shareholders, social PDAs, balances, and authority history to JSON
- Sends alerts to Telegram
- Bootstraps existing `SharingConfig` accounts on startup so watchers survive restarts

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create your env file:

```bash
cp .env.example .env
```

3. Set at least:

- `RPC_HTTP_URL`
- `RPC_WS_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID` for a single alert destination and Telegram control commands
- `TELEGRAM_CHAT_IDS` optional, comma-separated alert destinations for broadcasting to multiple groups/channels
- `GITHUB_TOKEN` optional, for enriching GitHub social recipients with profile details and avoiding low anonymous GitHub API rate limits

## Alert Filters

All filters are optional. They only suppress alerts; the bot still monitors and stores matching on-chain activity.

- `ALERT_EVENT_TYPES`
  Comma-separated: `create,update,transfer,revoke,reset,claim`
- `ALERT_PLATFORMS`
  Comma-separated social claim platforms: `github,x,pump`
- `ALERT_MINT_ALLOWLIST`
  Comma-separated mint addresses. If set, only those mints alert.
- `ALERT_MINT_BLOCKLIST`
  Comma-separated mint addresses to suppress.
- `ALERT_MIN_CLAIM_SOL`
  Minimum social claim size to alert, in SOL. Example: `0.5`

Example:

```env
ALERT_EVENT_TYPES=create,revoke,claim
ALERT_PLATFORMS=github
ALERT_MIN_CLAIM_SOL=0.25
ALERT_MINT_ALLOWLIST=
ALERT_MINT_BLOCKLIST=
```

## Telegram Commands

If `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are set, the bot also listens for `/filters` commands in that chat and persists the changes locally.
If `TELEGRAM_CHAT_IDS` is set, alerts are broadcast to all listed chats. Control commands still stay bound to the single `TELEGRAM_CHAT_ID`.

Examples:

```text
/start
/settings
/filters
/filters show
/filters reset
/filters events claim,revoke
/filters platforms github
/filters min_claim 0.5
/filters mint_allow add J5qhCKNf9f9BWN9YcNoyvowKSwboLHhi8WJAfAEhBAGS
/filters mint_block add J5qhCKNf9f9BWN9YcNoyvowKSwboLHhi8WJAfAEhBAGS
```

`/settings` opens a button-based Telegram control panel for the supported fee-sharing alerts. `Bonded` and `Migrated` are shown as unavailable placeholders until those monitors are implemented.

## Run

```bash
npm start
```

## Build / Type Check

```bash
npm run build
npm run check
```

## Notes

- The bot vendors the official Pump fee-sharing IDL at [idl/pump_fee_sharing.json](/Users/abhijithvs/Pump fee claim bot/idl/pump_fee_sharing.json).
- Claim detection is driven by social PDA balance deltas. When a matching `SocialFeePdaClaimed` log is available in the same slot, the bot enriches the alert with the recipient wallet without decoding instructions.
- A single social PDA can appear in multiple token configs. Claim alerts therefore include all related mints currently linked to that PDA.
