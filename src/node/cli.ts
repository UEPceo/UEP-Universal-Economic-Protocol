/**
 * `npm start` — local reference node. No consensus. Binds 127.0.0.1.
 * UEP_DATA_DIR persists keys and the last signed snapshots so a restart reopens the same ledger.
 */
import { HeightFloor } from "./height-floor.ts";
import { chmodSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { generateEd25519KeyPair, publicKeyHexOf } from "../core/ed25519.ts";
import { generateMnemonic, identityFromMnemonic } from "../identity/index.ts";
import { UepLedger } from "../testnet/ledger.ts";
import { assembleNode, newNodeLedger } from "./assemble.ts";
import { AssetRegistryStore, assertRegistryPolicy, type NetworkRegistryPolicy } from "./asset-registry-store.ts";
import { clusterTrust } from "./cluster-trust.ts";
import { PeerNet, type Peer } from "./peer-net.ts";

const dir = process.env.UEP_DATA_DIR;

function writeSecret(path: string, value: string): void {
  writeFileSync(path, value, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* mode is best-effort */ }
}

async function storedMnemonic(name: string): Promise<string> {
  if (!dir) return generateMnemonic(128);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const mnemonic = await generateMnemonic(128);
  writeSecret(path, mnemonic);
  return mnemonic;
}

function storedKey(name: string) {
  if (!dir) return generateEd25519KeyPair();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  if (existsSync(path)) {
    const privateKey = createPrivateKey(readFileSync(path, "utf8"));
    return { privateKey, publicKey: createPublicKey(privateKey), publicKeyHex: publicKeyHexOf(privateKey) };
  }
  const pair = generateKeyPairSync("ed25519");
  writeSecret(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyHex: publicKeyHexOf(pair.publicKey) };
}

function storedDomain(): bigint | undefined {
  if (!dir) return undefined;
  const path = join(dir, "blinding.domain");
  if (existsSync(path)) return BigInt(readFileSync(path, "utf8").trim());
  const domain = BigInt("0x" + randomBytes(16).toString("hex"));
  writeSecret(path, domain.toString());
  return domain;
}

const reviveBigInt = (_k: string, v: unknown) => v && typeof v === "object" && typeof (v as { $b?: unknown }).$b === "string" ? BigInt((v as { $b: string }).$b) : v;

const custody = await identityFromMnemonic(await storedMnemonic("custody.mnemonic"));
const feeAccount = await identityFromMnemonic(await storedMnemonic("fee.mnemonic"));
const snapshotKey = storedKey("snapshot.pem");
const faucetKey = storedKey("faucet.pem");
const blindingDomain = storedDomain();

// Peer list first: the trust used to restore a snapshot from disk or from a peer comes from it.
const peersFile = process.env.UEP_PEERS;
const nodeId = process.env.UEP_NODE_ID;
const list = peersFile && nodeId ? JSON.parse(readFileSync(peersFile, "utf8")) as { threshold?: number; peers: Peer[] } : undefined;
const me = list?.peers.find((peer) => peer.id === nodeId);
if (list && !me) throw new Error("PEER_UNKNOWN");
const others = list ? list.peers.filter((peer) => peer.id !== nodeId) : [];
const trust = clusterTrust({ snapshotPublicKeyHex: snapshotKey.publicKeyHex, faucetPublicKeyHex: faucetKey.publicKeyHex }, others);
const signing = { snapshotSigningKeys: [snapshotKey.privateKey], faucetSigningKey: faucetKey.privateKey };

// 0.5.83 Block D: network registry policy (UEP_REGISTRY_POLICY=<policy.json>: { networkId, requireAssetRegistry, governance }).
// The governance-signed manifest chain is kept in <dir>/asset-registry.json (AssetRegistryStore); with
// requireAssetRegistry the node refuses to operate without it.
const registryPolicy = process.env.UEP_REGISTRY_POLICY ? JSON.parse(readFileSync(process.env.UEP_REGISTRY_POLICY, "utf8")) as NetworkRegistryPolicy : undefined;
const registryStore = registryPolicy ? (dir ? AssetRegistryStore.open(dir, registryPolicy) : undefined) : undefined;
if (registryPolicy) assertRegistryPolicy(registryPolicy, registryStore?.registry, registryPolicy.networkId);
const assetRegistry = registryStore?.registry;
if (assetRegistry) (trust as { assetRegistry?: unknown }).assetRegistry = assetRegistry;

let ledger = dir && existsSync(join(dir, "ledger.snapshot.json"))
  ? UepLedger.restore(JSON.parse(readFileSync(join(dir, "ledger.snapshot.json"), "utf8"), reviveBigInt), trust, signing)
  : newNodeLedger({ snapshotKey, faucetKey, noteBlindingDomain: blindingDomain, assetRegistry });
registryStore?.assertNotBehind(ledger.assetRegistryBinding());

// 0.5.81 item 4: the ledger read from disk must not be below this node's own persisted height floor.
if (dir) new HeightFloor(dir).check(ledger, { allowRegression: process.env.UEP_ALLOW_HEIGHT_REGRESSION === "1" });

// Catch up before the node is assembled, so the API, queue, bridge and Marketplace all serve the ledger that was kept.
let net: PeerNet | undefined;
let peerLine = "";
if (list && me && nodeId) {
  const voter = storedKey("voter.pem");
  const voters = new Map([[nodeId, voter.publicKeyHex]]);
  for (const peer of others) if (peer.publicKeyHex) voters.set(peer.id, peer.publicKeyHex);
  net = new PeerNet(nodeId, ledger, voter.privateKey, voter.publicKeyHex, others, voters, list.threshold ?? 2, dir);
  await net.listen(Number(new URL(me.url).port));
  const known = await net.learnPeers();
  const caught = await net.catchUp(trust, signing);
  ledger = net.ledger;
  peerLine = `uep-peer ${nodeId} ${me.url} voters=${known} caughtUp=${caught} publicKeyHex=${voter.publicKeyHex} snapshotPublicKeyHex=${snapshotKey.publicKeyHex} faucetPublicKeyHex=${faucetKey.publicKeyHex}`;
}

const marketplaceSnapshot = dir && existsSync(join(dir, "marketplace.snapshot.json")) ? JSON.parse(readFileSync(join(dir, "marketplace.snapshot.json"), "utf8")) : undefined;
const node = assembleNode({ custody, feeAccount, snapshotKey, faucetKey, noteBlindingDomain: blindingDomain, ledger, marketplaceSnapshot, ...(registryPolicy ? { registryPolicy } : {}) });
if (net && node.ledger !== net.ledger) throw new Error("LEDGER_SPLIT: the node and the peer port must serve one ledger");
if (dir) {
  const save = () => {
    writeSecret(join(dir, "ledger.snapshot.json"), JSON.stringify(node.ledger.snapshot(), (_k, v) => typeof v === "bigint" ? { $b: v.toString() } : v));
    new HeightFloor(dir).record(node.ledger);
    writeSecret(join(dir, "marketplace.snapshot.json"), JSON.stringify(node.marketplace.exportSnapshot(), (_k, v) => typeof v === "bigint" ? v.toString() : v));
  };
  process.on("SIGINT", () => { save(); process.exit(0); });
  process.on("SIGTERM", () => { save(); process.exit(0); });
}
const { port } = await node.listen(Number(process.env.UEP_PORT ?? 8787));
console.log(`uep-node ${node.circuitTag} height=${node.ledger.height} http://127.0.0.1:${port}`);
if (peerLine) console.log(peerLine);
