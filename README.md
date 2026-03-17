# Pump.fun Fee Monitor Bot

TypeScript monitoring bot for the Pump.fun fee-sharing program. It watches governance events over Solana WebSockets, tracks social recipient PDAs, detects claim activity from balance deltas, and sends Telegram alerts.

## What It Monitors

- Program: `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`
- Event source: Solana `onLogs` + account subscriptions
- Governance events:
  - fee-sharing config created
  - fee-share updated
  - authority transferred
  - authority revoked (locked)
  - config reset
- Social events:
  - social fee PDA created
  - social fee claim inferred from lamport balance decrease

## How It Works

1. Startup
   - Loads persisted state from `DATA_FILE`
   - Optionally bootstraps existing sharing configs from chain (`BOOTSTRAP_EXISTING=true`)
   - Starts social PDA account watchers
   - Starts fee-program log listener
2. Runtime decoding and state updates
   - Decodes program logs via Anchor `EventParser`
   - Maintains local token/social-PDA index in JSON storage
   - Links mints to social PDAs and tracks observed claim counts
3. Claim detection
   - Watches social PDA lamport balance changes via `onAccountChange`
   - Marks a claim when current balance drops below previous balance
   - Enriches with recipient/signature if a matching claim log is available in slot proximity
4. Alerting
   - Applies runtime filters (event type, platform, mint allow/block list, minimum claim size)
   - Sends compact Telegram alerts with copyable token CA and action buttons
   - Broadcasts alerts to `TELEGRAM_CHAT_IDS` (comma-separated) or fallback `TELEGRAM_CHAT_ID`
5. Control path
   - `/settings` and `/filters` are accepted only in `TELEGRAM_CHAT_ID`
   - Control updates are persisted to local storage and survive restarts

## Setup

1. Install dependencies:

```bash
npm install
```

2. Create env file:

```bash
cp .env.example .env
```

3. Configure required values:

- `RPC_HTTP_URL`
- `RPC_WS_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_IDS` for alert destinations (`-100...,-100...`)
- `TELEGRAM_CHAT_ID` for control chat (`/settings`, `/filters`)

Optional:

- `GITHUB_TOKEN` for GitHub profile enrichment with higher rate limits
- `ALERT_EVENT_TYPES`, `ALERT_PLATFORMS`, `ALERT_MINT_ALLOWLIST`, `ALERT_MINT_BLOCKLIST`, `ALERT_MIN_CLAIM_SOL`

## Telegram Routing Model

- Alerts:
  - Sent to all chat IDs in `TELEGRAM_CHAT_IDS`
  - If `TELEGRAM_CHAT_IDS` is empty, falls back to single `TELEGRAM_CHAT_ID`
- Control:
  - Only `TELEGRAM_CHAT_ID` can use `/settings` and `/filters`
  - Intended for private DM or a private admin group
- Channel IDs:
  - Must usually be in `-100...` format

## Alert Filters

All filters are suppressive only. Monitoring and storage still continue.

- `ALERT_EVENT_TYPES`: `create,update,transfer,revoke,reset,claim`
- `ALERT_PLATFORMS`: `github,x,pump`
- `ALERT_MINT_ALLOWLIST`: comma-separated mint addresses
- `ALERT_MINT_BLOCKLIST`: comma-separated mint addresses
- `ALERT_MIN_CLAIM_SOL`: minimum claim size in SOL (example `0.5`)

Example:

```env
ALERT_EVENT_TYPES=claim,revoke
ALERT_PLATFORMS=github
ALERT_MIN_CLAIM_SOL=0.5
ALERT_MINT_ALLOWLIST=
ALERT_MINT_BLOCKLIST=
```

## Telegram Commands

```text
/start
/settings
/filters
/filters show
/filters reset
/filters events claim,revoke
/filters platforms github
/filters min_claim 0.5
/filters mint_allow add <mint>
/filters mint_block add <mint>
```

## Safety Audit (2026-03-17)

Scope:

- Runtime secret handling
- Telegram trust boundaries
- Failure behavior
- Dependency vulnerabilities

Findings:

- Dependency scan (`npm audit --omit=dev`): 0 vulnerabilities
- Reliability fix applied: Telegram alert broadcast now tolerates partial delivery failure
  - If one chat ID fails but at least one succeeds, bot continues running and logs a warning
  - If all destinations fail, alert send still returns an error
- Control chat boundary is enforced by exact `chat.id` match
- HTML content is escaped before Telegram send (reduces formatting/script-injection risk in messages)

Remaining operational risks to manage:

- `.env` contains high-value secrets (RPC key, Telegram bot token). Treat as sensitive and rotate on leak.
- JSON data store is plaintext local state; avoid running on shared hosts without OS-level access controls.
- Alert channels are public-facing outputs. Keep control commands in a private chat (`TELEGRAM_CHAT_ID`) only.

Recommended hardening:

1. Use separate chats for alerts and control (`TELEGRAM_CHAT_IDS` vs `TELEGRAM_CHAT_ID`).
2. Restrict bot admin rights in channels to only what is needed (`Post Messages`).
3. Rotate `TELEGRAM_BOT_TOKEN` and RPC keys regularly.
4. Keep `ALERT_MIN_CLAIM_SOL` non-zero in production to reduce noise/spam.
5. Run `npm audit --omit=dev` periodically.

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

- IDL source: [idl/pump_fee_sharing.json](/Users/abhijithvs/Pump fee claim bot/idl/pump_fee_sharing.json)
- Claim attribution can be ambiguous when one social PDA is linked to multiple mints. In those cases alerts show a token-candidate preview, not a guaranteed exact mint.
