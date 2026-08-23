export const WEB_SEARCH_PROVIDER_KINDS = ["tavily", "brave", "exa", "serper", "bing"] as const;

export type WebSearchProviderKind = (typeof WEB_SEARCH_PROVIDER_KINDS)[number];

export type WebSearchProviderProfile = {
  id: string;
  name: string;
  kind: WebSearchProviderKind;
  /**
   * Exact search endpoint. Keeping this editable lets users route a supported
   * provider protocol through a compatible gateway without adding a new kind.
   */
  baseUrl: string;
  apiKey?: string;
};

export type WebSearchProviderPreset = Omit<WebSearchProviderProfile, "id" | "apiKey">;

export const WEB_SEARCH_PROVIDER_PRESETS: Record<WebSearchProviderKind, WebSearchProviderPreset> = {
  tavily: {
    name: "Tavily",
    kind: "tavily",
    baseUrl: "https://api.tavily.com/search"
  },
  brave: {
    name: "Brave Search",
    kind: "brave",
    baseUrl: "https://api.search.brave.com/res/v1/web/search"
  },
  exa: {
    name: "Exa",
    kind: "exa",
    baseUrl: "https://api.exa.ai/search"
  },
  serper: {
    name: "Serper",
    kind: "serper",
    baseUrl: "https://google.serper.dev/search"
  },
  bing: {
    name: "Bing RSS",
    kind: "bing",
    baseUrl: "https://www.bing.com/search"
  }
};

export function defaultWebSearchProvider(kind: WebSearchProviderKind, id: string = kind): WebSearchProviderProfile {
  return {
    id,
    ...WEB_SEARCH_PROVIDER_PRESETS[kind]
  };
}

export function webSearchProviderRequiresApiKey(kind: WebSearchProviderKind) {
  return kind !== "bing";
}

export function webSearchProviderLabel(kind: WebSearchProviderKind) {
  return WEB_SEARCH_PROVIDER_PRESETS[kind].name;
}
