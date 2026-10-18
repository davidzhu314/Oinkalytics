# Demo video script (3:00)

Feature by feature. All numbers come from `docs/DECISIONS.md`. The page is the pen builder at http://localhost:8010, with one browser tab open.

**Wording rule:** the listening is done by an **AI audio model** (Google's Perch 2.0 plus a classifier we trained). A language model only writes the plain-English explanation from the measured numbers. Don't say "we trained an LLM".

## Before recording

- **Pens:** set up **North barn** (3 pigs, **Calm**), **South barn** (3 pigs, **Mixed**) and **Hen house** (3 hens, **Mixed**). Press **Reset**, set the speed to **0.5 s**, and keep the bot running.
- **Phone:** record the iPhone screen separately, or film it in hand. Texts take 30–90 s to arrive, so **cut the waits in editing**.
- **Audio:** turn the volume up. You want the pig calls, the clap and the emergency voice note audible.

---

## 0:00–0:15 · Hook

**On screen:** the barn with animals moving.

> "Every sick animal on a farm has already used feed, water and land. Stress shows up in an animal's voice before anyone sees it. Oinkalytics listens to every pen, so the farmer doesn't have to."

## 0:15–1:10 · Feature 1: pigs

**On screen:** scroll to **Hear it think** and press **Play all three**.

> "Our AI audio model hears three things: a calm pig, a distressed pig, and something that isn't a pig at all. Here's a clap. It says 'I'm not sure this is a pig call.' Knowing what it doesn't know is the point. The explanation you see is written by a language model, using only numbers we measured from the audio."

**On screen:** back to the barn. **Start the barn**. North barn (Calm) stays green.

> "Here's how it works on a farm. A calm pen: the farmer gets nothing. No noise, no notifications."

**On screen:** set **South barn** to **Stressed**. Cut to the phone: **one** warning text. Text **"why"**, then **"play it"**.

> "When a pen starts sounding distressed, the farmer gets one text, not twenty. They can ask why, or hear the actual call."

*Optional, about 10 s:* **⚠️ → Wolf attack** in South barn, then cut to the **🚨 emergency voice note** on the phone.

> "And if something is seriously wrong, like a predator, it sends an emergency voice note."

**Implication to say:**

> "That means catching stress before illness spreads: fewer animals lost, and less wasted feed, water and emissions."

## 1:10–1:40 · Feature 2: chickens

**On screen:** **Hen house**. Click a hen with a **!** to hear its call. Set the pen to **Stressed**, then cut to the phone: a 🐔 "sounds sick" text.

> "The same pipeline works for chickens. We trained a second audio model on healthy and sick hens, and the same barn and the same texts now cover poultry."

**Honesty line (keep it, judges will respect it):**

> "On chickens it scored 99.6%, but simple loudness measurements alone get 94%. So it may be hearing how the recordings were made rather than the illness. We flag that instead of claiming a disease detector."

**Implication:**

> "One pipeline, any farm animal, but each species needs its own labelled data."

## 1:40–2:25 · How we tested it

**On screen:** scroll to **How we tested**: the gap chart, then the farm-noise chart.

> "Most demos test on a random shuffle of recordings, so the model has already heard that room and that microphone. Tested that way, ours scores 90%. On recordings it has never heard, it scores 67.5%. We report the honest number."

> "When it's allowed to say 'not sure', it gets 75% of the calls it answers right, and its confidence is calibrated: when it says 80% sure, it's right about 80% of the time."

> "We mixed in real farm noise and caught it getting overconfident. So we retrained it on half the noise and tested it on the other half: false alarms on calm pigs dropped from 31% to 14%."

> "And on a second dataset, it scored 86% on individual pigs it had never heard, so it's hearing mood, not recognising pigs."

## 2:25–3:00 · Beyond the farm: bats, and what's next

**On screen:** the **Bat colony** tab. Press **Play a mystery call**, show the model's guess, then **Reveal**.

> "This isn't just for farms. We took the same pipeline to a colony of ten Egyptian fruit bats. On days it had never heard, it names the right bat 73% of the time, and has it in its top three 91% of the time. Guessing would be 10%."

> "We also tried to detect bat fights, and caught a shortcut: the time of day predicted it better than the model, because fights happen by day. So we don't claim it."

> "Next: a real-barn test with cheap microphones, real phone calls for emergencies, and new species, each with its own data. Oinkalytics: we taught AI to hear when animals are stressed, before it costs the planet."

---

**Timing check:** 15 + 55 + 30 + 45 + 35 = **3:00**. If you run long, cut the optional wolf moment first, then the 86% line.
