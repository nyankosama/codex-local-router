import { fail } from "./errors.mjs";
export async function* sseEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  function parse(block) {
    const data = block
      .split(/\r?\n/)
      .filter((x) => x.startsWith("data:"))
      .map((x) => x.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") return;
    try {
      return JSON.parse(data);
    } catch {
      throw fail("invalid_upstream_event", 502);
    }
  }
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (Buffer.byteLength(buffer) > 20 * 1024 * 1024)
      throw fail("upstream_event_too_large", 502);
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const event = parse(buffer.slice(0, match.index));
      buffer = buffer.slice(match.index + match[0].length);
      if (event) yield event;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    const event = parse(buffer);
    if (event) yield event;
  }
}
export async function readSSE(body, onEvent) {
  for await (const event of sseEvents(body)) await onEvent(event);
}
