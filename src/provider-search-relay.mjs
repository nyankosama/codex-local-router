import { fail } from "./errors.mjs";
import { relayRequestHeaders, relayResponseHeaders } from "./official-relay.mjs";
import { credential } from "./providers.mjs";
import { providerStandaloneSearchUrl } from "./standalone-search.mjs";
import { requestRaw } from "./transport.mjs";

const identityHeaders = new Set([
  "authorization",
  "branch-id",
  "chatgpt-account-id",
  "cookie",
  "cookie2",
  "openai-beta",
  "originator",
  "session-id",
  "thread-id",
  "turn-id",
  "x-codex-turn-metadata",
]);

export function providerSearchRequestHeaders(headers, key) {
  const output = relayRequestHeaders(headers);
  for (const name of Object.keys(output))
    if (
      identityHeaders.has(name) ||
      name.startsWith("chatgpt-") ||
      name.startsWith("x-codex-") ||
      name.startsWith("x-openai-internal-codex-")
    ) delete output[name];
  output.authorization = `Bearer ${key}`;
  return output;
}

async function write(res, chunk, signal) {
  if (signal?.aborted) throw fail("cancelled", 499);
  if (res.write(chunk)) return;
  await new Promise((resolve, reject) => {
    const done = () => { clean(); resolve(); };
    const closed = () => { clean(); reject(fail("cancelled", 499)); };
    const clean = () => {
      res.off("drain", done);
      res.off("close", closed);
    };
    res.once("drain", done);
    res.once("close", closed);
  });
}

export async function relayProviderSearchHttp({
  req,
  res,
  wire,
  route,
  config,
  signal,
  send = requestRaw,
}) {
  const provider = {
    baseUrl: route.providerBaseUrl,
    standaloneSearch: { endpoint: route.endpoint },
    ...(route.credentialRef ?? {}),
  };
  const key = await credential(provider);
  if (!key) throw fail("provider_credential_missing", 503);
  const destination = providerStandaloneSearchUrl(provider, req.url);
  const upstream = await send(destination, {
    method: req.method,
    headers: providerSearchRequestHeaders(req.headers, key),
    body:
      wire?.length || req.headers["content-length"] || req.headers["transfer-encoding"]
        ? wire
        : undefined,
    signal,
    timeoutMs: config.timeoutMs ?? 180000,
  });
  res.writeHead(upstream.status, relayResponseHeaders(upstream));
  let bytes = 0;
  for await (const chunk of upstream.body) {
    bytes += chunk.length;
    await write(res, chunk, signal);
  }
  res.end();
  return { status: upstream.status, bytes };
}
