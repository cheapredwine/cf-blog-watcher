import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { parseFeed, clean, renderDigest, loadState, saveState, runDigest, formatSummary, summarizeArticle, loadConfig } from '../src/worker.js';
import { DEFAULT_FEED_URL, DEFAULT_AI_MODEL, DEFAULT_SYSTEM_PROMPT } from '../src/config.js';

describe('parseFeed', () => {
  it('extracts title, link, pubDate, and description from RSS items', () => {
    const xml = `
      <rss>
        <item>
          <title>Post One</title>
          <link>https://blog.cloudflare.com/post-one/</link>
          <description>First post description</description>
        </item>
        <item>
          <title>Post Two</title>
          <link>https://blog.cloudflare.com/post-two/</link>
          <description>Second post description</description>
        </item>
      </rss>
    `;
    const items = parseFeed(xml);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: 'Post One',
      link: 'https://blog.cloudflare.com/post-one/',
      pubDate: '',
      description: 'First post description',
    });
    expect(items[1]).toEqual({
      title: 'Post Two',
      link: 'https://blog.cloudflare.com/post-two/',
      pubDate: '',
      description: 'Second post description',
    });
  });

  it('strips CDATA wrappers', () => {
    const xml = `
      <item>
        <title><![CDATA[CDATA Title]]></title>
        <link>https://blog.cloudflare.com/cdata-post/</link>
        <description><![CDATA[<p>HTML in description</p>]]></description>
      </item>
    `;
    const items = parseFeed(xml);
    expect(items[0].title).toBe('CDATA Title');
    expect(items[0].description).toBe('HTML in description');
  });

  it('strips HTML tags from description', () => {
    const xml = `
      <item>
        <title>HTML Test</title>
        <link>https://blog.cloudflare.com/html-test/</link>
        <description><![CDATA[<p>Paragraph</p><br><strong>Bold</strong>]]></description>
      </item>
    `;
    const items = parseFeed(xml);
    expect(items[0].description).toBe('Paragraph Bold');
  });

  it('returns empty array for empty XML', () => {
    expect(parseFeed('')).toEqual([]);
  });

  it('handles items without description', () => {
    const xml = `
      <item>
        <title>Title Only</title>
        <link>https://blog.cloudflare.com/title-only/</link>
      </item>
    `;
    expect(parseFeed(xml)).toEqual([]);
  });
});

describe('clean', () => {
  it('removes CDATA markers', () => {
    expect(clean('<![CDATA[hello]]>')).toBe('hello');
    expect(clean('<![CDATA[ nested <![CDATA[deep]]> ]]>')).toBe('nested deep');
  });

  it('trims whitespace', () => {
    expect(clean('  hello world  ')).toBe('hello world');
  });

  it('returns empty string for empty input', () => {
    expect(clean('')).toBe('');
  });
});

