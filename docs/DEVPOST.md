# Devpost submission: Oinkalytics

Copy each section into the matching Devpost field. Every number comes from `docs/DECISIONS.md`.

---

## Tagline

We taught AI to hear when farm animals are stressed, and to text the farmer before it costs the planet.

## Inspiration

Every animal that gets sick or dies before market has already used feed, water and land and produced emissions, with nothing to show for it. Stress shows up in an animal's voice before anyone sees it: published work shows pig calls carry emotional valence. A farmer can't listen to every pen at once, but a cheap microphone can. We wanted to build that listener, and to be honest about how well it really works.

## What it does

- **Listens to every call in the barn** and decides calm, distressed, or "I'm not sure". Each verdict comes with a calibrated confidence and an explanation built only from what was measured.
- **Texts the farmer over iMessage** (through Photon) when a pen starts to sound wrong, using the pen's own name, for example "North barn sounds stressed". The farmer can reply "why" for the evidence, "play it" to hear the actual call, "status", or "mute".
- **Stays quiet unless it matters.** Warnings that arrive together are bundled into one message, each pen texts at most once every 30 minutes, and there's a hard cap of 4 messages per 15 minutes.
- **Sends a rare emergency alert:** a 🚨 text plus a spoken voice note. It needs sustained, severe distress: one pen critical for over 2 minutes, 2+ pens critical together for 45 seconds, or every pen in the barn in distress at once. It sends at most one reminder, and replying "OK" stops it.
- **A live barn you can build:** add, rename and remove pens; walk pigs and hens in and out; set each pen to Calm, Stressed, Mixed or your own recordings. Each animal has its own real held-out recording that matches its mood.
- **Disasters for the demo:** set loose a wolf that hunts the animals, a spreading fire, a storm with lightning, or a comet strike in any pen. The animals panic and run. The model still judges every call itself.
- **"Hear it think":** three held-out sounds play out loud while the AI explains its verdict, including a clap it correctly says isn't a pig.

## How we built it

- **Audio model:** Google's **Perch 2.0** bioacoustics model turns each call into an embedding, averaged over only the part of the clip that contains the call. A logistic-regression classifier sits on top, with temperature scaling, a calm/unsure/distressed band, and a "not a pig" check trained against ESC-50 everyday sounds.
- **Robustness:** we mixed held-out calls with real farm noise, found the model got overconfident, and **retrained it with half the noise recordings, testing on the other half**.
- **Explanations:** measured features (duration, pitch, loudness…) and the most similar calls are sent as JSON to an LLM (via OpenRouter). Any number in its answer that isn't in the evidence triggers a template fallback.
- **Backend:** one **FastAPI** server holds all the ML. The web hub and the bot only make HTTP calls to it.
- **Messaging:** a **TypeScript** bot on **Photon's Spectrum SDK**, live on iMessage. Emergency voice notes are generated with macOS text-to-speech. 23 unit tests cover it.
- **Front end:** a hand-built HTML/CSS/JS hub with animated SVG animals, pens, disasters and a bat colony. No frameworks, so it runs offline.

## Challenges we ran into

- **The usual way of testing lies.** Tested on a random split, our model scores **90%**. On recordings it has never heard, it scores **67.5%**. Most demos report the first number; we report the second.
- **Three species, three shortcuts.**
  - **Pigs:** lab differences inflate the random-split score.
  - **Chickens:** 99.6% looked amazing, but simple loudness features alone reach 93.9%, so it's mostly recording differences, not proven health detection.
  - **Fruit bats:** fights vs feeding looked like 77%, but **the time of day alone predicts it better than the model**, because fights happen by day and feeding at night.
- **Farm noise made the first model overconfident.** It kept answering instead of saying "not sure", and false alarms doubled.
- **Alert fatigue.** Our first emergency alerts spammed the phone. We redesigned them around what a farmer would actually want.

## Accomplishments that we're proud of

- **Honest headline numbers** on the pig model, tested on recordings it never heard:

  | Test | Balanced accuracy |
  |---|---|
  | Random split (the usual way) | **90%** |
  | Recordings it never heard | **67.5%** |
  | Labs it never heard | **61%** |
  | With "not sure" allowed | **75%** on the 64% of calls it answers |

- **Calibrated confidence:** when it says 80% sure, it's right about 80% of the time (calibration error 0.023).
- **Same pig, two moods:** on a second dataset with pig IDs, it scored **86% on pigs it never heard**, the same as a random split. Within one setting it hears mood, not individual pigs.
- **Noise-trained model:** in noise louder than the call, **false alarms on calm pigs fell from 31% to 14%** and accuracy on answered calls rose from 57% to 66%, tested on noise it never trained on. Clean accuracy is unchanged.
- **A working product:** live iMessage alerts, voice-note emergencies, and a barn you can build and break.

## What we learned

- **How you test matters more than which model you use.**
- **Ask whether a confounder could explain the result:** lab, recording, or time of day. In our case, each time one did.
- **The pipeline transfers to new species; the classifier doesn't.** On wild boar the pig model scores below chance, and adding 2,600 calls from five other species didn't improve the pig model (AUC 0.757 → 0.753).
- **Perch hears who is calling better than what is happening.** It identifies individual fruit bats 73% of the time on days it never heard (chance 10%), but can't reliably tell a fight from feeding.

## What's next for Oinkalytics

- **A real-barn test** with cheap microphones on a partner farm.
- **Farmers labelling the calls the model is unsure about,** through the bot.
- **New species, each with its own labelled calls.**
- **Real phone calls** for emergencies, via Photon's voice platform.

## Built with

python, fastapi, tensorflow, perch, scikit-learn, librosa, ffmpeg, openrouter, claude, typescript, node.js, photon, spectrum, imessage, html, css, javascript, svg, gradio

## Data and credits

- **SoundWel** pig vocalization database (Briefer et al. 2022, *Scientific Reports*), Zenodo 8252482, CC BY 4.0.
- **Ungulate valence calls** (Lefèvre, Sypherd & Briefer 2025), Zenodo 14636641, CC BY 4.0.
- **Poultry vocalization dataset and farm noise** (Bowen University), Mendeley doi:10.17632/zp4nf2dxbh.1, CC BY 4.0.
- **Egyptian fruit bat vocalizations** (Prat, Taub, Pratt & Yovel 2017, *Scientific Data*), Figshare, CC0.
- **ESC-50** (Piczak 2015), CC BY-NC 3.0.
- **Perch 2.0** (Google).
