---
name: blabs
description: Entry point for BLabsAIGate — showroom AI gateway with OpenAI-compatible REST for chat, image, TTS, embeddings, web search, web fetch. Use when the user mentions BLabsAIGate, BLABS_URL, or wants AI through this showroom without provider boilerplate. Covers setup + indexes capability skills served from this same host under /blabs/skills/.
---

# BLabsAIGate

Showroom AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

Skills for this product are hosted on **this same showroom** (not GitHub). Prefer absolute URLs built from the page you opened (Cloudflare tunnel or Tailscale Funnel).

## Setup

```bash
export BLABS_URL="https://<this-showroom-host>"   # CF tunnel or Tailscale Funnel URL
export BLABS_KEY="sk-..."                         # from Dashboard → Endpoint & Key (when API key required)
```

All requests: `${BLABS_URL}/v1/...` with header `Authorization: Bearer ${BLABS_KEY}` (omit if auth disabled).

Verify: `curl $BLABS_URL/api/health` → `{"ok":true}`

## Discover models

```bash
curl $BLABS_URL/v1/models                  # chat/LLM (default)
curl $BLABS_URL/v1/models/image            # image-gen
curl $BLABS_URL/v1/models/tts              # text-to-speech
curl $BLABS_URL/v1/models/embedding        # embeddings
curl $BLABS_URL/v1/models/web              # web search + fetch (entries have `kind` field)
curl $BLABS_URL/v1/models/stt              # speech-to-text
curl $BLABS_URL/v1/models/image-to-text    # vision
```

Use `data[].id` as `model` field in requests. Combos appear with `owned_by:"combo"`.

## Capability skills

Fetch each skill from **this showroom** (same origin as this file):

| Capability | Path on this host |
|---|---|
| Chat / code-gen | `/blabs/skills/blabs-chat/SKILL.md` |
| Image generation | `/blabs/skills/blabs-image/SKILL.md` |
| Text-to-speech | `/blabs/skills/blabs-tts/SKILL.md` |
| Speech-to-text | `/blabs/skills/blabs-stt/SKILL.md` |
| Embeddings | `/blabs/skills/blabs-embeddings/SKILL.md` |
| Web search | `/blabs/skills/blabs-web-search/SKILL.md` |
| Web fetch | `/blabs/skills/blabs-web-fetch/SKILL.md` |

Paste to your AI:

```
Read this skill and use it: ${BLABS_URL}/blabs/skills/blabs/SKILL.md
```

## Errors

- 401 → set/refresh `BLABS_KEY` (Dashboard → Endpoint & Key)
- 400 `Invalid model format` → check `model` exists in `/v1/models/<kind>`
- 503 `All accounts unavailable` → wait `retry-after` or ask the showroom operator
