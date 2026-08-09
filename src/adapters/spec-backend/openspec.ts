import { join } from "node:path";
import { FilesystemSpecBackend } from "./filesystem-backend.js";

export class OpenSpecBackend extends FilesystemSpecBackend {
  readonly kind = "openspec" as const;

  protected ledgerRoot(): string {
    return join(this.root, "openspec");
  }
}
