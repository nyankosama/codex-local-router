import { request, readJSON } from "./transport.mjs";
const searchFetch = async (url, options) => {
  const r = await request(url, {
    headers: options.headers,
    body: JSON.parse(options.body),
    signal: options.signal,
    timeoutMs: 30000,
  });
  if (!r.ok) {
    r.body.destroy();
    return { ok: false, status: r.status };
  }
  return { ok: true, status: r.status, json: () => readJSON(r) };
};
export class WebSearchError extends Error {
  constructor(message, code = "web_search_error") {
    super(message);
    this.code = code;
  }
}
const extractedPage = (url, raw, maxCharacters) => {
  if (typeof raw !== "string" || !raw.trim())
    throw new WebSearchError(
      "page extraction returned no content",
      "empty_content",
    );
  const content = raw.slice(0, maxCharacters);
  return {
    url,
    content,
    characters: content.length,
    truncated: raw.length > content.length,
  };
};
export class FakeWebSearchAdapter {
  constructor(
    results = [
      {
        title: "Example result",
        url: "https://example.com",
        snippet: "Fake search result",
      },
    ],
    pages = {},
  ) {
    this.results = results;
    this.pages = pages;
  }
  async search({ query }) {
    if (!query)
      throw new WebSearchError("query is required", "invalid_arguments");
    return { query, results: this.results };
  }
  async fetchPage({ url, maxCharacters = 20000 }) {
    return extractedPage(
      url,
      this.pages[url] ?? `Extracted content from ${url}`,
      maxCharacters,
    );
  }
}
export class ExaWebSearchAdapter {
  constructor({
    apiKey = process.env.EXA_API_KEY,
    baseUrl = "https://api.exa.ai/search",
    contentsUrl = "https://api.exa.ai/contents",
    fetchImpl = searchFetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.contentsUrl = contentsUrl;
    this.fetch = fetchImpl;
  }
  async search({ query, numResults = 5, signal }) {
    if (!this.apiKey)
      throw new WebSearchError(
        "EXA_API_KEY is not configured",
        "not_configured",
      );
    if (!query)
      throw new WebSearchError("query is required", "invalid_arguments");
    const r = await this.fetch(this.baseUrl, {
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        query,
        numResults,
        contents: { highlights: { maxCharacters: 1000 } },
      }),
    });
    if (!r.ok)
      throw new WebSearchError(
        `search backend returned ${r.status}`,
        "backend_error",
      );
    const data = await r.json();
    return {
      query,
      results: (data.results ?? []).map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        snippet: x.highlight ?? x.text ?? "",
      })),
    };
  }
  async fetchPage({ url, maxCharacters = 20000, signal }) {
    if (!this.apiKey)
      throw new WebSearchError(
        "EXA_API_KEY is not configured",
        "not_configured",
      );
    const r = await this.fetch(this.contentsUrl, {
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
      },
      body: JSON.stringify({ urls: [url], text: true }),
    });
    if (!r.ok)
      throw new WebSearchError(
        `contents backend returned ${r.status}`,
        "backend_error",
      );
    const data = await r.json();
    const result =
      (data.results ?? []).find((x) => x.url === url) ?? data.results?.[0];
    return extractedPage(result?.url ?? url, result?.text, maxCharacters);
  }
}
export class TavilyWebSearchAdapter {
  constructor({
    apiKey = process.env.TAVILY_API_KEY,
    baseUrl = "https://api.tavily.com/search",
    extractUrl = "https://api.tavily.com/extract",
    fetchImpl = searchFetch,
  } = {}) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.extractUrl = extractUrl;
    this.fetch = fetchImpl;
  }
  async search({ query, numResults = 5, signal }) {
    if (!this.apiKey)
      throw new WebSearchError(
        "TAVILY_API_KEY is not configured",
        "not_configured",
      );
    if (!query)
      throw new WebSearchError("query is required", "invalid_arguments");
    const r = await this.fetch(this.baseUrl, {
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: numResults,
        search_depth: "basic",
        include_answer: false,
      }),
    });
    if (!r.ok)
      throw new WebSearchError(
        `search backend returned ${r.status}`,
        "backend_error",
      );
    const data = await r.json();
    return {
      query,
      results: (data.results ?? []).map((x) => ({
        title: x.title ?? "",
        url: x.url ?? "",
        snippet: x.content ?? "",
      })),
    };
  }
  async fetchPage({
    url,
    query,
    maxCharacters = 20000,
    signal,
  }) {
    if (!this.apiKey)
      throw new WebSearchError(
        "TAVILY_API_KEY is not configured",
        "not_configured",
      );
    const requestBody = {
      urls: url,
      extract_depth: "basic",
      format: "markdown",
      include_images: false,
    };
    if (query?.trim()) {
      requestBody.query = query.trim();
      requestBody.chunks_per_source = 5;
    }
    const r = await this.fetch(this.extractUrl, {
      method: "POST",
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
        : AbortSignal.timeout(30000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });
    if (!r.ok)
      throw new WebSearchError(
        `extract backend returned ${r.status}`,
        "backend_error",
      );
    const data = await r.json();
    const result =
      (data.results ?? []).find((x) => x.url === url) ?? data.results?.[0];
    return extractedPage(
      result?.url ?? url,
      result?.raw_content,
      maxCharacters,
    );
  }
}
