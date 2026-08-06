import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker, { parseFeed, clean, renderDigest, loadState, saveState, runDigest } from '../src/worker.js';

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
    };

    await expect(runDigest(env)).rejects.toThrow('Feed fetch failed: 503');
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
    };

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runDigest(env);

    const savedState = JSON.parse(kvPut.mock.calls[0][1]);
    expect(savedState.seen).toHaveLength(200);
    expect(savedState.seen[0]).toBe('https://blog.cloudflare.com/post-1/');

    consoleSpy.mockRestore();
  });
});
