# Discovery Prompt: n8n "Health Data Hub Coach"

Paste this to Claude Code (or whichever agent you're driving the build with) pointed at
your `n8n-stack` repo. It's scoped as **discovery only** — no workflows get built or
activated until Phase 4 sign-off.

---

## Context to give the agent

```
I'm extending my self-hosted n8n instance (Raspberry Pi, Postgres backend, three DBs:
n8n / health_pi / rag) into a "coach" layer that reduces friction in my personal health
tracking. Read automations/health-hub/CLAUDE.md before proposing anything — it has my
schema, credential names, and prior mistakes in this domain.

I already have:
- A health-data MCP server (health-mcp.michaelfigari.com) exposing Postgres health data
  (Peloton/Strava/Oura/Cronometer) to Claude via Cloudflare Tunnel
- A working voice-note pipeline (Notion Voice Notes 3.0) — Groq whisper-large-v3-turbo
  for transcription, openai/gpt-oss-120b for summarization — that I can reuse the pattern
  from, not necessarily the pipeline itself
- A Notion second-brain (Pillars → Pipelines → Vaults) with a Log [DB] already related
  to Projects and Tasks, and existing automation inferring habit checkboxes from
  Postgres data

This is a discovery pass. Don't propose final architecture yet — ask me what you need to
know first, then come back with 2-3 real approaches and trade-offs for each friction
point below, ranked in the order I gave them.
```

## Friction points (ranked — solve in this order)

1. **Meal logging is where I fall off entirely.** I don't enjoy the tedium of logging,
   and weighing food kills it further. What I want: dictate what I ate, in whatever
   loose/imprecise language comes naturally ("handful of almonds, maybe a cup"), and
   have the pipeline make reasonable portion-size assumptions and log it to Cronometer
   without me touching the app. Cronometer has no official public API for third-party
   diary writes — the agent needs to research current options (unofficial API,
   browser-automation node, email-to-diary, or something else) and tell me honestly
   which are viable versus fragile before we pick one.
2. **I forget to update my daily physical state in Notion.** Need a nudge/capture loop
   that doesn't rely on my own memory to trigger it — a scheduled prompt, a voice
   capture I can fire off in passing, or an inference from data I'm already collecting
   (Oura/Peloton) that fills in what it can and only asks me for what it can't infer.
3. *(more friction points to come — leave room to append here, don't design around
   only these two)*

## What "discovery" means here — ask, don't assume

Have the agent surface open questions before proposing builds, e.g.:
- For meal logging: is approximate-portion accuracy actually good enough for my
  goals, or does this need a "flag for review" step when confidence is low?
- For physical state: what fields actually live in that Notion property today, and
  which of them Postgres can already answer versus which only I know?
- Cadence and trigger: passive schedule vs. an on-demand voice/text trigger I invoke,
  and whether these two friction points should share one entry point (e.g. a single
  "talk to your coach" webhook) or stay separate workflows.
- Where transcription/parsing happens — reuse the existing Groq/whisper pattern, or is
  there a reason to route through the AI Agent node with tool calls instead now that
  n8n has that capability.

## Guardrails to restate to the agent

- Read `automations/health-hub/CLAUDE.md` first — don't relearn what's already there.
- `health_pi` is read-only from n8n unless I say otherwise — meal/state logging writes
  go to Cronometer/Notion, not directly into that schema, unless a specific case
  justifies it and I sign off.
- Native nodes and Set-node templates over Code nodes — flag any point where a Code
  node feels unavoidable and explain why.
- Nothing gets activated, and no workflow writes to Notion, sends mail, or posts to
  Slack, before I've reviewed it. Duplicate → iterate on the copy → promote deliberately.
- Tag whatever gets built `health-hub` per the existing convention so it exports into
  the right folder.

## What I want back

Not code yet. I want:
1. Clarifying questions you need answered before this is buildable
2. 2-3 concrete approaches per friction point, with real trade-offs (including where
   an approach is likely to be fragile or high-maintenance)
3. A recommendation on whether these two (soon three+) friction points should be one
   workflow with branching or separate workflows sharing a common capture pattern
