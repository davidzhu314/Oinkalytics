# Oinkalytics Photon bot

The farmer-facing half of Oinkalytics: a [Photon Spectrum](https://photon.codes/docs/spectrum-ts/introduction) agent that texts pen alerts, explains them, and plays back the call that caused them.

It contains no ML. Everything comes from the Oinkalytics API ([docs/API.md](../docs/API.md)), so this bot works against the mock server today and against the real model with no changes.

## What it does

| Behaviour | Say this | Priority in the plan |
|---|---|---|
| Proactive alert | — (arrives on its own) | Must have |
| Explain the last alert | `why?`, `explain`, `why pen 3` | Must have |
| Summarise every pen | `status`, `pens`, `all good?` | Must have |
| Play the triggering call | `play it`, `let me hear it` | Should have |
| Judge a recording you send | send an audio attachment | Should have |
| Silence alerts | `mute` / `unmute` | dev safety |

## Run it

Start the API first, from the repo root:

```bash
ALERT_COOLDOWN_S=30 uvicorn api.mock_server:app --port 8000
```

Then, in `bot/`:

```bash
npm install
npm run dev          # local prompt, no Photon credentials needed
```

Type `status`, `why`, `play it`. `/send path/to/clip.wav` exercises send-a-clip. To watch an alert arrive on its own, in another terminal:

```bash
npm run fire-alert           # 3 distressed calls at pen 3
npm run fire-alert 2 4       # 4 calls at pen 2
```

### On a real phone

```bash
SPECTRUM_PROJECT_ID=… SPECTRUM_PROJECT_SECRET=… ALERT_TO=+15551234567 npm start
```

Credentials come from the Photon dashboard under Settings. `ALERT_TO` is the demo phone: it gets alerts even before anyone texts the bot, which matters because the judge's phone has to buzz on cue. Anyone who texts the bot is added automatically and remembered in `.subscribers.json`, so a restart mid-demo keeps the same audience.

See [.env.example](.env.example) for every setting.

## Testing

```bash
npm test         # 29 tests; the integration ones skip if no API is reachable
npm run typecheck
```

`test/agent.test.ts` runs the real agent — handlers, alert poller and all — over a fake Spectrum app, and walks the demo script: alert fires, `why?` explains it, `play it` returns RIFF bytes. Start the API with `ALERT_COOLDOWN_S=5` first, or the second alert in a run is swallowed by the cooldown.

## Layout

```
src/types.ts       mirrors api/schemas.py; the frozen contract
src/api.ts         typed client for the Oinkalytics API
src/intents.ts     text -> intent (pure)
src/replies.ts     API shapes -> what we text back (pure)
src/alerts.ts      polls /alerts, skips the pre-startup backlog
src/subscribers.ts who gets proactive alerts, persisted
src/agent.ts       the agent: message loop + alert fan-out, channel-agnostic
src/index.ts       entrypoint: iMessage via Photon Spectrum Cloud
src/dev.ts         entrypoint: stdin, no credentials
src/stdin-app.ts   Spectrum-shaped app over stdin, for dev and tests
```

`agent.ts` never names a channel, so iMessage, the dev prompt and the tests all exercise identical code.

## Two things worth knowing

**No tunnel needed.** Spectrum Cloud streams inbound messages over `app.messages`, so there is nothing to expose. `cloudflared` is only required if you switch to `app.webhook()`. That removes the "tunnel drops" risk from the plan for this component.

**Honesty rules are enforced in `replies.ts`.** Alert text and pen summaries are sent exactly as the API wrote them, and `context_top3` is always labelled "likely situation (random-split accuracy)" because contexts are tied to recording sessions. An `unsure` verdict is passed through as the API's own words, with no verdict and no context claim. `test/replies.test.ts` locks all of that down.
