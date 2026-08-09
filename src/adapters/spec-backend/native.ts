import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { ensureDir } from "../../util/fs.js";
import { FilesystemSpecBackend } from "./filesystem-backend.js";

export class NativeSpecBackend extends FilesystemSpecBackend {
  readonly kind = "native" as const;

  protected ledgerRoot(): string {
    return join(this.root, TOOL.dataDir, "ledger");
  }
}

export async function initializeNativeLedger(root: string): Promise<void> {
  await Promise.all([
    ensureDir(join(root, TOOL.dataDir, "ledger", "changes", "archive")),
    ensureDir(join(root, TOOL.dataDir, "ledger", "specs"))
  ]);
}
