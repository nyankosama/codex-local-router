# Third-party OpenAI search candidate report

Date: 2026-09-13  
Live-tested candidate: the final committed candidate (the exact commit is recorded by the acceptance runner)
Overall verdict: **PASS for the isolated CLI/App protocol gate**

## Resolved protocol boundary

The first successful-generation probe exposed an important distinction. With `use_responses_lite: false`, Codex sent a top-level hosted `web_search` tool to ai.feei. ai.feei completed that tool inside its own Responses request, so no request reached the user's Codex subscription `/alpha/search` endpoint. A completed client search item alone was therefore insufficient evidence of the selected search source.

Current Codex standalone search is exposed through the Responses Lite `input[].additional_tools` carrier as the `web.run` namespace. The ai.feei presets now use Responses Lite. The model call still goes to ai.feei, while Codex invokes the Gateway's `/subscription/v1/alpha/search`; the frozen search-route lease then sends that request to the selected subscription or Provider endpoint. For a target that does not declare native hosted search, a top-level hosted-search carrier is rejected with `standalone_search_protocol_mismatch` when a standalone source is selected, preventing a silent source change.

Runtime configuration remains schema 3, configuration spaces remain schema 1, and integration state remains schema 4. The generic CLI defaults an App-enabled `openai-gpt` target to Responses Lite when standalone search is active; an explicit incompatible `--no-responses-lite` configuration is rejected.

## Live acceptance

Driver: App-bundled `codex-cli 0.154.0-alpha.6.2`, SHA-256 `ecad78dbf98adb89ec475edac86630406cbe59d9f3070b17d88065f136b94bcb`.

The final isolated run completed both planned turns with four model generations and two standalone searches, no blocked requests, no automatic retry, and no reconnect:

| Case | Client | Search | Generation | Result continuation | Source | Verdict |
|---|---|---|---|---|---|---|
| ai.feei Sol, cached-default | CLI completed | 1 successful request to `chatgpt.com` | 2 successful requests to `ai.feei.cn` | Search-result fingerprint matched the second generation | Present | PASS |
| ai.feei Astra, live | App protocol completed | 1 successful request to `chatgpt.com` | 2 successful requests to `ai.feei.cn` | Search-result fingerprint matched the second generation | Present | PASS |

Both first-generation payloads contained the Responses Lite additional-tool carrier and the `web.run` namespace, with no top-level hosted `web_search`. Every official search request carried only the subscription credential; every ai.feei generation carried only the Provider credential. Search responses were observed in memory only as hashes and counts, and at least one result fingerprint from each response appeared in the corresponding continuation request.

Earlier failed probes are retained as diagnostic history rather than overwritten: the original standard-Responses shape performed hosted search on the third-party leg; a later two-case run proved the correct split but exhausted the old six-generation/four-search harness budget during Astra. The final harness remains bounded at two turns, twelve generations, and eight search requests so normal search/open/read phases can complete while loops still fail closed.

## Installed-environment isolation

The test used a temporary Router home, Codex home, encrypted state/archive, workspace, random port, and generated catalog. It did not install or activate the candidate. The real Codex runtime configuration hash remained unchanged, both Router LaunchAgents remained unloaded, and port 8788 remained closed. The App may refresh its own real model cache while running; that file is read-only to the harness and is not used as an unchanged-environment assertion.

App-server evidence is not an App UI sign-off. The acceptance run did not install or activate the candidate; release publication does not replace an installed-environment or UI check.
