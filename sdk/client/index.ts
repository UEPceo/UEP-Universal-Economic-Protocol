/**
 * @uep/client — HTTP caller for the local API. No ledger and no Marketplace.
 */
export type UepAuth = { actorId: string; signature: string; issuedAt?: number };

export class UepClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = baseUrl; }

  async post(path: string, body: unknown, auth?: UepAuth, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    const h: Record<string, string> = { "content-type": "application/json", ...headers };
    if (auth) {
      h["x-uep-actor-id"] = auth.actorId;
      h["x-uep-signature"] = auth.signature;
      if (auth.issuedAt !== undefined) h["x-uep-issued-at"] = String(auth.issuedAt);
    }
    const response = await fetch(this.baseUrl + path, { method: "POST", headers: h, body: JSON.stringify(body) });
    return { status: response.status, json: await response.json() };
  }

  async postBytes(path: string, body: Uint8Array, auth: UepAuth): Promise<{ status: number; json: any }> {
    const response = await fetch(this.baseUrl + path, {
      method: "POST",
      headers: { "content-type": "application/octet-stream", "x-uep-actor-id": auth.actorId, "x-uep-signature": auth.signature },
      body: body as Uint8Array<ArrayBuffer>,
    });
    return { status: response.status, json: await response.json() };
  }
}
