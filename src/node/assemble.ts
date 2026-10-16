/**
 * Reference node. One process: UEP-25 ledger, height producer, Marketplace,
 * value bridge, submit queue, serializer, and the lab HTTP API.
 * Not a second economy. UEP-37 is not imported.
 */
import { generateEd25519KeyPair } from "../core/ed25519.ts";
import { randomBytes } from "node:crypto";
import { SPEND_CIRCUIT_TAG } from "../core/spend-circuit-freeze.ts";
import { poseidonBackendName } from "../core/poseidon-wasm.ts";
import { createMarketplaceIdentity } from "../marketplace/identity.ts";
import { DigitalServicesMarketplace } from "../marketplace/marketplace.ts";
import { TESTNET } from "../network/profiles.ts";
import { HeightProducer } from "../service/height-producer.ts";
import { LedgerSubmitQueue } from "../service/ledger-submit-queue.ts";
import { MemoryStorageProvider } from "../service/memory-storage.ts";
import { CategoryRelayAdapter, ContentHashCompute, PolicyOracleAdapter } from "../service/module-adapters.ts";
import { listenUepHttpApi } from "../service/uep-http-api.ts";
import { UepServiceApi } from "../service/uep-service-api.ts";
import { ValueBridge } from "../settlement/value-bridge.ts";
import { DisputeCategory } from "../category/dispute.ts";
import { DripController } from "../category/drip.ts";
import { RelayCategory } from "../category/relay.ts";
import { SettlementIndex } from "../category/settlement-index.ts";
import { SwapCategory } from "../category/swap.ts";
import { SpendSerializer } from "../testnet/spend-serializer.ts";
import { UepLedger } from "../testnet/ledger.ts";
import type { IdentitySecrets } from "../identity/kdf.ts";
import type { Server } from "node:http";
import type { AssetRegistry } from "../core/asset-registry.ts";
import { assertRegistryPolicy, type NetworkRegistryPolicy } from "./asset-registry-store.ts";

export type AssembledNode = {
  ledger: UepLedger;
  marketplace: DigitalServicesMarketplace;
  bridge: ValueBridge;
  producer: HeightProducer;
  queue: LedgerSubmitQueue;
  serializer: SpendSerializer;
  api: UepServiceApi;
  relay: CategoryRelayAdapter;
  oracle: PolicyOracleAdapter;
  attachedCategories: string[];
  categories: { swap: SwapCategory; relay: RelayCategory; dispute: DisputeCategory; drip: DripController };
  arbiter: ReturnType<typeof createMarketplaceIdentity>;
  circuitTag: string;
  poseidon: string;
  admin: ReturnType<typeof createMarketplaceIdentity>;
  listen: (port?: number) => Promise<{ server: Server; port: number }>;
};

/** A fresh reference-node ledger. `assembleNode` uses it when no ledger is given; `cli.ts` uses it so peers can catch up before the node is assembled. */
export function newNodeLedger(input: {
  snapshotKey: ReturnType<typeof generateEd25519KeyPair>;
  faucetKey: ReturnType<typeof generateEd25519KeyPair>;
  noteBlindingDomain?: bigint;
  /** 0.5.83 Block D: governance-verified asset registry the ledger enforces (and binds in every snapshot). */
  assetRegistry?: AssetRegistry;
}): UepLedger {
  return new UepLedger({
    networkId: TESTNET.networkId,
    domainId: "EARTH",
    connected: true,
    allowFaucet: true,
    snapshotSigningKeys: [input.snapshotKey.privateKey],
    faucetSigningKey: input.faucetKey.privateKey,
    noteBlindingDomain: input.noteBlindingDomain ?? BigInt("0x" + randomBytes(16).toString("hex")),
    ...(input.assetRegistry ? { assetRegistry: input.assetRegistry } : {}),
  });
}

