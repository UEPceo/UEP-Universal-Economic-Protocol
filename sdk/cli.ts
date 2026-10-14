/**
 * Developer CLI. Talks to a running local node. Does not import the ledger.
 * `node --experimental-strip-types sdk/cli.ts height --url http://127.0.0.1:8787`
 */
import { UepClient } from "./client/index.ts";

export async function runDeveloperCli(argv: string[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const urlFlag = argv.indexOf("--url");
  const baseUrl = urlFlag >= 0 ? argv[urlFlag + 1] : "http://127.0.0.1:8787";
  if (!baseUrl) throw new Error("CLI_URL_REQUIRED");
  const command = argv.find((arg) => !arg.startsWith("--"));
  const client = new UepClient(baseUrl);
  if (command === "height") {
    const response = await fetchImpl(baseUrl + "/v1/marketplace/height");
    const body = await response.json() as { data?: { height?: number } };
    return `height=${body.data?.height}`;
  }
  if (command === "listings") {
    const response = await fetchImpl(baseUrl + "/v1/marketplace/listings");
    const body = await response.json() as { data?: unknown[] };
    return `listings=${Array.isArray(body.data) ? body.data.length : 0}`;
  }
  void client;
  throw new Error("CLI_COMMAND: height | listings");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await runDeveloperCli(process.argv.slice(2)));
}