describe('formatSummary', () => {
  const numbered = 'Fits the platform story. 1. WHAT IT IS — An edge-native queue. 2. WHY A CUSTOMER CARES — Lost work. 3. MARKET POSITIONING — Beats SQS on latency. 4. CUSTOMER CONVERSATION — Lead with durability.';

  it('keeps section numbers attached to their labels in HTML', () => {
    const html = formatSummary(numbered, true);
    expect(html).toContain('<strong>1. WHAT IT IS —</strong>');
    expect(html).toContain('<strong>2. WHY A CUSTOMER CARES —</strong>');
    expect(html).toContain('<strong>3. MARKET POSITIONING —</strong>');
    expect(html).toContain('<strong>4. CUSTOMER CONVERSATION —</strong>');
  });

  it('never leaves a dangling number at the end of the previous paragraph', () => {
    const html = formatSummary(numbered, true);
    expect(html).not.toMatch(/\d\.\s*<br><br><strong>/);
  });

  it('breaks paragraphs before each numbered section in HTML', () => {
    const html = formatSummary(numbered, true);
    expect(html).toContain('Fits the platform story.<br><br><strong>1. WHAT IT IS —</strong>');
    expect(html).toContain('queue.<br><br><strong>2. WHY A CUSTOMER CARES —</strong>');
    expect(html).toContain('work.<br><br><strong>3. MARKET POSITIONING —</strong>');
  });

  it('breaks paragraphs before each numbered section in text', () => {
    const text = formatSummary(numbered, false);
    expect(text).toContain('Fits the platform story.\n\n1. WHAT IT IS —');
    expect(text).toContain('queue.\n\n2. WHY A CUSTOMER CARES —');
    expect(text).not.toMatch(/\d\.\n\n/);
  });

  it('handles summaries without leading numbers', () => {
    const plain = 'Intro line. WHAT IT IS — A queue. WHY A CUSTOMER CARES — Durability.';
    const html = formatSummary(plain, true);
    expect(html).toContain('<strong>WHAT IT IS —</strong>');
    expect(html).toContain('<strong>WHY A CUSTOMER CARES —</strong>');
    expect(html).toContain('Intro line.<br><br><strong>WHAT IT IS —</strong>');
  });

  it('leaves summaries without section labels untouched', () => {
    const plain = 'Just a plain summary sentence.';
    expect(formatSummary(plain, true)).toBe('Just a plain summary sentence.');
    expect(formatSummary(plain, false)).toBe('Just a plain summary sentence.');
  });
});

describe('renderDigest', () => {
  it('renders HTML digest with all items', () => {
    const items = [
      {
        title: 'Post One',
        link: 'https://blog.cloudflare.com/post-one/',
        summary: 'Analysis one',
      },
      {
        title: 'Post Two',
        link: 'https://blog.cloudflare.com/post-two/',
        summary: 'Analysis two',
      },
    ];
    const { text, html } = renderDigest(items);
    expect(html).toContain('Cloudflare Blog Digest');
    expect(html).toContain('Post One');
    expect(html).toContain('Post Two');
    expect(html).toContain('Analysis one');
    expect(html).toContain('Analysis two');
    expect(text).toContain('Post One');
    expect(text).toContain('Analysis one');
  });

  it('shows fallback for empty summary', () => {
    const items = [{
      title: 'No Summary',
      link: 'https://blog.cloudflare.com/no-summary/',
      summary: '',
    }];
    const { html, text } = renderDigest(items);
    expect(html).toContain('Not available.');
    expect(text).toContain('Not available.');
  });
});

describe('loadState', () => {
  it('returns empty state when KV key not found', async () => {
    const env = {
      'cf-blog-watcher': { get: vi.fn().mockResolvedValue(null) },
    };
    const state = await loadState(env);
    expect(state).toEqual({ seen: [] });
    expect(env['cf-blog-watcher'].get).toHaveBeenCalledWith('seen');
  });

  it('parses and returns existing state', async () => {
    const env = {
      'cf-blog-watcher': {
        get: vi.fn().mockResolvedValue(JSON.stringify({ seen: ['https://example.com/1'] })),
      },
    };
    const state = await loadState(env);
    expect(state).toEqual({ seen: ['https://example.com/1'] });
  });

  it('returns empty state on parse error', async () => {
    const env = {
      'cf-blog-watcher': { get: vi.fn().mockResolvedValue('invalid json') },
    };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const state = await loadState(env);
    expect(state).toEqual({ seen: [] });
    consoleSpy.mockRestore();
  });
});

describe('saveState', () => {
  it('serializes and writes state to KV', async () => {
    const env = {
      'cf-blog-watcher': { put: vi.fn().mockResolvedValue(undefined) },
    };
    const state = { seen: ['https://example.com/1'] };
    await saveState(env, state);
    expect(env['cf-blog-watcher'].put).toHaveBeenCalledWith('seen', JSON.stringify(state));
  });

  it('throws on KV write failure', async () => {
    const env = {
      'cf-blog-watcher': { put: vi.fn().mockRejectedValue(new Error('KV down')) },
    };
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(saveState(env, { seen: [] })).rejects.toThrow('KV down');
    consoleSpy.mockRestore();
  });
});

