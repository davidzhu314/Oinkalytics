# Oinkalytics Photon bot

Texts the farmer when a pen sounds distressed and answers `status`, `why`, `play it`, `mute` and `unmute`. It only talks to the Oinkalytics API over HTTP (see [docs/API.md](../docs/API.md)), so the mock and the real server both work.

Built on [Spectrum](https://photon.codes/docs/spectrum-ts/introduction) (`spectrum-ts`, pinned to 12.10.1). Needs Node 24 or later; Node runs the TypeScript directly, so there's no build step.

```bash
cd bot && npm install
npm run dev          # terminal chat UI, no credentials needed
npm test             # unit tests (fake API)
npm run typecheck
```

Start the API first (`uvicorn api.mock_server:app --port 8000` from the repo root). Settings come from the repo-root `.env`; see `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `BOT_CHANNEL` | `terminal` | `terminal` (local TUI) or `imessage` (Spectrum Cloud) |
| `OINK_API` | `http://localhost:8000` | Pig API base URL |
| `CHICKEN_API` | off | Chicken API base URL. When set, "status" lists both species, alerts are prefixed "Pigs," / "Chickens,", and "why chicken" / "play pig" pick a species (plain "why" uses the newest alert) |
| `FARMER_PHONE` | none | E.164 number that receives alerts. Use the dev phone while developing |
| `ALLOWED_SENDERS` | anyone | Comma-separated senders the bot answers |
| `BOT_MUTE` | off | `1` logs proactive alerts instead of sending them. Commands still work, and the farmer can text `mute`/`unmute` |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | none | Needed for `imessage` |

How it behaves:
- **Alerts** poll `GET /alerts` every 2 s. On startup the cursor jumps to the newest alert, so a restart never re-sends old ones. If a send fails, it's retried on the next poll.
- **A shared iMessage line can't start a conversation.** The farmer has to text the bot once (for example "status") before alerts can reach them. The bot saves that conversation to `bot/.farmer-space.json` (gitignored), so after a restart alerts still reach the farmer without them texting again.
- **Natural phrasing works.** Commands are found anywhere in the message: "how's the coop doing?" or "any problems?" give the status, "what's wrong in pen 3?" explains, "can I hear it?" plays the call, "stop the alerts" mutes. Add "pen 3" to "why" or "play" for one pen.
- **Terminal mode never contacts Photon.** Spectrum would otherwise pick up `SPECTRUM_PROJECT_ID`/`SECRET` from `.env` even for the terminal provider.
- On a shared line, only the registered sender's messages reach the bot, so the demo phone does the texting.
