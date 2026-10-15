/**
 * 0.5.81 item 4: a node's own persisted height floor, for nodes outside BFT mode.
 *
 * `<stateDir>/ledger.height-floor.json` keeps the highest {height, stateRoot} this node has
 * persisted or adopted. It only moves up. On start-up and on catch-up the ledger must be at or above
 * the floor, and at the floor height it must have the recorded root; otherwise the node refuses to
 * run (LEDGER_BELOW_HEIGHT_FLOOR / LEDGER_ROOT_AT_FLOOR_MISMATCH). An operator who really wants a
 * rollback passes an explicit override, which is logged. Written atomically (temp file + rename).
 */
import { existsSync, readFileSync, renameSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { join } from "node:path";

export type HeightFloorRecord = { version: 1; height: number; stateRoot: string };
export const HEIGHT_FLOOR_FILE = "ledger.height-floor.json";

export class HeightFloor {
  readonly path: string;
  constructor(stateDir: string) { this.path = join(stateDir, HEIGHT_FLOOR_FILE); }

  read(): HeightFloorRecord | undefined {
    if (!existsSync(this.path)) return undefined;
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as HeightFloorRecord;
    if (raw?.version !== 1 || !Number.isSafeInteger(raw.height) || raw.height < 0 || typeof raw.stateRoot !== "string" || !/^[0-9a-f]{64}$/.test(raw.stateRoot)) throw new Error("HEIGHT_FLOOR_CORRUPT");
    return raw;
  }

  /** Throws when the ledger is below the floor, or at the floor height with another root. */
  check(ledger: { height: number; stateRoot(): { toHex(): string } }, opts: { allowRegression?: boolean; log?: (m: string) => void } = {}): void {
    const floor = this.read();
    if (!floor) return;
    const bad = ledger.height < floor.height ? "LEDGER_BELOW_HEIGHT_FLOOR"
      : ledger.height === floor.height && ledger.stateRoot().toHex() !== floor.stateRoot ? "LEDGER_ROOT_AT_FLOOR_MISMATCH" : undefined;
    if (!bad) return;
    if (opts.allowRegression) { (opts.log ?? console.warn)(`[uep-node] ${bad} overridden by operator: ledger height ${ledger.height}, floor ${floor.height}`); return; }
    throw new Error(`${bad}: ledger height ${ledger.height}, persisted floor ${floor.height}`);
  }

  /** Raise the floor to the ledger's height (never lowers it). */
  record(ledger: { height: number; stateRoot(): { toHex(): string } }): void {
    const floor = this.read();
    if (floor && ledger.height < floor.height) return;
    if (floor && ledger.height === floor.height && floor.stateRoot === ledger.stateRoot().toHex()) return;
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, height: ledger.height, stateRoot: ledger.stateRoot().toHex() } satisfies HeightFloorRecord) + "\n", { mode: 0o600 });
    const fd = openSync(tmp, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.path);
  }
}
