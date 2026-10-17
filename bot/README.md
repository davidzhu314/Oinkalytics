# Oinkalytics Photon bot

Texts the farmer when a pen sounds distressed and answers `status`, `why`, `play it`, `trends`, `mute` and `unmute`. It also texts trend updates (see the Trends section of [docs/API.md](../docs/API.md)). It only talks to the Oinkalytics API over HTTP (see [docs/API.md](../docs/API.md)), so the mock and the real server both work.

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
| `OINK_API` | `http://localhost:8000` | API base URL |
| `FARMER_PHONE` | none | E.164 number that receives alerts. Use the dev phone while developing |
| `ALLOWED_SENDERS` | anyone | Comma-separated senders the bot answers |
| `BOT_MUTE` | off | `1` logs proactive alerts instead of sending them. Commands still work, and the farmer can text `mute`/`unmute` |
| `SPECTRUM_PROJECT_ID`, `SPECTRUM_PROJECT_SECRET` | none | Needed for `imessage` |

How it behaves:
- **Alerts** poll `GET /alerts` every 2 s. On startup the cursor jumps to the newest alert, so a restart never re-sends old ones. If a send fails, it's retried on the next poll.
- **A shared iMessage line can't start a conversation.** The farmer has to text the bot once (for example "status") before alerts can reach them. The bot remembers that conversation.
- On a shared line, only the registered sender's messages reach the bot, so the demo phone does the texting.
- **Trends.** Each alert gets one more line comparing the pen with its normal, e.g. "That's about 3.7× this pen's normal (41% of calls distressed vs 11%)." The bot also polls `GET /trends/events` and texts "Pen 3 back to normal, 12 mins after the alert", "still sounds distressed", and "Pen 5 has had the most distress in the barn 3 days in a row… Pen 6 next door is rising too." `trends` replies with the distress ranking by pen. If the API has no trend endpoints, alerts go out without the comparison line.
