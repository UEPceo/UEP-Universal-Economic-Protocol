/**
 * Test helpers for the category modules (v0.5.3). Test-only: builds a
 * marketplace with a controllable height and signs swap / relay / dispute
 * messages with the testkit identities. Not imported by production code.
 */
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { act, createTestAuthority, enrollIdentity, testCredit } from "../marketplace/testkit.ts";
import { SettlementIndex } from "./settlement-index.ts";
import { SwapCategory, swapHashlock, swapIntentId, type SwapIntentBody } from "./swap.ts";
import { RelayCategory, prepareBlob, relayOrderId, type RelayConfig, type RelayOfferBody } from "./relay.ts";
import { DisputeCategory, disputeIdOf, verdictKindFor, type DisputeConfig, type VerdictBody } from "./dispute.ts";

export const EUR = "uep-test/teur";
export const ENERGY = "uep-test/tenergy";
export const NET = "uep-testnet";

export function harness(start = 1000, opts: { relay?: Partial<RelayConfig>; dispute?: Partial<DisputeConfig>; arbiters?: number; quorum?: number } = {}) {
  let h = start;
  const admin = createTestAuthority("admin");
  const m = new DigitalServicesMarketplace({ adminIdentity: admin.identityId, adminPublicKey: admin.publicKeyHex, height: () => h });
  const index = new SettlementIndex();
  const swap = new SwapCategory(m.issueCategoryEscrowPort("swap"), index);
  const relay = new RelayCategory(m.issueCategoryEscrowPort("relay"), index, NET, opts.relay);
  const arbiterIds: string[] = [];
  for (let i = 0; i < (opts.arbiters ?? 3); i++) arbiterIds.push(enrollIdentity(m, `arb${i}`).identityId);
  const dispute = new DisputeCategory(m.issueCategoryEscrowPort("dispute"), arbiterIds, opts.quorum ?? 2, opts.dispute);
  dispute.attach(swap, swap.issueDisputeCap());
  dispute.attach(relay, relay.issueDisputeCap());
  let nonce = 1;
  const conserved = () => m.valueAccounting(EUR).conserved && m.valueAccounting(ENERGY).conserved;

  function user(id: string, eur = 0n, energy = 0n) {
    const u = enrollIdentity(m, id);
    if (eur > 0n) testCredit(m, u.identityId, EUR, eur);
    if (energy > 0n) testCredit(m, u.identityId, ENERGY, energy);
    return u.identityId;
  }

  function openSwap(buyerId: string, makerId: string, over: Partial<SwapIntentBody> = {}, preimage = `preimage-${nonce}-xxxxxxxxxxxx`) {
    const n = nonce++;
    const intent: SwapIntentBody = {
      version: 1, category: "uep.service.swap.v1", networkId: NET, buyerId, marketMakerId: makerId,
      fromAsset: EUR, fromAmount: 1_000n, toAsset: ENERGY, toAmount: 400n,
      hashlock: swapHashlock(preimage, n, NET), deadline: h + 50_000, orderNonce: n, ...over,
    };
    const intentId = swapIntentId(intent);
    const { ...signed } = intent;
    swap.open(act(m, buyerId, "swap-intent", intentId, signed as unknown as Record<string, unknown>), intent, act(m, makerId, "swap-accept", intentId, { intentId }), { intentId });
    return { intentId, intent, preimage };
  }

  function openRelay(buyerId: string, providerId: string, recipientId: string, opts2: { price?: bigint; bond?: bigint; content?: Buffer; tamper?: (w: Buffer) => void; fraudWindowHeights?: number; keyDeadline?: number } = {}) {
    const n = nonce++;
    const offer: RelayOfferBody = {
      version: 1, category: "uep.service.relay.v1", networkId: NET, buyerId, providerId, recipientId, asset: EUR,
      price: opts2.price ?? 1_000n, minBond: 50n, keyDeadline: opts2.keyDeadline ?? h + 200,
      fraudWindowHeights: opts2.fraudWindowHeights ?? 20, nonce: n,
    };
    const orderId = relayOrderId(offer);
    const k = Buffer.alloc(32, n & 0xff);
    const prepared = prepareBlob(opts2.content ?? Buffer.from(`relay content ${n} `.repeat(200)), k, NET, orderId, opts2.tamper);
    const commit = { orderId, bond: opts2.bond ?? 100n, ...prepared.commitment };
    relay.open(
      act(m, buyerId, "relay-offer", orderId, { ...offer } as unknown as Record<string, unknown>),
      offer,
      act(m, providerId, "relay-commit", orderId, {
        orderId, bond: commit.bond, chunkRoot: commit.chunkRoot, wrapRoot: commit.wrapRoot,
        kCommit: commit.kCommit, contentLen: commit.contentLen, leafCount: commit.leafCount,
      }),
      commit,
    );
    const publish = (key = k.toString("hex")) => relay.publishKey(act(m, providerId, "relay-key", orderId, { orderId, k: key }), orderId, key);
    return { orderId, offer, commit, k, prepared, publish };
  }

  function openDispute(claimantId: string, category: "swap" | "relay", orderId: string, bondAmount: bigint, bondAsset = EUR) {
    const n = nonce++;
    const disputeId = disputeIdOf(category, orderId);
    const body = { category, orderId, bondAsset, bondAmount, nonce: n };
    dispute.open(act(m, claimantId, "dispute-open", disputeId, { ...body }), body);
    return disputeId;
  }

  function verdict(disputeId: string, category: "swap" | "relay", orderId: string, releaseBps: number, frivolous = false): VerdictBody {
    return { disputeId, orderId, category, kind: verdictKindFor(releaseBps), releaseBps, frivolous };
  }

  function sign(arbiterId: string, v: VerdictBody) {
    return { auth: act(m, arbiterId, "dispute-verdict", v.disputeId, { ...v }), body: v };
  }

  return {
    m, admin, index, swap, relay, dispute, arbiterIds, user, openSwap, openRelay, openDispute, verdict, sign, conserved,
    height: () => h, advance: (n: number) => { h += n; },
    bal: (asset: string, id: string) => m.availableBalance(asset, id),
  };
}