describe('loadConfig', () => {
  const consoleSpySetup = () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    return { log, err };
  };

  it('returns defaults when KV is empty', async () => {
    const env = {
      'cf-blog-watcher': { get: vi.fn().mockResolvedValue(null) },
    };
    const spy = consoleSpySetup();
    const config = await loadConfig(env);
    expect(config).toEqual({
      feedUrl: DEFAULT_FEED_URL,
      aiModel: DEFAULT_AI_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    expect(env['cf-blog-watcher'].get).toHaveBeenCalledWith('feed_url');
    expect(env['cf-blog-watcher'].get).toHaveBeenCalledWith('ai_model');
    expect(env['cf-blog-watcher'].get).toHaveBeenCalledWith('system_prompt');
    spy.log.mockRestore();
    spy.err.mockRestore();
  });

  it('returns KV overrides for all three keys', async () => {
    const kvGet = vi.fn(key => {
      if (key === 'feed_url') return Promise.resolve('https://example.com/feed.xml');
      if (key === 'ai_model') return Promise.resolve('@cf/meta/llama-4-scout');
      if (key === 'system_prompt') return Promise.resolve('Custom prompt rules.');
      return Promise.resolve(null);
    });
    const env = { 'cf-blog-watcher': { get: kvGet } };
    const spy = consoleSpySetup();
    const config = await loadConfig(env);
    expect(config).toEqual({
      feedUrl: 'https://example.com/feed.xml',
      aiModel: '@cf/meta/llama-4-scout',
      systemPrompt: 'Custom prompt rules.',
    });
    spy.log.mockRestore();
    spy.err.mockRestore();
  });

  it('falls back to defaults for whitespace-only overrides', async () => {
    const kvGet = vi.fn(key => {
      if (key === 'feed_url') return Promise.resolve('   ');
      if (key === 'ai_model') return Promise.resolve('\n\t');
      if (key === 'system_prompt') return Promise.resolve('  ');
      return Promise.resolve(null);
    });
    const env = { 'cf-blog-watcher': { get: kvGet } };
    const spy = consoleSpySetup();
    const config = await loadConfig(env);
    expect(config).toEqual({
      feedUrl: DEFAULT_FEED_URL,
      aiModel: DEFAULT_AI_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    spy.log.mockRestore();
    spy.err.mockRestore();
  });

  it('falls back to defaults when KV reads throw', async () => {
    const env = {
      'cf-blog-watcher': { get: vi.fn().mockRejectedValue(new Error('KV down')) },
    };
    const spy = consoleSpySetup();
    const config = await loadConfig(env);
    expect(config).toEqual({
      feedUrl: DEFAULT_FEED_URL,
      aiModel: DEFAULT_AI_MODEL,
      systemPrompt: DEFAULT_SYSTEM_PROMPT,
    });
    spy.log.mockRestore();
    spy.err.mockRestore();
  });

  it('trims whitespace around KV values', async () => {
    const env = {
      'cf-blog-watcher': { get: vi.fn().mockResolvedValue('  @cf/meta/llama-4-scout  ') },
    };
    const spy = consoleSpySetup();
    const config = await loadConfig(env);
    expect(config.aiModel).toBe('@cf/meta/llama-4-scout');
    spy.log.mockRestore();
    spy.err.mockRestore();
  });
});

describe('summarizeArticle', () => {
  it('uses the provided model and system prompt', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><article><p>Content</p></article></body></html>'),
    });
    const aiRun = vi.fn().mockResolvedValue({ response: '  Analysis.  ' });
    const env = { AI: { run: aiRun } };

    const summary = await summarizeArticle(env, 'https://blog.cloudflare.com/x/', 'Teaser', '@cf/custom-model', 'Custom system prompt.');

    expect(aiRun).toHaveBeenCalledWith('@cf/custom-model', expect.objectContaining({
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'Custom system prompt.' },
        { role: 'user', content: expect.stringContaining('Teaser') },
      ],
    }));
    expect(summary).toBe('Analysis.');
  });

  it('defaults to built-in model and system prompt', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><article><p>Content</p></article></body></html>'),
    });
    const aiRun = vi.fn().mockResolvedValue({ response: 'Analysis.' });
    const env = { AI: { run: aiRun } };

    await summarizeArticle(env, 'https://blog.cloudflare.com/x/', 'Teaser');

    const [model, opts] = aiRun.mock.calls[0];
    expect(model).toBe(DEFAULT_AI_MODEL);
    expect(opts.messages[0].content).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('throws when article content cannot be extracted', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<html><body><script>var x=1;</script></body></html>'),
    });
    const env = { AI: { run: vi.fn() } };

    await expect(summarizeArticle(env, 'https://blog.cloudflare.com/x/', 'Teaser')).rejects.toThrow('No article content extracted');
  });
});

