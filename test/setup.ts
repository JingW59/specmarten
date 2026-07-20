import { join } from "node:path";
import { tmpdir } from "node:os";

process.env.SPECMARTEN_CONFIG = join(tmpdir(), "specmarten-test-global-config-does-not-exist.json");
