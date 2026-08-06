# Agent Guide: cf-blog-watcher

## Project Overview

Cloudflare Worker that monitors blog.cloudflare.com RSS and sends email digests with AI-generated summaries. Uses Cron Triggers + HTTP handler, Workers KV for state, Send Email binding for delivery, and Workers AI for article summarization.

## Key Files

| File | Purpose |
|------|---------|
| `src/worker.js` | Main entry point. Exports `scheduled()` and `fetch()` handlers. |
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
                            │ 7. AI.summarize()         │
                            │ 8. renderDigest()         │
                            │ 9. EMAIL.send()           │
                            │ 10. saveState() to KV     │
                            └─────────────────────────┘
```

**Security:** `workers_dev: false` removes public `.workers.dev` URL. The `/trigger` endpoint is only active when `ENABLE_DEBUG=true`.

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

### Clear KV state (for testing)
```bash
npx wrangler kv key delete seen --binding "cf-blog-watcher" --preview false --remote
```

## Bindings (wrangler.jsonc)

- **`cf-blog-watcher`** (KV) — Stores `{ seen: [] }` under key `"seen"`
- **`EMAIL`** (Send Email) — Platform email sending
- **`AI`** (Workers AI) — LLM summarization of article content
- **`FROM_EMAIL`** (var) — Sender address (must own domain, Email Routing enabled)
- **`TRIGGER_TOKEN`** (secret) — High-entropy HTTP trigger auth token
- **`ENABLE_DEBUG`** (var) — Set `"true"` to enable the `/trigger` HTTP endpoint

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

`extractArticleText(html)` extracts readable article text from blog HTML:
1. Strips all `<header>` elements (contains tag clouds/breadcrumbs)
2. Finds `<main>` → first `<article>` inside it
3. Falls back to `<body>` if no `<article>` found
4. Removes `<script>`, `<style>`, `<svg>`, and all remaining HTML tags
5. Collapses whitespace

Content is truncated to ~4000 chars before sending to the LLM.

## Common Modifications

| Change | Where |
|--------|-------|
| Feed URL | `FEED_URL` constant in `src/worker.js` |
| Recipient | `RECIPIENT` constant in `src/worker.js` |
| AI model | `AI_MODEL` constant in `src/worker.js` |
| Cron schedule | `triggers.crons` in `wrangler.jsonc` |
| Sender domain | `vars.FROM_EMAIL` in `wrangler.jsonc` |
| State limit | `.slice(0, 200)` in `src/worker.js` |
| Add more RSS fields | `parseFeed()` regex in `src/worker.js` |

## Testing

1. Deploy worker
2. Set `TRIGGER_TOKEN` secret: `npx wrangler secret put TRIGGER_TOKEN`
3. Temporarily enable debug: add `ENABLE_DEBUG: "true"` and `workers_dev: true` to `wrangler.jsonc`, deploy
4. Trigger manually: `curl -H "X-Trigger-Token: <token>" https://<worker>/trigger`
5. Watch logs: `npx wrangler tail`
6. Verify email received, KV key `seen` updated in dash
7. Disable debug: remove `ENABLE_DEBUG`, set `workers_dev: false`, deploy

## Important Notes

- **Email domain ownership required**: The `FROM_EMAIL` domain must be active in your Cloudflare account with Email Routing configured. Sending from `cloudflare.com` or other unowned domains will fail.
- **Account ID**: Set in `wrangler.jsonc` if you have multiple accounts. Wrangler needs this for KV/secret operations in non-interactive mode.
- **KV preview ID**: Replace `<ID_OF_PREVIEW_KV_NAMESPACE_FOR_LOCAL_DEVELOPMENT>` for local dev with KV.
- **Email Routing**: Must be enabled on sender domain. Catch-all or specific routing rule recommended.
- **Debug mode**: The `/trigger` endpoint requires `ENABLE_DEBUG=true`. Without it, the endpoint returns 200 for the health check but does not expose the trigger. Set `workers_dev: true` temporarily if you need a public `.workers.dev` URL for testing.
- **TRIGGER_TOKEN**: Use a high-entropy token (e.g., `crypto.randomUUID()` + `crypto.randomUUID()`). Never use predictable values.