describe('fetch handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 200 OK for health check', async () => {
    const request = new Request('https://example.com/');
    const env = {};
    const response = await worker.fetch(request, env, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Cloudflare Blog Watcher OK');
  });

  it('returns 200 but does not trigger when ENABLE_DEBUG is not set', async () => {
    const request = new Request('https://example.com/trigger', {
      headers: { 'X-Trigger-Token': 'valid-token' },
    });
    const env = {
      TRIGGER_TOKEN: 'valid-token',
    };
    const response = await worker.fetch(request, env, {});
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('Cloudflare Blog Watcher OK');
  });

  it('returns 401 for invalid token when debug enabled', async () => {
    const request = new Request('https://example.com/trigger', {
      headers: { 'X-Trigger-Token': 'wrong-token' },
    });
    const env = {
      ENABLE_DEBUG: 'true',
      TRIGGER_TOKEN: 'valid-token',
    };
    const response = await worker.fetch(request, env, {});
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('Unauthorized');
  });

  it('returns 401 when no token header with debug enabled', async () => {
    const request = new Request('https://example.com/trigger');
    const env = {
      ENABLE_DEBUG: 'true',
      TRIGGER_TOKEN: 'valid-token',
    };
    const response = await worker.fetch(request, env, {});
    expect(response.status).toBe(401);
  });
});

