export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
  score?: number;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

type SearchWebOptions = {
  tavilyApiKey?: string;
  fetcher?: FetchLike;
};

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    published_date?: string;
    score?: number;
  }>;
};

const WEB_SEARCH_TIMEOUT_MS = 15_000;
const MAX_WEB_SEARCH_BODY_BYTES = 256 * 1024;

export async function searchWeb(query: string, maxResults: number, options: SearchWebOptions = {}): Promise<WebSearchResult[]> {
  const fetcher = options.fetcher ?? fetch;
  if (options.tavilyApiKey?.trim()) {
    return searchTavily(query, maxResults, options.tavilyApiKey.trim(), fetcher);
  }

  return searchBingRss(query, maxResults, fetcher);
}

async function searchTavily(query: string, maxResults: number, apiKey: string, fetcher: FetchLike) {
  const response = await fetchWithTimeout(fetcher, "https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "arivu/0.1 web_search"
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: maxResults,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
      include_usage: true
    })
  });

  if (!response.ok) {
    const body = await readBoundedResponseText(response);
    throw new Error(`Tavily search request failed (${response.status}): ${body}`);
  }

  const json = JSON.parse(await readBoundedResponseText(response)) as TavilySearchResponse;
  return (json.results ?? [])
    .map((result) => ({
      title: result.title?.trim() ?? "",
      url: result.url?.trim() ?? "",
      snippet: result.content?.trim() ?? "",
      publishedAt: result.published_date?.trim() || undefined,
      score: result.score
    }))
    .filter((result) => result.title && result.url)
    .slice(0, maxResults);
}

async function searchBingRss(query: string, maxResults: number, fetcher: FetchLike) {
  const newsLike = isNewsLikeQuery(query);
  const searchQuery = newsLike ? normalizeNewsQuery(query) : query;
  const url = new URL(newsLike ? "https://www.bing.com/news/search" : "https://www.bing.com/search");
  url.searchParams.set("q", searchQuery);
  url.searchParams.set("format", "rss");

  const response = await fetchWithTimeout(fetcher, url.toString(), {
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml",
      "User-Agent": "arivu/0.1 web_search"
    }
  });

  if (!response.ok) {
    throw new Error(`Search request failed (${response.status}).`);
  }

  const body = await readBoundedResponseText(response);
  return parseBingRssResults(body).slice(0, maxResults);
}

export function formatWebSearchResults(query: string, results: WebSearchResult[]) {
  if (results.length === 0) {
    return `No web results found for "${query}".`;
  }

  return results
    .map((result, index) => {
      return [
        `${index + 1}. ${result.title}`,
        `url: ${result.url}`,
        result.publishedAt ? `published: ${result.publishedAt}` : "",
        result.snippet ? `snippet: ${result.snippet}` : ""
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
}

export function parseBingRssResults(xml: string): WebSearchResult[] {
  return Array.from(xml.matchAll(/<item>([\s\S]*?)<\/item>/g))
    .map((match) => {
      const item = match[1] ?? "";
      return {
        title: cleanXmlText(readTag(item, "title")),
        url: normalizeBingResultUrl(cleanXmlText(readTag(item, "link"))),
        snippet: cleanXmlText(readTag(item, "description")),
        publishedAt: cleanXmlText(readTag(item, "pubDate")) || undefined
      };
    })
    .filter((result) => result.title && result.url);
}

function readTag(xml: string, tag: string) {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match?.[1] ?? "";
}

async function fetchWithTimeout(fetcher: FetchLike, input: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
  try {
    return await fetcher(input, {
      ...init,
      signal: init.signal ?? controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponseText(response: Response, maxBytes = MAX_WEB_SEARCH_BODY_BYTES) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[truncated]` : text;
  }

  const decoder = new TextDecoder();
  let output = "";
  let bytesRead = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const remaining = maxBytes - bytesRead;
    if (value.byteLength > remaining) {
      if (remaining > 0) {
        output += decoder.decode(value.slice(0, remaining), { stream: true });
      }
      await reader.cancel();
      output += decoder.decode();
      return `${output}\n[truncated]`;
    }
    bytesRead += value.byteLength;
    output += decoder.decode(value, { stream: true });
  }

  output += decoder.decode();
  return output;
}

function cleanXmlText(value: string) {
  const withoutCdata = value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  return stripTags(decodeXmlEntities(withoutCdata)).replace(/\s+/g, " ").trim();
}

function stripTags(value: string) {
  return value.replace(/<[^>]*>/g, "");
}

function decodeXmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\""
  };

  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }
    return named[body] ?? entity;
  });
}

function isNewsLikeQuery(query: string) {
  return /\b(breaking|current|latest|news|recent|today|update|updates)\b/i.test(query);
}

function normalizeNewsQuery(query: string, now = new Date()) {
  const currentYear = String(now.getUTCFullYear());
  if (query.includes(currentYear)) {
    return query;
  }

  const currentMonth = now.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const monthPattern = "\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+20\\d{2}\\b";
  const withFreshMonth = query.replace(new RegExp(monthPattern, "gi"), `${currentMonth} ${currentYear}`);
  const withFreshYear = withFreshMonth.replace(/\b20\d{2}\b/g, currentYear);
  return withFreshYear.includes(currentYear) ? withFreshYear : `${withFreshYear} ${currentMonth} ${currentYear}`;
}

function normalizeBingResultUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.endsWith("bing.com") && parsed.pathname.includes("/news/apiclick")) {
      return parsed.searchParams.get("url") ?? rawUrl;
    }
  } catch {
    return rawUrl;
  }
  return rawUrl;
}
