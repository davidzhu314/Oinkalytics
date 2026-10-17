# Oinkalytics: HackHarvard 2026 Project Plan

Oct 16, 2026 · David Zhu · Backup name: HerdSense

## The idea

Oinkalytics is an AI that listens to pigs, flags when they are stressed, and texts the farmer the alert and the reason. We're building it in 30 hours for the HackHarvard 2026 ASUS "Save the Earth" sustainability track, using Photon as the messaging layer.

**One-liner:** We taught AI to hear when animals are stressed, before it costs the planet.

**30-second pitch:** Every sick farm animal is wasted food, water, land and emissions. The warning signs show up before anyone sees them, because stressed pigs sound different, and science has proven it. We built an AI that listens. It tells you whether a pig is calm or distressed, how confident it is, and why, pointing to the actual sound features it heard. Then it texts the farmer, who can reply "why?" or send a recording of their own. No translator gimmicks. No guessing. Just a microphone that notices what farmers can't. Today, pigs. Tomorrow, any animal, anywhere.

## Problem and track fit

Earlier stress detection means fewer animals lost. Every animal lost is resources and emissions spent for nothing.

- Livestock uses large amounts of feed, water and land. The FAO figure is roughly 14.5% of human-caused greenhouse gas emissions; **cite the source before this goes on a slide**.
- An animal that dies or grows poorly has already consumed feed and water and produced emissions, with no food to show for it.
- Stress comes before visible illness. Nobody can watch every pen, but a cheap microphone can listen to all of them.
- The method generalises to passive acoustic monitoring of wildlife: not just "which species?" but "what state are they in?"

Slide line: **Less suffering, less waste, smaller footprint.**

## The science

- **Pigs:** Briefer et al. (2022, *Scientific Reports*) recorded 7,414 calls from 411 pigs and got 91.5% accuracy on positive vs negative valence and 81.5% on recording context. Positive calls tend to be shorter, with less amplitude modulation.
- **Encoders transfer across species:** Perch 2.0 (Google) and AVES (Earth Species Project).
- **Nobody has built a translator.** CETI, ESP and DolphinGemma recognise or generate calls but haven't validated meaning.

We predict the **recording context** and **valence** of a call, not what the pig "means".

## Components

1. **Data loader:** SoundWel calls plus labels, converted to mono WAV at one sample rate.
2. **Embedder:** a pretrained audio model turns each call into a vector. It runs once and the vectors are cached.
3. **Classifier:** predicts valence (calm vs distressed) and context (top 3), with calibrated confidence and an "I'm not sure" threshold.
4. **Evidence and explanation:** measured features (duration, pitch, loudness, spectral centroid) plus the 3 most similar calls from *other* pigs go to the LLM as JSON. The LLM explains them in plain English and adds nothing else.
5. **Front ends:** a Gradio barn dashboard on the ASUS monitor and a Photon messaging agent on the farmer's phone.

What users see: a calm call shows green. A distressed call shows red, with the reason and similar calls to play. A non-pig sound returns "I'm not sure this is a pig call."

## Photon messaging agent

| Behaviour | Example | Priority |
|---|---|---|
| Proactive alert | "Pen 3: distress calls rising, 4 of the last 5 flagged (82% confidence)." At most one per pen every few minutes | Must have |
| "why?" | Evidence-based explanation for the latest alert | Must have |
| "status" | One-line summary of every pen | Must have |
| "play it" | Sends the audio clip that triggered the alert | Should have |
| Send a clip | Farmer records a sound; agent replies with verdict, confidence and reason, or "not sure this is a pig call" | Should have |
| Voice call for critical alerts | Targets Photon's best-voice-agent prize | Stretch |

Prize rule: the bot must be built on **Photon 2.0** and **live on at least one Photon channel during judging**.

## Architecture

All the ML lives in one Python FastAPI service. The dashboard and the bot are thin clients that call it over HTTP. **The API's inputs and outputs freeze at hour 12.**