describe('runDigest integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends email and saves state when new items found', async () => {
    const mockXml = `
      <rss>
        <item>
          <title>New Post</title>
          <link>https://blog.cloudflare.com/new-post/</link>
          <description>Fresh content</description>
        </item>
      </rss>
    `;
    const mockHtml = '<html><body><article><p>Article content here</p></article></body></html>';
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockXml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockHtml) });

    const emailSend = vi.fn().mockResolvedValue(undefined);
    const kvPut = vi.fn().mockResolvedValue(undefined);
    const kvGet = vi.fn().mockResolvedValue(null);
    const aiRun = vi.fn().mockResolvedValue({ response: 'AI-generated analysis of the article.' });

    const env = {
      'cf-blog-watcher': { get: kvGet, put: kvPut },
      EMAIL: { send: emailSend },
      AI: { run: aiRun },
      RECIPIENT: 'you@example.com',
      FROM_EMAIL: 'no-reply@example.com',
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDigest(env);

    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'you@example.com',
      from: 'no-reply@example.com',
    }));
    expect(kvPut).toHaveBeenCalledTimes(1);

    consoleSpy.mockRestore();
  });

  it('skips email when no new items', async () => {
    const mockXml = `
      <rss>
        <item>
          <title>Old Post</title>
          <link>https://blog.cloudflare.com/old-post/</link>
          <description>Already seen</description>
        </item>
      </rss>
    `;
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(mockXml),
    });

    const emailSend = vi.fn();
    const kvPut = vi.fn();
    const kvGet = vi.fn().mockResolvedValue(
      JSON.stringify({ seen: ['https://blog.cloudflare.com/old-post/'] })
    );

    const env = {
      'cf-blog-watcher': { get: kvGet, put: kvPut },
      EMAIL: { send: emailSend },
      FROM_EMAIL: 'no-reply@example.com',
      RECIPIENT: 'you@example.com',
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDigest(env);

    expect(emailSend).not.toHaveBeenCalled();
    expect(kvPut).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  it('throws on feed fetch failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    });

    const env = {
      'cf-blog-watcher': { get: vi.fn(), put: vi.fn() },
      EMAIL: { send: vi.fn() },
      FROM_EMAIL: 'no-reply@example.com',
      RECIPIENT: 'you@example.com',
    };

    await expect(runDigest(env)).rejects.toThrow('Feed fetch failed: 503');
  });

  it('throws before fetching when RECIPIENT is missing', async () => {
    global.fetch = vi.fn();

    const env = {
      'cf-blog-watcher': { get: vi.fn(), put: vi.fn() },
      EMAIL: { send: vi.fn() },
      FROM_EMAIL: 'no-reply@example.com',
    };

    await expect(runDigest(env)).rejects.toThrow(/RECIPIENT or FROM_EMAIL/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('throws before fetching when FROM_EMAIL is missing', async () => {
    global.fetch = vi.fn();

    const env = {
      'cf-blog-watcher': { get: vi.fn(), put: vi.fn() },
      EMAIL: { send: vi.fn() },
      RECIPIENT: 'you@example.com',
    };

    await expect(runDigest(env)).rejects.toThrow(/RECIPIENT or FROM_EMAIL/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('throws before fetching when both email vars are empty strings', async () => {
    global.fetch = vi.fn();

    const env = {
      'cf-blog-watcher': { get: vi.fn(), put: vi.fn() },
      EMAIL: { send: vi.fn() },
      RECIPIENT: '',
      FROM_EMAIL: '',
    };

    await expect(runDigest(env)).rejects.toThrow(/RECIPIENT or FROM_EMAIL/);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(env.EMAIL.send).not.toHaveBeenCalled();
  });

  it('sends email addresses exactly as configured in env', async () => {
    const mockXml = `
      <rss>
        <item>
          <title>Post</title>
          <link>https://blog.cloudflare.com/post/</link>
          <description>Desc</description>
        </item>
      </rss>
    `;
    const mockHtml = '<html><body><article><p>Body</p></article></body></html>';
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockXml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockHtml) });

    const emailSend = vi.fn().mockResolvedValue(undefined);
    const aiRun = vi.fn().mockResolvedValue({ response: 'Analysis.' });

    const env = {
      'cf-blog-watcher': { get: vi.fn().mockResolvedValue(null), put: vi.fn() },
      EMAIL: { send: emailSend },
      AI: { run: aiRun },
      RECIPIENT: 'custom-recipient@team.example.org',
      FROM_EMAIL: 'watcher@sender.example.org',
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runDigest(env);

    expect(emailSend).toHaveBeenCalledWith(expect.objectContaining({
      to: 'custom-recipient@team.example.org',
      from: 'watcher@sender.example.org',
    }));

    consoleSpy.mockRestore();
    consoleErrSpy.mockRestore();
  });

  it('bounds state to 200 items', async () => {
    const mockXml = `
      <rss>
        <item>
          <title>Post 1</title>
          <link>https://blog.cloudflare.com/post-1/</link>
          <description>Desc 1</description>
        </item>
      </rss>
    `;
    const mockHtml = '<html><body><article><p>Article content here</p></article></body></html>';
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockXml) })
      .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve(mockHtml) });

    const kvPut = vi.fn().mockResolvedValue(undefined);
    const existingSeen = Array.from({ length: 250 }, (_, i) => `https://example.com/${i}`);
    const aiRun = vi.fn().mockResolvedValue({ response: 'AI analysis.' });

    const env = {
      'cf-blog-watcher': {
        get: vi.fn().mockResolvedValue(JSON.stringify({ seen: existingSeen })),
        put: kvPut,
      },
      EMAIL: { send: vi.fn().mockResolvedValue(undefined) },
      AI: { run: aiRun },
      FROM_EMAIL: 'no-reply@example.com',
      RECIPIENT: 'you@example.com',
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDigest(env);

    const savedState = JSON.parse(kvPut.mock.calls[0][1]);
    expect(savedState.seen).toHaveLength(200);
    expect(savedState.seen[0]).toBe('https://blog.cloudflare.com/post-1/');

    consoleSpy.mockRestore();
  });
});
