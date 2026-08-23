# BLabsAIGate — Agent Skills

Drop-in skills for any AI agent. Copy a **same-origin** link from the showroom UI (or paths below) and paste it to your AI.

> Tip: start with the **blabs** entry skill.

## Skills (paths on this host)

| Capability | Path |
|---|---|
| BLabsAIGate (Entry) | `/blabs/skills/blabs/SKILL.md` |
| Chat | `/blabs/skills/blabs-chat/SKILL.md` |
| Image Generation | `/blabs/skills/blabs-image/SKILL.md` |
| Text-to-Speech | `/blabs/skills/blabs-tts/SKILL.md` |
| Speech-to-Text | `/blabs/skills/blabs-stt/SKILL.md` |
| Embeddings | `/blabs/skills/blabs-embeddings/SKILL.md` |
| Web Search | `/blabs/skills/blabs-web-search/SKILL.md` |
| Web Fetch | `/blabs/skills/blabs-web-fetch/SKILL.md` |

## How to use

```
Read this skill and use it: <BLABS_URL>/blabs/skills/blabs/SKILL.md
```

## Configure once

```bash
export BLABS_URL="https://<this-showroom-host>"
export BLABS_KEY="sk-..."
```

Verify: `curl $BLABS_URL/api/health` → `{"ok":true}`.
