/**
 * ZK spend witness contract (UEP-28.4).
 *
 * Matches Rust SpendCircuit private/public layout.
 *
 * Spent-note blinding (circuit binding):
 *   senderOldLeaf = balanceLeaf(sender, asset, oldAmount, noteBlinding)
 *   noteNonce     = H_LEAF(senderOldLeaf, noteBlinding)
 *   nullifier     = H_NULLIFIER(senderSecret, noteNonce)
 *
 * Recipient/treasury leaves use their own blindings (not the spent note).
 *
 * Status: schema + structural builder + crypto consistency validation.
 * Poseidon prove-from-wallet: via ZkSpendProofProvider (experimental bridge).
 */

import { Fr } from "./field.ts";
import { hLeaf, hNullifier } from "./hash.ts";
import { accountIdsFromSecrets } from "./spend-key.ts";
import {
  ACCOUNT_DEPTH,
  EMPTY_LEAF,
  type MerklePath,
  SparseMerkleTree,
  verifyInsert,
  verifyUpdate,
} from "./smt.ts";
import {
  SPEND_PUBLIC_INPUT_NAMES,
  type SpendPublicInputs,
  publicInputsOrdered,
} from "./spend-proof.ts";

export const ZK_WITNESS_CONTRACT_VERSION = "UEP-28.4-spend-witness-v1";
export const ZK_SMT_DEPTH = ACCOUNT_DEPTH;

export type ZkMerklePath = {
  index: bigint;
  indexBits: boolean[];
  siblings: Fr[];
};

export type ZkSpendWitness = {
  contractVersion: typeof ZK_WITNESS_CONTRACT_VERSION;
  depth: number;
  usePoseidon: boolean;

  senderSecret: Fr;
  senderSalt: Fr;
  /** Blinding of the spent sender note/leaf (unique; not recipient/treasury). */
  noteBlinding: Fr;
  noteNonce: Fr;

  senderOldAmount: Fr;
  senderNewAmount: Fr;
  recipientOldAmount: Fr;
  recipientNewAmount: Fr;
  treasuryOldAmount: Fr;
  treasuryNewAmount: Fr;

  midRootAfterSender: Fr;
  midRootAfterRecipient: Fr;

  senderPath: ZkMerklePath;
  senderOldLeaf: Fr;
  senderNewLeaf: Fr;

  recipientPath: ZkMerklePath;
  recipientOldLeaf: Fr;
  recipientNewLeaf: Fr;
  recipientBlinding: Fr;

  treasuryPath: ZkMerklePath;
  treasuryOldLeaf: Fr;
  treasuryNewLeaf: Fr;
  treasuryBlinding: Fr;

  nullifierPath: ZkMerklePath;
  nullifierLeaf: Fr;
};

export type ZkSpendInstance = {
  publicInputs: SpendPublicInputs;
  witness: ZkSpendWitness;
};

export type WitnessValidation =
  | { ok: true }
  | { ok: false; errors: string[] };

export type ValidateOpts = {
  /** SMT path / root checks (UEP-25 algebraic trees). */
  checkTrees?: boolean;
  /**
   * Cryptographic consistency bindings (account id, note nonce, nullifier,
   * canonical lowBits indices). Uses UEP-25 hash helpers when usePoseidon=false.
   */
  checkCrypto?: boolean;
  /** Leaf hasher for crypto checks (defaults to UEP-25 nested hLeaf). */
  balanceLeaf?: (owner: Fr, asset: Fr, amount: bigint, blinding: Fr) => Fr;
};

function pathLenOk(path: ZkMerklePath, depth: number): boolean {
  return path.siblings.length === depth && path.indexBits.length === depth;
}

function merklePathFromTree(tree: SparseMerkleTree, id: Fr): ZkMerklePath {
  const index = tree.indexOf(id);
  const p = tree.pathAt(index);
  return { index, indexBits: p.indexBits, siblings: p.siblings };
}

function asMerklePath(z: ZkMerklePath): MerklePath {
  return { siblings: z.siblings, indexBits: z.indexBits };
}

