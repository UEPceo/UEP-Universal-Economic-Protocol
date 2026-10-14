# Phase 4 harness — engineering scope and limitations (updated for 0.5.80)

This is not an independent assessment. It documents the harness scope and what a third party can reproduce.

## What the harness claims

- Three nodes, fixed list, no discovery, no leader. Threshold two of three.
- A vote signs `uep-quorum:networkId:domainId:txId`. Another domain does not confirm.
- `/tx`, `/vote` and `/commit` are signed. Unsigned is `PEER_AUTH`.
- A known voter key is not replaced by `/status`. `publicKeyHex` in the list is the pin.
- `catchUp` restores only from an ahead peer, fails closed on a bad snapshot, and does not roll back.
- Votes persist in `quorum-votes.json`, including `confirmed`.
- A peer validates a spend against its own ledger before it votes. An invalid spend gets no vote.
- A node trusts the snapshot and faucet keys pinned in `peers.json`, plus its own. A key that is not pinned has no weight.
- Three real `cli.ts` processes: a node that starts late catches up with the pins and does not without them.
- The proposer applies only after `threshold - 1` peers acknowledge the commit.
- Different local configuration (fee account, admin, blinding domain) accepts the same spend.
- A closed peer does not block two of three. On return it reaches the same root.
- Fees stay 0.1 % protocol and 3 % Marketplace. Ledger snapshot format 10. No native token.

## What it does not claim

- Production consensus. No view change, no ceremony.
- The HTTP timeout and the list of three are the harness, not the protocol.
- A closed socket is not a network partition.
- First contact without a pin may learn a key once. That is not the trust model.
- `catchUp` trusts the one pinned peer that serves the snapshot (authority threshold 1).
- A spend sent to a node's own API does not go through the peer quorum; only `/propose` does.
- `src/lab/` is not this network.
- An independent assessment. This file does not invent one.

## What a third party runs

Node.js 22.6 or newer.

```text
npm install
npm run test:consensus
```

Files: `src/node/peer-net.ts`, `src/node/quorum.ts`, `src/node/cli.ts`, `docs/adr/0006-consensus-scope.md`.