| Piece | Primary | Fallback |
|---|---|---|
| Audio conversion | ffmpeg + librosa | — |
| Embeddings | Perch 2.0 (TF, 32 kHz, 5 s windows) | AST or CLAP via HF transformers |
| Classifier | sklearn LogisticRegression | Small MLP |
| Calibration | Temperature scaling | CalibratedClassifierCV |
| Similar calls | NearestNeighbors (cosine), excluding the same pig | — |
| Explanation | LLM via **OpenRouter**, given only JSON evidence | Template text |
| API | FastAPI | — |
| Dashboard | Gradio | Streamlit |
| Messaging | Photon Spectrum SDK (Node 18.17+ / Bun), webhooks via cloudflared or ngrok | Photon advanced iMessage SDK |

## Dataset: SoundWel

| Field | Value |
|---|---|
| Source | Zenodo record 8252482 |
| Size | ~6,888 calls, ~328 MB |
| Labels | 17 recording contexts + positive/negative valence |
| Licence | CC BY 4.0 (credit the authors on the slide and README) |
| Published baseline | 91.5% valence, 81.5% context |

Fallback dataset: Elie & Theunissen zebra finch calls (3,433 calls, 50 birds, 11 types).

## Evaluation and honesty rules

- **Leave-pig-out splits:** GroupKFold by pig ID, or by recording session if there is no ID column.
- **Gap slide:** compare against a naive random split. Drop the slide if the gap is small.
- **Metrics:** macro-F1 and accuracy for valence, top-3 accuracy for context, with chance level shown beside each.
- **Calibration:** temperature scaling, ECE and a reliability plot.
- **Abstention:** answer "I'm not sure" when confidence is low or the call is far from every training example.
- **Explanation check:** scan LLM output for numbers or claims that aren't in the evidence JSON. Fall back to template text if anything strays.
- **Don't promise 91.5%.** The result is whatever we get under honest splits.

## Team roles

| Role | Owns | Hands off |
|---|---|---|
| ML lead | Embeddings, classifier, splits, calibration, gap result, FastAPI wrapper | Stable API by hour 12 |
| Evidence and explanation | Features, nearest neighbours, abstention, LLM prompt, template fallback | Explanation function |
| Frontend | Gradio dashboard, ASUS styling, barn simulator | Demo screen |
| Photon and story | Photon bot, tunnel, slides, demo script, ASUS video | Live phone demo and pitch |

With three people, the frontend owner also builds the bot. Names TBD.

## 30-hour timeline

| Hours | ML lead | Evidence | Frontend | Photon and story |
|---|---|---|---|---|
| 0–3 | Load data, label table, start embedding run | Feature extraction | Gradio skeleton, fake outputs | Workshop credentials, bot says hello |
| 3–8 | Classifier, honest vs naive splits | Nearest neighbours | Upload, spectrogram, fake prediction | Bot receives and replies, tunnel working |
| 8–14 | Calibration, abstention, FastAPI (**frozen at hour 12**) | LLM prompt, template fallback | Wire in the real model | "why?" and "status" |
| 14–22 | Context top 3, confusion matrix | OOD check, claim scan | Similar-call playback, abstain state | "play it", send-a-clip |
| 22–26 | Slide charts | Pick and test demo clips | Styling, simulator | Live alerts, slides, ASUS video |
| 26–30 | Buffer | Buffer | Freeze | Rehearse 3×, backup video, README |

## Scope tiers

| Tier | Deadline | Contents |
|---|---|---|
| 0: result | Hour 8 | Notebook with leave-pig-out accuracy and naive-split comparison |
| 1: working app | Hour 14 | Dashboard predicts and explains; bot replies to a text |
| 2: demo-ready | Hour 22 | Calibration, abstention, similar-call playback, live alerts, "why?" and "status" |
| 3: stretch | Only if ahead | Send-a-clip, context top 3 in the bot, voice calls, second species, wildlife screen |

