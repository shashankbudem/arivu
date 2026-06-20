import { describe, expect, it } from "vitest";
import { formatWebSearchResults, parseBingRssResults, searchWeb } from "../src/tools/webSearch.js";

const RSS_FIXTURE = `<?xml version="1.0" encoding="utf-8" ?>
<rss version="2.0">
  <channel>
    <item>
      <title>Example &amp; Result</title>
      <link>https://example.com/</link>
      <description>Short &lt;b&gt;snippet&lt;/b&gt; here.</description>
      <pubDate>Fri, 05 Jun 2026 02:14:00 GMT</pubDate>
    </item>
    <item>
      <title><![CDATA[Second Result]]></title>
      <link>https://example.org/page</link>
      <description><![CDATA[Another snippet.]]></description>
    </item>
  </channel>
</rss>`;

describe("web search helpers", () => {
  it("parses RSS search results", () => {
    expect(parseBingRssResults(RSS_FIXTURE)).toEqual([
      {
        title: "Example & Result",
        url: "https://example.com/",
        snippet: "Short snippet here.",
        publishedAt: "Fri, 05 Jun 2026 02:14:00 GMT"
      },
      {
        title: "Second Result",
        url: "https://example.org/page",
        snippet: "Another snippet.",
        publishedAt: undefined
      }
    ]);
  });

  it("decodes Bing News redirect links", () => {
    const rss = `<?xml version="1.0" encoding="utf-8" ?>
    <rss version="2.0">
      <channel>
        <item>
          <title>News Result</title>
          <link>https://www.bing.com/news/apiclick.aspx?url=https%3A%2F%2Fexample.com%2Farticle</link>
          <description>Snippet.</description>
        </item>
      </channel>
    </rss>`;

    expect(parseBingRssResults(rss)[0]?.url).toBe("https://example.com/article");
  });

  it("formats compact tool output", () => {
    const output = formatWebSearchResults("example", parseBingRssResults(RSS_FIXTURE).slice(0, 1));

    expect(output).toContain("1. Example & Result");
    expect(output).toContain("url: https://example.com/");
    expect(output).toContain("snippet: Short snippet here.");
  });

  it("searches with the expected RSS endpoint", async () => {
    const calls: string[] = [];
    const results = await searchWeb(
      "hello world",
      1,
      {
        async fetcher(input) {
          calls.push(input);
          return new Response(RSS_FIXTURE, { status: 200 });
        }
      }
    );

    expect(calls[0]).toContain("www.bing.com/search");
    expect(calls[0]).toContain("format=rss");
    expect(results).toHaveLength(1);
  });

  it("uses the news RSS endpoint for news-like fallback queries", async () => {
    const calls: string[] = [];
    const results = await searchWeb("Indian cricket team latest news", 1, {
      async fetcher(input) {
        calls.push(input);
        return new Response(RSS_FIXTURE, { status: 200 });
      }
    });

    expect(calls[0]).toContain("www.bing.com/news/search");
    expect(calls[0]).toContain("format=rss");
    expect(results).toHaveLength(1);
  });

  it("refreshes stale generated years in news-like fallback queries", async () => {
    const currentYear = new Date().getUTCFullYear();
    const staleYear = currentYear - 1;
    const calls: string[] = [];
    await searchWeb(`Indian cricket team latest news August ${staleYear}`, 1, {
      async fetcher(input) {
        calls.push(input);
        return new Response(RSS_FIXTURE, { status: 200 });
      }
    });

    const calledUrl = decodeURIComponent(calls[0] ?? "");
    expect(calledUrl).toContain(String(currentYear));
    expect(calledUrl).not.toContain(String(staleYear));
  });

  it("uses Tavily when an API key is configured", async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    const results = await searchWeb("hello world", 2, {
      tavilyApiKey: "tvly-test",
      async fetcher(input, init) {
        calls.push({ input, init });
        return Response.json({
          results: [
            {
              title: "Tavily Result",
              url: "https://example.com/tavily",
              content: "Agent-friendly search result.",
              score: 0.92
            }
          ]
        });
      }
    });

    expect(calls[0]?.input).toBe("https://api.tavily.com/search");
    expect(calls[0]?.init?.method).toBe("POST");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer tvly-test");
    expect(results).toEqual([
      {
        title: "Tavily Result",
        url: "https://example.com/tavily",
        snippet: "Agent-friendly search result.",
        publishedAt: undefined,
        score: 0.92
      }
    ]);
  });
});
