# Agent Guide: cf-blog-watcher

## Project Overview

Cloudflare Worker monitors blog.cloudflare.com RSS, sends email digests with AI-generated article analyses. Cron Triggers + HTTP handler, Workers KV state, Send Email delivery, Workers AI summarization.

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.js` | Main entry. Exports `scheduled()` and `fetch()` handlers. |
| `wrangler.jsonc` | Platform config: bindings, triggers, vars, account_id. |
| `package.json` | Standard Node project. Scripts: `dev`, `deploy`. |
| `.gitignore` | Excludes `node_modules/`, `.wrangler/`, `.dev.vars`. |

## Architecture

```
Cron Trigger (daily 15:00 UTC) ─┐
                                ├─→ runDigest(env)
HTTP GET /trigger + debug ──────┘       │
                                           ▼
                            ┌─────────────────────────┐
                            │ 1. fetch RSS feed         │
                            │ 2. parseFeed() → items    │
                            │ 3. loadState() from KV    │
                            │ 4. filter new items       │
                            │ 5. fetch article HTML       │
                            │ 6. extractArticleText()   │
                            │ 7. AI.analyze()           │
                            │ 8. renderDigest()         │
                            │ 9. EMAIL.send()           │
                            │ 10. saveState() to KV     │
                            └─────────────────────────┘
```

**Security:** `workers_dev: false` removes public `.workers.dev` URL. `/trigger` active only when `ENABLE_DEBUG=true`.

## Development Workflow

### Local dev
```bash
npm run dev
```

### Deploy
```bash
npm run deploy
```

### Tail logs
```bash
npx wrangler tail
```

### Clear KV state (testing)
```bash
npx wrangler kv key delete seen --binding "cf-blog-watcher" --preview false --remote
```

## Bindings (wrangler.jsonc)

- **`cf-blog-watcher`** (KV) — Stores `{ seen: [] }` under key `"seen"`
- **`EMAIL`** (Send Email) — Platform email
- **`AI`** (Workers AI) — LLM article analysis
- **`FROM_EMAIL`** (var) — Sender address (must own domain, Email Routing enabled)
- **`TRIGGER_TOKEN`** (secret) — High-entropy HTTP trigger token
- **`ENABLE_DEBUG`** (var) — `"true"` enables `/trigger` endpoint

## State Format

```json
{
  "seen": [
    "https://blog.cloudflare.com/article-1/",
    "https://blog.cloudflare.com/article-2/"
  ]
}
```

Bounded to 200 items: `state.seen = [...new Set([...newItems, ...state.seen])].slice(0, 200)`

## Article Extraction

`extractArticleText(html)` extracts readable text from blog HTML:
1. Strip `<header>` elements (tag clouds, breadcrumbs)
2. Find `<main>` → first `<article>` inside
3. Fall back to `<body>` if no `<article>`
4. Remove `<script>`, `<style>`, `<svg>`, remaining HTML tags
5. Collapse whitespace

Truncated to ~7000 chars before LLM.

## AI Analysis Prompt

System prompt instructs model to act as skeptical technical analyst for solutions engineers. Structure:
1. **WHAT IT IS** — precise technical description, no buzzwords
2. **WHY CUSTOMER CARES** — concrete pain points, weak value called out
3. **MARKET POSITIONING** — comparison to AWS, Vercel, Fastly, Akamai, etc. Wins and losses
4. **CUSTOMER CONVERSATION** — one sentence positioning guidance

Rules: no filler, no marketing spin, no corporate enthusiasm. Opinionated. If incremental, say so. If fluff, call it out.

## Common Modifications

| Change | Where |
|--------|-------|
| Feed URL | `FEED_URL` in `src/worker.js` |
| Recipient | `RECIPIENT` in `src/worker.js` |
| AI model | `AI_MODEL` in `src/worker.js` |
| Cron schedule | `triggers.crons` in `wrangler.jsonc` |
| Sender domain | `vars.FROM_EMAIL` in `wrangler.jsonc` |
| State limit | `.slice(0, 200)` in `src/worker.js` |
| Add RSS fields | `parseFeed()` regex in `src/worker.js` |

## Testing

1. Deploy worker
2. Set `TRIGGER_TOKEN` secret: `npx wrangler secret put TRIGGER_TOKEN`
3. Temporarily enable debug: add `ENABLE_DEBUG: "true"` and `workers_dev: true` to `wrangler.jsonc`, deploy
4. Trigger: `curl -H "X-Trigger-Token: <token>" https://<worker>/trigger`
5. Watch logs: `npx wrangler tail`
6. Verify email received, KV key `seen` updated
7. Disable debug: remove `ENABLE_DEBUG`, set `workers_dev: false`, deploy

## Important Notes

- **Email domain ownership required**: `FROM_EMAIL` domain must be active in Cloudflare account with Email Routing configured. Sending from unowned domains fails.
- **Account ID**: Set in `wrangler.jsonc` for multiple accounts. Wrangler needs this for KV/secret ops in non-interactive mode.
- **KV preview ID**: Replace `<ID_OF_PREVIEW_KV_NAMESPACE_FOR_LOCAL_DEVELOPMENT>` for local dev.
- **Email Routing**: Must be enabled on sender domain. Catch-all or specific routing rule recommended.
- **Debug mode**: `/trigger` requires `ENABLE_DEBUG=true`. Without it, endpoint returns 200 for health check but does not expose trigger. Set `workers_dev: true` temporarily for public `.workers.dev` URL.
- **TRIGGER_TOKEN**: Use high-entropy token (e.g., `crypto.randomUUID()` + `crypto.randomUUID()`). Never predictable values.
