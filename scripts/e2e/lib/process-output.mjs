export function parseNodeTestSummary(output) {
  const count = (label) =>
    output.match(new RegExp(`(?:^|\\n)(?:#|ℹ)\\s+${label}\\s+(\\d+)`, "m"))?.[1];
  return {
    total: count("tests"),
    passed: count("pass"),
    failed: count("fail"),
  };
}