export function assembleNode(input: {
  custody: IdentitySecrets;
  feeAccount: IdentitySecrets;
  adminId?: string;
  snapshotKey?: ReturnType<typeof generateEd25519KeyPair>;
  faucetKey?: ReturnType<typeof generateEd25519KeyPair>;
  noteBlindingDomain?: bigint;
  ledger?: UepLedger;
  marketplaceSnapshot?: unknown;
  /** 0.5.83 Block D: network registry policy. With requireAssetRegistry the node refuses to start without a valid registry. */
  registryPolicy?: NetworkRegistryPolicy;
  assetRegistry?: AssetRegistry;
}): AssembledNode {
  if (poseidonBackendName() !== "uep-poseidon-bn254-x5-3-v1") {
    throw new Error("POSEIDON_BACKEND: the node boots on the JS constants; WASM is optional and must match them");
  }
  const snapshotKey = input.snapshotKey ?? generateEd25519KeyPair();
  const faucetKey = input.faucetKey ?? generateEd25519KeyPair();
  const ledger = input.ledger ?? newNodeLedger({ snapshotKey, faucetKey, noteBlindingDomain: input.noteBlindingDomain, assetRegistry: input.assetRegistry });
  // 0.5.83 Block D: refuse to operate without the registry when the network policy requires it.
  if (input.registryPolicy) assertRegistryPolicy(input.registryPolicy, ledger.assetRegistry, ledger.networkId, ledger.height);
  const admin = createMarketplaceIdentity(input.adminId ?? "uep-node-admin");
  const marketplace = new DigitalServicesMarketplace({
    adminIdentity: admin.identityId,
    adminPublicKey: admin.publicKeyHex,
    adminAuthorizer: (id) => id === admin.identityId,
    ledgerNetworkId: ledger.networkId,
    height: () => ledger.height,
    snapshotSigningKeys: [snapshotKey.privateKey],
  });
  ledger.setSettlementAnchorAuthority(marketplace.marketplaceId, [marketplace.anchorPublicKeyHex()]);
  const bridge = new ValueBridge(ledger, marketplace, input.custody, input.feeAccount, admin);
  const producer = new HeightProducer({ ledger });
  const serializer = new SpendSerializer();
  const queue = new LedgerSubmitQueue({ submit: (tx) => serializer.run(() => ledger.submit(tx)) });
  const relay = new CategoryRelayAdapter(() => ledger.height);
  const oracle = new PolicyOracleAdapter(() => ledger.height);
  if (input.marketplaceSnapshot) marketplace.restoreSnapshot(input.marketplaceSnapshot as never, { snapshotPublicKeys: [snapshotKey.publicKeyHex] });
  const arbiter = createMarketplaceIdentity("uep-node-arbiter");
  if (!marketplace.isIdentityRegistered(arbiter.identityId)) marketplace.registerIdentity(arbiter.identityId, arbiter.publicKeyHex);
  const index = new SettlementIndex();
  const categories = {
    swap: new SwapCategory(marketplace.issueCategoryEscrowPort("swap"), index, ledger.networkId),
    relay: new RelayCategory(marketplace.issueCategoryEscrowPort("relay"), index, ledger.networkId),
    dispute: new DisputeCategory(marketplace.issueCategoryEscrowPort("dispute"), [arbiter.identityId], 1),
    drip: new DripController(marketplace.issueSubsidyPort(), index),
  };
  const api = new UepServiceApi({
    storageProviders: new Map([["memory", new MemoryStorageProvider()]]),
    marketplace,
    bridge,
    attachedCategories: ["swap", "relay", "dispute", "drip"],
    relay,
    oracle,
    compute: new ContentHashCompute(),
  });
  return {
    ledger,
    marketplace,
    bridge,
    attachedCategories: ["swap", "relay", "dispute", "drip"],
    producer,
    queue,
    serializer,
    api,
    relay,
    oracle,
    categories,
    arbiter,
    circuitTag: SPEND_CIRCUIT_TAG,
    poseidon: poseidonBackendName(),
    admin,
    listen: (port = 0) => listenUepHttpApi({ api, host: "127.0.0.1", port, ledgerQueue: queue, heightProducer: producer, economic: {
      tip: () => ({ stateRoot: ledger.stateRoot().toHex(), height: ledger.height }),
      balance: (id) => marketplace.availableBalance("uep-test/teur", id).toString(),
    } }),
  };
}
