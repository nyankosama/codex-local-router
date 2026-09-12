# Security policy

Please report vulnerabilities through GitHub's private vulnerability reporting for this repository. Do not open a public issue containing credentials, authentication material, private conversation content, encrypted state, or an exploitable proof of concept.

The supported security boundary is macOS, loopback-only listening, a local API token for raw API access, ChatGPT subscription authentication only on the subscription route, and separate credentials for custom providers. Logs are designed to exclude request bodies, images, credentials, and encrypted model state.

The project does not protect against a malicious process already running as the same macOS user. Review third-party provider data policies before routing conversation content to them.
