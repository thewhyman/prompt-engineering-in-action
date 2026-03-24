# Contributing to Prompt Engineering in Action

This library grows through practice. If you discover a technique that works, submit a PR.

## What to include

1. **Technique name** — something memorable
2. **Before/after example** — from a real conversation, not hypothetical
3. **Generative principle** — the broad concept, not a narrow fix
4. **Why it compounds** — how it makes future interactions better, not just this one

## File structure

Each technique gets its own directory under the root:

```
your-technique-name/
├── SKILL.md    (the paste-able instructions)
├── README.md   (the product page)
└── examples/   (optional)
```

## Quality bar

- Must work with at least 2 different LLMs (Claude + ChatGPT, etc.)
- Must be tested by pasting SKILL.md into a fresh conversation
- No platform-specific dependencies (no file system, no APIs, no plugins)
- MIT license

## Code of conduct

Be kind. Teach through practice, not lectures.