**Never in scope:** fine-tuning, live microphone demo, dogs, real-time barn deployment.
**Hard rules:** if Tier 1 isn't working at hour 14, cut all of Tier 3. Perch setup gets 2 hours, then we switch to the fallback encoder. Code freeze at hour 26. Anyone awake past hour 20 fixes bugs instead of adding features.

## Demo script (~2 min)

1. ASUS monitor: barn dashboard with all pens green while the simulator streams held-out calls.
2. Distress builds in Pen 3 and the pen turns red.
3. A phone buzzes with the Photon alert.
4. The judge texts "why?" and gets the evidence-based explanation.
5. The judge texts "play it" and hears the actual call.
6. A non-pig clip (clap or cough) returns "I'm not sure this is a pig call."
7. Slide: naive vs leave-pig-out accuracy, plus the calibration plot.

Use only held-out clips chosen in advance, and keep a pre-recorded backup video.

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Embedding setup eats hours | Medium | 2-hour Perch limit, then AST or CLAP |
| No pig IDs in metadata | Medium | Group by session, farm or date, and say so on the slide |
| Accuracy below 91.5% | Likely | Expected under honest splits; pitch the honesty |
| Small context classes | Likely | Balanced weights, macro-F1, top-3 |
| LLM invents claims | Medium | JSON-only evidence, output scan, template fallback |
| Audio format bugs (iPhone memos) | High | ffmpeg everything to mono WAV |
| iMessage needs an Apple device | Medium | Test phones early; ask Photon about SMS |
| Tunnel or Wi-Fi drops | Medium | Restart script, hotspot, cached explanations |
| Alert spam during development | High | Dev phone number, mute flag |
| UI polish eats the night | High | Code freeze at hour 26 |

## Judge Q&A

**We can say:** it predicts whether a pig call came from a positive or negative situation, tested on pigs it never heard, with calibrated confidence and evidence-based explanations, delivered to the farmer's phone.
**We cannot say:** that it works in a real noisy barn, that it cuts emissions by a specific amount, or that it understands what pigs mean.

- *How do you know it's distress?* The labels come from the recording situation in a published welfare dataset.
- *Does it reduce environmental impact?* Earlier intervention means fewer losses. We haven't measured the size of that effect.
- *Other animals?* This classifier, no. The pipeline transfers, but a new species needs labelled calls.
- *Isn't this helping factory farms?* Detecting suffering earlier helps animals in any setting.
- *A cheap mic in a real barn?* That's the next test.

## Prizes

| Prize | Requirement | Angle |
|---|---|---|
| ASUS "Save the Earth" | Real-world environmental solution | Less livestock waste; dashboard on the ASUS monitor |
| Photon: messaging agent | Photon 2.0, live on a channel | Alerts, "why?", "play it", send-a-clip |
| Photon: best voice agent | Voice agent on a Photon number | Stretch |
| ASUS Content Challenge | Public post with tags, hashtags and proof form | 60-second build video |

Content tags: @asususa and @hhuh.hackathon (Instagram), @ASUS Education (LinkedIn), @asuseducation (TikTok), @ASUSUSA (YouTube). Hashtags: #ASUSEducation #hackharvard2026 #agentcomputer. Film the first pig call, the gap reveal and the phone buzzing.

## After the hackathon

Real-barn test → more species (zebra finch, fruit bat) → cross-species valence probe → active learning through the bot → wildlife monitoring → open dog dataset.

## References

- Briefer et al. 2022, *Scientific Reports*: pig call valence and context
- SoundWel database, Zenodo 8252482
- Elie et al. 2025, *Science*: zebra finch call meaning
- Perch 2.0 (arXiv), AVES (GitHub), NatureLM-audio (GitHub)
- Yovel & Rechavi 2023, *Current Biology*
- 2026 Coller Dolittle Prize
- Photon iMessage SDK and Chat SDK docs
