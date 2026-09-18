import { randomUUID } from "node:crypto";
import { request, requestRaw, readJSON } from "./transport.mjs";
import {
  officialRelayUrl,
  relayRequestHeaders,
} from "./official-relay.mjs";
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
  constructor(message, code = "web_search_error", status = 503) {
    super(message);
    this.code = code;
    this.status = status;
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

const allowedHost = (url, domains) => {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!["http:", "https:"].includes(parsed.protocol)) return false;
  if (!domains.length) return true;
  const hostname = parsed.hostname.toLowerCase();
  return domains.some(
    (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
  );
};

export class SubscriptionWebSearchAdapter {
  constructor({
    headers,
    model,
    requestShape,
    timeoutMs = 30000,
    fetchImpl = requestRaw,
  } = {}) {
    this.headers = headers ?? {};
    this.model = model;
    this.requestShape = requestShape;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }
  async search({ query, numResults = 5, signal }) {
    if (!this.requestShape?.mode)
      throw new WebSearchError(
        "Codex search mode is not observable on this request",
        "subscription_search_mode_unresolved",
      );
    if (typeof query !== "string" || !query.trim())
      throw new WebSearchError("query is required", "invalid_arguments");
    const body = Buffer.from(JSON.stringify({
      id: `search_${randomUUID()}`,
      model: this.model,
      input: [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: query.trim() }],
      }],
      commands: {
        search_query: [{ q: query.trim() }],
        response_length: "short",
      },
      max_output_tokens: 10000,
      settings: {
        allowed_callers: ["direct"],
        external_web_access: this.requestShape.mode === "live",
        ...(this.requestShape.allowedDomains.length
          ? { allowed_domains: this.requestShape.allowedDomains }
          : {}),
      },
    }));
    const headers = relayRequestHeaders(this.headers);
    delete headers["content-length"];
    delete headers["content-encoding"];
    for (const name of ["x-api-key", "api-key", "x-goog-api-key", "x-provider-key"])
      delete headers[name];
    headers["content-type"] = "application/json";
    headers.accept = "application/json";
    let response;
    try {
      response = await this.fetch(
        officialRelayUrl("/subscription/v1/alpha/search", "POST"),
        {
          method: "POST",
          headers,
          body,
          signal,
          timeoutMs: this.timeoutMs,
        },
      );
    } catch (error) {
      if (error?.type === "cancelled") throw error;
      throw new WebSearchError(
        "subscription search transport failed",
        error?.type === "upstream_timeout"
          ? "subscription_search_timeout"
          : "subscription_search_transport_error",
        error?.type === "upstream_timeout" ? 504 : 502,
      );
    }
    if (!response.ok) {
      response.body?.destroy?.();
      throw new WebSearchError(
        `subscription search returned ${response.status}`,
        response.status === 401 || response.status === 403
          ? "subscription_search_auth_failed"
          : response.status === 429
            ? "subscription_search_rate_limited"
            : "subscription_search_upstream_error",
        response.status === 401 || response.status === 403
          ? 401
          : response.status === 429
            ? 429
            : 502,
      );
    }
    let data;
    try { data = await readJSON(response); } catch {
      throw new WebSearchError(
        "subscription search response was invalid",
        "subscription_search_protocol_error",
        502,
      );
    }
    const results = (Array.isArray(data.results) ? data.results : [])
      .filter((item) => typeof item?.url === "string" && item.url.length <= 2048)
      .filter((item) => allowedHost(item.url, this.requestShape.allowedDomains))
      .slice(0, numResults)
      .map((item) => ({
        title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
        url: item.url,
        snippet:
          typeof item.snippet === "string"
            ? item.snippet.slice(0, 4000)
            : typeof item.text === "string"
              ? item.text.slice(0, 4000)
              : "",
        ...(typeof item.ref_id === "string" ? { refId: item.ref_id } : {}),
      }));
    if (!results.length)
      throw new WebSearchError(
        "subscription search returned no usable results",
        "subscription_search_empty",
        502,
      );
    return { query, results };
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
