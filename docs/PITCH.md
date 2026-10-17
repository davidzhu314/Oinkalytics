# Pitch: demo script and slide outline

For the team. Every number here is in [docs/slides/numbers.csv](slides/numbers.csv) or [DECISIONS.md](DECISIONS.md). Don't round them up or add new ones.

## Before judges arrive (checklist)

- [ ] Laptop plugged in, lid open, phone hotspot ready.
- [ ] API running (`uvicorn api.server:app --port 8000`), `GET /health` says `"mode":"real"`.
- [ ] Dashboard open on the ASUS monitor (http://localhost:7860), **Barn** tab, browser zoomed so pens read from across the table.
- [ ] Bot running (`cd bot && npm run dev`), log shows `channel=imessage`.
- [ ] **Demo phone has texted the bot "status" since the bot last started**, otherwise the alert can't reach it.
- [ ] Press **Reset barn**. Set **Seconds between calls** to **0.5**. Ramp **off**.
- [ ] Phone volume up, not on silent, so "play it" is audible.
- [ ] The backup video is on the laptop desktop.

## Demo script (~2 minutes)

| # | Who does what | Say (roughly) |
|---|---|---|
| 1 | Press **Start**. All pens green. | "This is a barn with four pens. Every few seconds a microphone hears a pig call. These are real recordings, held out: the model has never heard them." |
| 2 | Tick **Ramp up distress in Pen 3**. Wait for it to go amber, then red (~30–60 s). | "Now Pen 3 starts sounding stressed. It doesn't alert on one call. It waits until 3 of the last 5 calls it's confident about sound distressed, so one squeal doesn't wake the farmer." |
| 3 | Phone buzzes. Hold it up. | "And the farmer gets a text, where they already are: their messages." |
| 4 | Text **why**. Read the reply aloud. | "Every number in that answer was measured from the audio. The AI can't add anything that isn't in the evidence; if it tries, we fall back to a template." |
| 5 | Text **play it**. Let the call play. | "That's the actual call that triggered it." |
| 6 | Switch to **Check a call**, pick the **clap** example, press **Check this call**. | "And when it hears something that isn't a pig, it says so: 'I'm not sure this is a pig call.' Knowing what it doesn't know is the point." |
| 7 | Cut to the gap slide. | "And here's the part most demos hide…" (slide 4) |

**If Pen 3 is slow to turn red,** keep talking about step 2. The honest model says "not sure" on many distressed calls, which is a feature, not a bug. **Don't** switch to hand-picked clips. **If Wi-Fi drops,** play the backup video from step 1.

## Slides (7–8, about 3 minutes with the demo)

1. **Title.** "Oinkalytics: we taught AI to hear when animals are stressed, before it costs the planet." Team names.
2. **The problem.** Every animal lost before market has already used feed, water and land, and produced emissions. Stress shows in the voice before anyone sees it. A farmer can't listen to every pen; a cheap microphone can. *(Source any livestock-emissions figure before putting it on the slide. The plan's 14.5% FAO number is unverified.)*
3. **How it works.** Pig call → Perch 2.0 (Google's bioacoustics model) → calibrated classifier → calm / distressed / not sure → dashboard + iMessage alert → "why?" answered from measured evidence only.
4. **The gap** (`docs/slides/1_gap.png`). "Same model, same calls. Tested the usual way: 90%. On recordings it never heard: 67%. On labs it never heard: 61%. We report the honest number."
5. **Knowing when it doesn't know** (`docs/slides/3_confidence.png`, optionally `2_calibration.png`). "When it's allowed to say 'not sure', it answers 64% of calls and gets 75% of those right. And when it says 80% confident, it's right about 80% of the time."
6. **Farm noise** (`docs/slides/6_noise.png`). "We stress-tested it with farm noise and caught it getting overconfident. We retrained it with noise, tested on noise it had never heard, and halved the false alarms when the barn gets loud."
7. **Same pig, two moods.** "On a second dataset with pig IDs: 86% on pigs it never heard, the same as a random split. It's hearing mood, not individual pigs. What's hard is different barns, so our next step is a real-barn test."
8. **What we don't claim, and what's next.** Tested with added farm noise, not yet in a real barn. Emissions impact not measured. Doesn't transfer to other species: on wild boar it scored below chance. Next: real-barn microphones, farmers labelling the calls it's unsure about, new species with their own labelled data. Credits: SoundWel (Briefer et al. 2022), Perch 2.0, ESC-50, Photon.

## Judge Q&A

- **"How do you know it's really distress?"** The labels come from the recording situation (isolation, restraint, reunion…) in a published welfare dataset. We predict whether a call came from a positive or negative situation, not what the pig thinks.
- **"Why is your accuracy lower than the paper's 91.5%?"** It isn't, when tested the same way: we get 90% on a random split too. 67% is what you get on recordings the model never heard, which is what a new barn looks like.
- **"Does it reduce emissions?"** Earlier intervention means fewer losses, and every loss carries wasted feed, water and emissions. We haven't measured the size of that effect.
- **"Does it work on other animals?"** Not this classifier: on wild boar it was worse than chance, and adding 2,600 calls from five other species didn't improve the pig model. We also tried two new species with their own labels. Chickens scored 99.6%, but simple loudness features nearly match it, so it's recording differences, not health. Bats: spotting fights in bats it never heard was 55%, and the clock alone beat the model, because fights happen by day and feeding at night. Three species, three shortcuts caught. What transfers is the method, not the classifier.
- **"Isn't this helping factory farms?"** Detecting suffering earlier helps animals in any setting, including small farms and sanctuaries.
- **"Will it work with a cheap mic in a real barn?"** We mixed in real farm noise. Light noise barely matters; in heavy noise our retrained model says "not sure" more and keeps false alarms down (31% → 14%). A real barn adds echo and distance, so that's the next test.
- **"How does the LLM not hallucinate?"** It only gets a JSON of measured numbers and similar calls. We scan its answer for any number not in that JSON and fall back to a template if one appears.
