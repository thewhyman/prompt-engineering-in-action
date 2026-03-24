# Prompt Engineering in Action

**Your AI coaches your prompts. You coach its answers. Both get smarter.**

Free. Open-source. Works with Claude, ChatGPT, Gemini — any AI.

![Co-Dialectic — prompt quality from 45% to 91% in 10 days](co-dialectic/social-preview-github.png)

---

## Co-Dialectic

The first technique in this library. One file. Paste it into your AI. Five systems activate automatically:

1. **The right expert shows up** — your AI auto-detects the domain and responds as the appropriate specialist
2. **Every prompt gets coached** — vague questions get sharpened before the AI answers
3. **Context never silently degrades** — the AI tracks its own memory and hands off when quality drops
4. **Every correction becomes permanent** — fix something once, benefit forever
5. **The AI teaches you back** — names techniques you're using and connects them to broader concepts

### Install in 30 seconds

**Step 1:** Copy [co-dialectic/SKILL.md](co-dialectic/SKILL.md) (click "Raw", then select all, copy).
**Step 2:** Paste into your AI's custom instructions.
**Step 3:** Start a conversation. The status line appears immediately.

| Platform | Where to paste | Help |
|----------|---------------|------|
| **claude.ai** (web) | Projects → Create Project → Custom Instructions | [Docs](https://support.anthropic.com) |
| **Claude Desktop — Chat tab** | Same as claude.ai — Projects → Custom Instructions | Same experience as the web app |
| **Claude Desktop — Code tab** | `cp -r co-dialectic ~/.claude/skills/co-dialectic` then type `cod` | [Skills docs](https://docs.claude.com/en/docs/claude-code/skills) |
| **Claude Code** (terminal) | Same as Code tab above | Same experience as Desktop Code tab |
| **ChatGPT** | Profile → Settings → Personalization → Custom Instructions | [Docs](https://help.openai.com/en/articles/8096356-custom-instructions-for-chatgpt). ⚠️ 1,500 char limit — use the [condensed version](co-dialectic/install-instructions.md#condensed-version-for-chatgpt-paste-this) |
| **Gemini** | Profile → Personal Intelligence Instructions | [Docs](https://ai.google.dev/gemini-api/docs/system-instructions) |
| **Any other AI** | Paste as your first message: "Use these instructions for our entire conversation:" | Works everywhere |

**UIs change fast.** If the path doesn't match, ask your AI: *"Where do I paste custom instructions?"* — it knows its own settings. Full guide: [install-instructions.md](co-dialectic/install-instructions.md)

### Make it yours

Tell your AI how you like to communicate:

> *"Be direct but fun. Use analogies from unexpected places. Challenge me when I'm wrong."*

> *"Explain things gently. Use analogies. Celebrate small wins."*

> *"Short answers. No analogies. Show me code, data, or trade-offs."*

> *"Don't give me answers. Ask me questions that lead me there."*

One sentence. The AI captures it and adapts going forward.

### Results

Day 1: `Prompt Quality: 45% clear` → Day 10: `Prompt Quality: 91% clear`

1% daily improvement compounds to 37x in a year. You feel it in the first week.

**[Full details →](co-dialectic/README.md)**

---

## Philosophy

Yuval Noah Harari showed that language is what made humans unstoppable — shared stories enabled strangers to cooperate at scale.

In the age of AI, the next language bridge is forming. Not just humans learning to "prompt" machines — but machines learning to speak each human's language. Co-Dialectic teaches both sides simultaneously. The flywheel converges toward fluency.

Prompt engineering is step one. Co-intelligence is the destination.

---

## Contributing

This library grows through practice. If you discover a technique that works, submit a PR:

1. The technique name
2. A before/after example from a real conversation
3. The generative principle (not a narrow fix — a concept that covers future situations)
4. Why it compounds

See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

---

## Attribution

Inspired by Ethan Mollick's [Co-Intelligence](https://www.oneusefulthing.org/) and built on [Dr. Jules White's Prompt Engineering specialization](https://www.coursera.org/specializations/prompt-engineering) on Coursera.

MIT License.
