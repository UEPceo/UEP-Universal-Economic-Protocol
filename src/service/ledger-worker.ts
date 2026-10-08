/**
 * v0.5.3 (external review 2026-10-08): worker-thread side of
 * LedgerWorkerHost (src/service/ledger-worker-host.ts). Owns one UepLedger
 * and applies the messages of its host one at a time, so the Poseidon / SMT
 * work of a submit runs off the service's event loop. Transactions cross the
 * thread boundary in their serializeTx() form.
 *
 * Service-side adapter; never imported by a transition.
 */
import { parentPort, workerData } from "node:worker_threads";
import { UepLedger } from "../testnet/ledger.ts";
import { deserializeTx, serializeTx } from "../core/transaction.ts";
import { Fr } from "../core/field.ts";

type Init =
  | { mode: "new"; options: ConstructorParameters<typeof UepLedger>[0] }
  | { mode: "restore"; snapshot: Parameters<typeof UepLedger.restore>[0]; trust: Parameters<typeof UepLedger.restore>[1]; keys?: Parameters<typeof UepLedger.restore>[2] };

const init = workerData as Init;
const ledger = init.mode === "new" ? new UepLedger(init.options) : UepLedger.restore(init.snapshot, init.trust, init.keys ?? {});

function outResult(r: { tx?: Parameters<typeof serializeTx>[0]; txs?: Parameters<typeof serializeTx>[0][]; error?: unknown; index?: number }) {
  if (r.error) return { error: r.error, ...(r.index !== undefined ? { index: r.index } : {}) };
  if (r.txs) return { txs: r.txs.map(serializeTx) };
  return { tx: serializeTx(r.tx!) };
}

parentPort!.on("message", (msg: { id: number; op: string; args: unknown[] }) => {
  let reply: { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };
  try {
    let value: unknown;
    switch (msg.op) {
      case "submit":
        value = outResult(ledger.submit(deserializeTx(msg.args[0] as never)) as never);
        break;
      case "submitBatch":
        value = outResult(ledger.submitBatch((msg.args[0] as never[]).map((t) => deserializeTx(t))) as never);
        break;
      case "faucet":
        ledger.faucet(new Fr(msg.args[0] as string), msg.args[1] as string, BigInt(msg.args[2] as string));
        value = true;
        break;
      case "status":
        value = { height: ledger.blockHeight, stateRoot: ledger.stateRoot().toHex(), txCount: ledger.txs.length };
        break;
      case "snapshot":
        value = ledger.snapshot();
        break;
      case "advanceHeight":
        value = ledger.advanceHeight(msg.args[0] as number);
        break;
      default:
        throw new Error(`LEDGER_WORKER_UNKNOWN_OP: ${msg.op}`);
    }
    reply = { id: msg.id, ok: true, value };
  } catch (err) {
    reply = { id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
parentPort!.postMessage({ id: 0, ok: true, value: "ready" });
