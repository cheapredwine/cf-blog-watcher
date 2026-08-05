const FEED_URL = 'https://blog.cloudflare.com/rss/';
const RECIPIENT = 'you@example.com';

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

async function runDigest(env) {
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

  const body = renderDigest(newItems);
  await env.EMAIL.send({
    to: RECIPIENT,
    from: env.FROM_EMAIL,
    subject: `Cloudflare Blog Digest - ${new Date().toISOString().slice(0, 10)}`,
    text: body,
  });

  state.seen = [...new Set([...newItems.map(i => i.link), ...state.seen])].slice(0, 200);
  console.log(`Updated state: ${state.seen.length} total seen items`);

  await saveState(env, state);
  console.log(`Sent digest with ${newItems.length} new items`);
}

function parseFeed(xml) {
  return [...xml.matchAll(/<item>[\s\S]*?<title>([\s\S]*?)<\/title>[\s\S]*?<link>([\s\S]*?)<\/link>[\s\S]*?<description>([\s\S]*?)<\/description>/gi)].map(m => ({
    title: clean(m[1]),
    link: clean(m[2]),
    description: clean(m[3]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
  }));
}

function renderDigest(items) {
  const out = [
    '# Cloudflare Blog Digest',
    `Recipient: ${RECIPIENT}`,
    `Source: ${FEED_URL}`,
    '',
    `New articles: ${items.length}`,
    '',
  ];
  for (const item of items) {
    out.push(`- ${item.title}`);
    out.push(`  ${item.link}`);
    out.push(`  ${item.description.slice(0, 220) || 'No description available.'}`);
    out.push('');
  }
  return out.join('\n');
}

function clean(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, '').trim();
}

async function loadState(env) {
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

async function saveState(env, state) {
  try {
    const serialized = JSON.stringify(state);
    await env['cf-blog-watcher'].put('seen', serialized);
    console.log(`KV write success: key='seen', ${serialized.length} bytes, ${state.seen.length} items`);
  } catch (err) {
    console.error('KV write failed:', err.message);
    throw err;
  }
}
