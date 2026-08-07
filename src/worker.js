const FEED_URL = 'https://blog.cloudflare.com/rss/';
const RECIPIENT = 'you@example.com';
const AI_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDigest(env).catch(err => console.error('Digest failed:', err)));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Debug trigger endpoint — disabled by default for security
    if (env.ENABLE_DEBUG === 'true' && url.pathname === '/trigger') {
      const token = request.headers.get('X-Trigger-Token');
      if (token === env.TRIGGER_TOKEN) {
        try {
          await runDigest(env);
          return new Response('Digest triggered successfully', { status: 200 });
        } catch (err) {
          console.error('Manual trigger failed:', err);
          return new Response(`Error: ${err.message}`, { status: 500 });
        }
      }
      return new Response('Unauthorized', { status: 401 });
    }

    return new Response('Cloudflare Blog Watcher OK', { status: 200 });
  },
};

export async function runDigest(env) {
  console.log('=== Starting blog digest ===');

  const xml = await fetch(FEED_URL).then(r => {
    if (!r.ok) throw new Error(`Feed fetch failed: ${r.status}`);
    return r.text();
  });

  const items = parseFeed(xml);
  console.log(`Feed parsed: ${items.length} total items`);
  if (!items.length) {
    console.log('No items found in feed');
    return;
  }

  const state = await loadState(env);
  console.log(`State loaded: ${state.seen.length} seen items`);

  const newItems = items.filter(item => !state.seen.includes(item.link));
  console.log(`New items found: ${newItems.length}`);

  if (!newItems.length) {
    console.log('No new items');
    return;
  }

  console.log('New items:', newItems.map(i => i.title));

  // Summarize each new article
  console.log('Analyzing articles...');
  for (const item of newItems) {
    try {
      item.summary = await summarizeArticle(env, item.link, item.description);
      console.log(`Analyzed: ${item.title}`);
    } catch (err) {
      console.error(`Analysis failed for ${item.link}:`, err.message);
      item.summary = item.description; // fallback to RSS description
    }
  }

  const { text: bodyText, html: bodyHtml } = renderDigest(newItems);
  await env.EMAIL.send({
    to: RECIPIENT,
    from: env.FROM_EMAIL,
    subject: `${newItems.length} new Cloudflare blog article${newItems.length !== 1 ? 's' : ''} — ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    text: bodyText,
    html: bodyHtml,
  });

  state.seen = [...new Set([...newItems.map(i => i.link), ...state.seen])].slice(0, 200);
  console.log(`Updated state: ${state.seen.length} total seen items`);

  await saveState(env, state);
  console.log(`Sent digest with ${newItems.length} new items`);
}

export function parseFeed(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?(?:<pubDate>([\s\S]*?)<\/pubDate>)?[\s\S]*?<description>([\s\S]*?)<\/description>[\s\S]*?<\/item>/gi)].map(m => ({
    title: clean(m[1]),
    link: clean(m[2]),
    pubDate: m[3] ? new Date(clean(m[3])).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '',
    description: clean(m[4]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

export async function summarizeArticle(env, url, rssDescription) {
  const html = await fetch(url).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });

  const content = extractArticleText(html);
  if (!content) throw new Error('No article content extracted');

  // Truncate to ~7000 chars to give the model more context
  const truncated = content.slice(0, 7000);

  const response = await env.AI.run(AI_MODEL, {
    messages: [
      {
        role: 'system',
        content: `You are a skeptical technical analyst writing for a senior solutions engineer who needs to position Cloudflare products to enterprise customers. Your job is to cut through marketing and evaluate the actual technical substance of each blog post.

For every article, produce a tight 3-5 sentence analysis in this exact structure. Separate each section with a blank line:

1. WHAT IT IS — A precise, technical description of the product/feature/announcement. No buzzwords. If the post is vague, say so.

2. WHY A CUSTOMER CARES — Concrete customer pain points this solves. Be specific about who benefits and how. If the value proposition is weak, say it's weak.

3. MARKET POSITIONING — How this compares to competitors (AWS, Vercel, Fastly, Akamai, Datadog, etc.). Where does it win? Where does it lose? If there's no real differentiation, call that out.

4. CUSTOMER CONVERSATION — One sentence on how to position this with a customer. Be direct.

Rules:
- No filler. No "This matters because," "In today's landscape," "As organizations increasingly..."
- No marketing spin. If the feature is incremental, say it's incremental. If the post is fluff, say it's fluff.
- Be opinionated. Take a stance.
- Use technical precision over vague optimism.
- If the article is a rehash of an existing capability with new branding, call that out immediately.
- Never say "Cloudflare is excited to announce" or quote corporate enthusiasm.
- Output only the analysis — no preamble, no framing, no section headers.`
      },
      {
        role: 'user',
        content: `RSS teaser: ${rssDescription || 'N/A'}\n\nArticle body (first 7000 chars):\n${truncated}`,
      },
    ],
  });

  return response.response?.trim() || 'Analysis unavailable.';
}

export function extractArticleText(html) {
  // Strip <header> elements first — they contain tag clouds and breadcrumbs
  const withoutHeaders = html.replace(/<header[\s\S]*?<\/header>/gi, '');

  // Find <main>, then the first <article> inside it
  const mainMatch = withoutHeaders.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    const articleMatch = mainMatch[1].match(/<article(?![^>]*animate-pulse)[^>]*>([\s\S]*?)<\/article>/i);
    if (articleMatch) {
      return stripHtml(articleMatch[1]);
    }
    return stripHtml(mainMatch[1]);
  }

  // Fallback: first <article> anywhere
  const articleMatch = withoutHeaders.match(/<article(?![^>]*animate-pulse)[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    return stripHtml(articleMatch[1]);
  }

  // Fallback: <body>
  const bodyMatch = withoutHeaders.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    return stripHtml(bodyMatch[1]);
  }

  // Last resort: full HTML
  return stripHtml(withoutHeaders);
}

export function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s([.,;:!?])/g, '$1')
    .trim();
}

export function renderDigest(items) {
  const dateStr = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  // Plain-text fallback
  const textLines = [
    `${items.length} new Cloudflare blog article${items.length !== 1 ? 's' : ''} — ${dateStr}`,
    '',
  ];
  items.forEach((item, i) => {
    textLines.push(`[${i + 1}] ${item.title}`);
    if (item.pubDate) textLines.push(`    Date: ${item.pubDate}`);
    textLines.push(`    ${item.link}`);
    textLines.push(`    ${item.summary || 'Not available.'}`);
    textLines.push('');
  });

  // HTML email body
  const articlesHtml = items.map((item, i) => `
    <tr>
      <td style="padding: 32px 0 0 0;">
        <table width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 18px; line-height: 26px; color: #111827; font-weight: 600; padding: 0 0 8px 0;">
              ${i + 1}. ${escapeHtml(item.title)}
            </td>
          </tr>
          ${item.pubDate ? `
          <tr>
            <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 20px; color: #6b7280; padding: 0 0 4px 0;">
              ${escapeHtml(item.pubDate)}
            </td>
          </tr>
          ` : ''}
          <tr>
            <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 20px; padding: 0 0 12px 0;">
              <a href="${escapeHtml(item.link)}" style="color: #f48120; text-decoration: none;">${escapeHtml(item.link)}</a>
            </td>
          </tr>
          <tr>
            <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; line-height: 24px; color: #374151;">
              ${escapeHtml(item.summary || 'Not available.').replace(/\n/g, '<br>')}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Cloudflare Blog Digest</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f3f4f6;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6;">
  <tr>
    <td align="center" style="padding: 40px 16px;">
      <table width="100%" max-width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <tr>
          <td style="padding: 32px 32px 0 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 24px; line-height: 32px; font-weight: 700; color: #111827; padding: 0 0 4px 0;">
                  Cloudflare Blog Digest
                </td>
              </tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 22px; color: #6b7280;">
                  ${items.length} article${items.length !== 1 ? 's' : ''} — ${escapeHtml(dateStr)}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top: 1px solid #e5e7eb; padding: 0;"></td></tr>
              ${articlesHtml}
              <tr><td style="padding: 32px 0 0 0;"></td></tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding: 0 32px 32px 32px;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="border-top: 1px solid #e5e7eb; padding: 0 0 16px 0;"></td></tr>
              <tr>
                <td style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 12px; line-height: 18px; color: #9ca3af;">
                  Analyses generated by Workers AI
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { text: textLines.join('\n'), html };
}

export function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function clean(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

export async function loadState(env) {
  try {
    const raw = await env['cf-blog-watcher'].get('seen');
    if (raw) {
      const parsed = JSON.parse(raw);
      console.log(`KV read success: key='seen', ${raw.length} bytes, ${parsed.seen?.length || 0} items`);
      return parsed;
    } else {
      console.log('KV read: key=seen not found, returning empty state');
      return { seen: [] };
    }
  } catch (err) {
    console.error('KV read failed:', err.message);
    return { seen: [] };
  }
}

export async function saveState(env, state) {
  try {
    const serialized = JSON.stringify(state);
    await env['cf-blog-watcher'].put('seen', serialized);
    console.log(`KV write success: key='seen', ${serialized.length} bytes, ${state.seen.length} items`);
  } catch (err) {
    console.error('KV write failed:', err.message);
    throw err;
  }
}