/** Default UEP-25 balance leaf: H_LEAF(H_LEAF(owner, H_LEAF(asset, amount)), blinding). */
export function defaultBalanceLeaf(
  owner: Fr,
  asset: Fr,
  amount: bigint,
  blinding: Fr,
): Fr {
  const u64ToFr = (n: bigint) => Fr.from(n);
  const inner = hLeaf(asset, u64ToFr(amount));
  const payload = hLeaf(owner, inner);
  return hLeaf(payload, blinding);
}

export function deriveNoteNonce(senderOldLeaf: Fr, noteBlinding: Fr): Fr {
  return hLeaf(senderOldLeaf, noteBlinding);
}

export function validateZkSpendInstance(
  inst: ZkSpendInstance,
  opts?: ValidateOpts,
): WitnessValidation {
  const errors: string[] = [];
  const { publicInputs: pub, witness: w } = inst;
  const depth = w.depth;

  if (w.contractVersion !== ZK_WITNESS_CONTRACT_VERSION) {
    errors.push(`contractVersion must be ${ZK_WITNESS_CONTRACT_VERSION}`);
  }
  if (depth < 3 || depth > ZK_SMT_DEPTH) {
    errors.push(`unexpected depth ${depth}`);
  }
  if (publicInputsOrdered(pub).length !== 12) {
    errors.push("public inputs must be 12");
  }
  if (SPEND_PUBLIC_INPUT_NAMES.length !== 12) {
    errors.push("SPEND_PUBLIC_INPUT_NAMES");
  }

  for (const [name, path] of [
    ["sender", w.senderPath],
    ["recipient", w.recipientPath],
    ["treasury", w.treasuryPath],
    ["nullifier", w.nullifierPath],
  ] as const) {
    if (!pathLenOk(path, depth)) errors.push(`${name} path length != depth`);
  }

  const amount = pub.amount.n;
  const fee = pub.fee.n;
  if (w.senderOldAmount.n !== w.senderNewAmount.n + amount + fee) {
    errors.push("sender conservation violated");
  }
  if (w.recipientNewAmount.n !== w.recipientOldAmount.n + amount) {
    errors.push("recipient conservation violated");
  }
  if (w.treasuryNewAmount.n !== w.treasuryOldAmount.n + fee) {
    errors.push("treasury conservation violated");
  }

  if (opts?.checkCrypto) {
    const leafFn = opts.balanceLeaf ?? defaultBalanceLeaf;

    // v0.4.5: senderId = key-derived account id of the spend key of (secret, salt).
    // A future circuit has to prove this binding (or the signature) in-circuit.
    // v0.5.1: the v3 id, or the v2 id of the same key for existing accounts.
    const expectIds = accountIdsFromSecrets(w.senderSecret, w.senderSalt);
    if (!expectIds.v3.eq(pub.senderId) && !expectIds.v2.eq(pub.senderId)) {
      errors.push("senderId != accountIdFromSpendKey(spendKey(secret, salt))");
    }

    // sender leaves use noteBlinding only
    const expectOldLeaf = leafFn(
      pub.senderId,
      pub.assetId,
      w.senderOldAmount.n,
      w.noteBlinding,
    );
    if (!expectOldLeaf.eq(w.senderOldLeaf)) {
      errors.push("senderOldLeaf != balanceLeaf(..., noteBlinding)");
    }
    const expectNewLeaf = leafFn(
      pub.senderId,
      pub.assetId,
      w.senderNewAmount.n,
      w.noteBlinding,
    );
    if (!expectNewLeaf.eq(w.senderNewLeaf)) {
      errors.push("senderNewLeaf != balanceLeaf(..., noteBlinding)");
    }

    // noteNonce = H_LEAF(senderOldLeaf, noteBlinding)
    const expectNonce = deriveNoteNonce(w.senderOldLeaf, w.noteBlinding);
    if (!expectNonce.eq(w.noteNonce)) {
      errors.push("noteNonce != H_LEAF(senderOldLeaf, noteBlinding)");
    }

    // nullifier = H_NULLIFIER(secret, noteNonce)
    const expectNf = hNullifier(w.senderSecret, w.noteNonce);
    if (!expectNf.eq(pub.nullifier)) {
      errors.push("nullifier != H_NULLIFIER(secret, noteNonce)");
    }
    if (!w.nullifierLeaf.eq(pub.nullifier)) {
      errors.push("nullifierLeaf != public nullifier");
    }

    // Path index bits must match the integer index (LSB-first).
    // Account-tree leaf keys may be H(account, asset); nullifier uses lowBits(nullifier).
    for (const [name, path] of [
      ["sender", w.senderPath],
      ["recipient", w.recipientPath],
      ["treasury", w.treasuryPath],
      ["nullifier", w.nullifierPath],
    ] as const) {
      for (let i = 0; i < depth; i++) {
        const bit = ((path.index >> BigInt(i)) & 1n) === 1n;
        if (path.indexBits[i] !== bit) {
          errors.push(`${name} indexBits[${i}] != bit of index`);
          break;
        }
      }
    }
    // Nullifier tree is indexed by the nullifier field itself (protocol).
    if (w.nullifierPath.index !== pub.nullifier.lowBits(depth)) {
      errors.push("nullifierPath.index != lowBits(nullifier, depth)");
    }

    // Recipient / treasury leaves bound to their blindings
    const rOld = leafFn(pub.recipientId, pub.assetId, w.recipientOldAmount.n, w.recipientBlinding);
    const rNew = leafFn(pub.recipientId, pub.assetId, w.recipientNewAmount.n, w.recipientBlinding);
    if (!rOld.eq(w.recipientOldLeaf) || !rNew.eq(w.recipientNewLeaf)) {
      errors.push("recipient leaves mismatch recipientBlinding");
    }
    const tOld = leafFn(pub.treasuryId, pub.assetId, w.treasuryOldAmount.n, w.treasuryBlinding);
    const tNew = leafFn(pub.treasuryId, pub.assetId, w.treasuryNewAmount.n, w.treasuryBlinding);
    if (!tOld.eq(w.treasuryOldLeaf) || !tNew.eq(w.treasuryNewLeaf)) {
      errors.push("treasury leaves mismatch treasuryBlinding");
    }
  }

  if (opts?.checkTrees && !w.usePoseidon) {
    const sp = asMerklePath(w.senderPath);
    if (!verifyUpdate(pub.oldStateRoot, w.midRootAfterSender, w.senderOldLeaf, w.senderNewLeaf, sp)) {
      errors.push("sender path does not connect old_state_root → midRootAfterSender");
    }
    const rp = asMerklePath(w.recipientPath);
    if (
      !verifyUpdate(
        w.midRootAfterSender,
        w.midRootAfterRecipient,
        w.recipientOldLeaf,
        w.recipientNewLeaf,
        rp,
      )
    ) {
      errors.push("recipient path does not connect mid roots");
    }
    const tp = asMerklePath(w.treasuryPath);
    if (
      !verifyUpdate(
        w.midRootAfterRecipient,
        pub.newStateRoot,
        w.treasuryOldLeaf,
        w.treasuryNewLeaf,
        tp,
      )
    ) {
      errors.push("treasury path does not connect to new_state_root");
    }
    const np = asMerklePath(w.nullifierPath);
    if (
      !verifyInsert(pub.oldNullifierRoot, pub.newNullifierRoot, EMPTY_LEAF, w.nullifierLeaf, np)
    ) {
      errors.push("nullifier path does not insert into nullifier tree");
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true };
}

export type StructuralSpendSpec = {
  depth?: number;
  senderId: Fr;
  recipientId: Fr;
  treasuryId: Fr;
  assetId: Fr;
  amount: bigint;
  fee: bigint;
  senderSecret: Fr;
  senderSalt: Fr;
  /** Spent note blinding — also used for sender leaf (circuit binding). */
  noteBlinding: Fr;
  /** If omitted, derived as H_LEAF(senderOldLeaf, noteBlinding). */
  noteNonce?: Fr;
  /** If omitted, derived as H_NULLIFIER(secret, noteNonce). */
  nullifier?: Fr;
  transactionCommitment: Fr;
  stateTree: SparseMerkleTree;
  nullifierTree: SparseMerkleTree;
  balanceLeaf: (owner: Fr, asset: Fr, amount: bigint, blinding: Fr) => Fr;
  leafKey: (account: Fr, asset: Fr) => Fr;
  recipientBlinding: Fr;
  treasuryBlinding: Fr;
  senderOldAmount: bigint;
  recipientOldAmount: bigint;
  treasuryOldAmount: bigint;
};

/**
 * Structural (UEP-25) witness builder — NOT the production Poseidon path.
 * Production: build canonical fields then prove via Rust Poseidon circuit.
 */
export function buildStructuralZkSpendInstance(spec: StructuralSpendSpec): ZkSpendInstance {
  const depth = spec.depth ?? ZK_SMT_DEPTH;
  const tree = spec.stateTree.clone();
  const ntree = spec.nullifierTree.clone();

  const senderKey = spec.leafKey(spec.senderId, spec.assetId);
  const recipientKey = spec.leafKey(spec.recipientId, spec.assetId);
  const treasuryKey = spec.leafKey(spec.treasuryId, spec.assetId);

  // Sender leaf uses noteBlinding exclusively (UEP-26.9 binding).
  const senderOldLeaf = spec.balanceLeaf(
    spec.senderId,
    spec.assetId,
    spec.senderOldAmount,
    spec.noteBlinding,
  );
  const senderNewAmount = spec.senderOldAmount - spec.amount - spec.fee;
  const senderNewLeaf = spec.balanceLeaf(
    spec.senderId,
    spec.assetId,
    senderNewAmount,
    spec.noteBlinding,
  );

  const noteNonce = spec.noteNonce ?? deriveNoteNonce(senderOldLeaf, spec.noteBlinding);
  const nullifier =
    spec.nullifier ?? hNullifier(spec.senderSecret, noteNonce);

  const recipientOldLeaf = spec.balanceLeaf(
    spec.recipientId,
    spec.assetId,
    spec.recipientOldAmount,
    spec.recipientBlinding,
  );
  const recipientNewAmount = spec.recipientOldAmount + spec.amount;
  const recipientNewLeaf = spec.balanceLeaf(
    spec.recipientId,
    spec.assetId,
    recipientNewAmount,
    spec.recipientBlinding,
  );
  const treasuryOldLeaf = spec.balanceLeaf(
    spec.treasuryId,
    spec.assetId,
    spec.treasuryOldAmount,
    spec.treasuryBlinding,
  );
  const treasuryNewAmount = spec.treasuryOldAmount + spec.fee;
  const treasuryNewLeaf = spec.balanceLeaf(
    spec.treasuryId,
    spec.assetId,
    treasuryNewAmount,
    spec.treasuryBlinding,
  );

  const oldStateRoot = tree.root();
  const senderPath = merklePathFromTree(tree, senderKey);
  tree.set(senderKey, senderNewLeaf);
  const midRootAfterSender = tree.root();

  const recipientPath = merklePathFromTree(tree, recipientKey);
  tree.set(recipientKey, recipientNewLeaf);
  const midRootAfterRecipient = tree.root();

  const treasuryPath = merklePathFromTree(tree, treasuryKey);
  tree.set(treasuryKey, treasuryNewLeaf);
  const newStateRoot = tree.root();

  const oldNullifierRoot = ntree.root();
  const nullifierPath = merklePathFromTree(ntree, nullifier);
  ntree.set(nullifier, nullifier);
  const newNullifierRoot = ntree.root();

  const publicInputs: SpendPublicInputs = {
    oldStateRoot,
    newStateRoot,
    oldNullifierRoot,
    newNullifierRoot,
    senderId: spec.senderId,
    recipientId: spec.recipientId,
    treasuryId: spec.treasuryId,
    assetId: spec.assetId,
    amount: Fr.from(spec.amount),
    fee: Fr.from(spec.fee),
    nullifier,
    transactionCommitment: spec.transactionCommitment,
  };

  const witness: ZkSpendWitness = {
    contractVersion: ZK_WITNESS_CONTRACT_VERSION,
    depth,
    usePoseidon: false,
    senderSecret: spec.senderSecret,
    senderSalt: spec.senderSalt,
    noteBlinding: spec.noteBlinding,
    noteNonce,
    senderOldAmount: Fr.from(spec.senderOldAmount),
    senderNewAmount: Fr.from(senderNewAmount),
    recipientOldAmount: Fr.from(spec.recipientOldAmount),
    recipientNewAmount: Fr.from(recipientNewAmount),
    treasuryOldAmount: Fr.from(spec.treasuryOldAmount),
    treasuryNewAmount: Fr.from(treasuryNewAmount),
    midRootAfterSender,
    midRootAfterRecipient,
    senderPath,
    senderOldLeaf,
    senderNewLeaf,
    recipientPath,
    recipientOldLeaf,
    recipientNewLeaf,
    recipientBlinding: spec.recipientBlinding,
    treasuryPath,
    treasuryOldLeaf,
    treasuryNewLeaf,
    treasuryBlinding: spec.treasuryBlinding,
    nullifierPath,
    nullifierLeaf: nullifier,
  };

  return { publicInputs, witness };
}

export function serializeZkSpendInstance(inst: ZkSpendInstance): unknown {
  const hex = (f: Fr) => f.toHex();
  const path = (p: ZkMerklePath) => ({
    index: p.index.toString(),
    indexBits: p.indexBits,
    siblings: p.siblings.map(hex),
  });
  const w = inst.witness;
  const pub = inst.publicInputs;
  return {
    contractVersion: w.contractVersion,
    depth: w.depth,
    usePoseidon: w.usePoseidon,
    publicInputs: {
      oldStateRoot: hex(pub.oldStateRoot),
      newStateRoot: hex(pub.newStateRoot),
      oldNullifierRoot: hex(pub.oldNullifierRoot),
      newNullifierRoot: hex(pub.newNullifierRoot),
      senderId: hex(pub.senderId),
      recipientId: hex(pub.recipientId),
      treasuryId: hex(pub.treasuryId),
      assetId: hex(pub.assetId),
      amount: hex(pub.amount),
      fee: hex(pub.fee),
      nullifier: hex(pub.nullifier),
      transactionCommitment: hex(pub.transactionCommitment),
    },
    witness: {
      senderSecret: hex(w.senderSecret),
      senderSalt: hex(w.senderSalt),
      noteBlinding: hex(w.noteBlinding),
      noteNonce: hex(w.noteNonce),
      senderOldAmount: hex(w.senderOldAmount),
      senderNewAmount: hex(w.senderNewAmount),
      recipientOldAmount: hex(w.recipientOldAmount),
      recipientNewAmount: hex(w.recipientNewAmount),
      treasuryOldAmount: hex(w.treasuryOldAmount),
      treasuryNewAmount: hex(w.treasuryNewAmount),
      midRootAfterSender: hex(w.midRootAfterSender),
      midRootAfterRecipient: hex(w.midRootAfterRecipient),
      senderPath: path(w.senderPath),
      senderOldLeaf: hex(w.senderOldLeaf),
      senderNewLeaf: hex(w.senderNewLeaf),
      recipientPath: path(w.recipientPath),
      recipientOldLeaf: hex(w.recipientOldLeaf),
      recipientNewLeaf: hex(w.recipientNewLeaf),
      recipientBlinding: hex(w.recipientBlinding),
      treasuryPath: path(w.treasuryPath),
      treasuryOldLeaf: hex(w.treasuryOldLeaf),
      treasuryNewLeaf: hex(w.treasuryNewLeaf),
      treasuryBlinding: hex(w.treasuryBlinding),
      nullifierPath: path(w.nullifierPath),
      nullifierLeaf: hex(w.nullifierLeaf),
    },
  };
}
