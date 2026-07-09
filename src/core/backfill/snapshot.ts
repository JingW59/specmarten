import type { SpecBackend, ChangeDetail, ChangeMeta, SpecMeta } from "../../adapters/spec-backend/types.js";

export interface BackfillSnapshot {
  activeChanges: ChangeMeta[];
  archivedChanges: ChangeMeta[];
  changes: ChangeDetail[];
  specs: SpecMeta[];
}

export async function readBackfillSnapshot(backend: SpecBackend): Promise<BackfillSnapshot> {
  const [activeChanges, archivedChanges, specs] = await Promise.all([
    backend.listActiveChanges(),
    backend.listArchivedChanges(),
    backend.listSpecs()
  ]);
  const allMetas = sortChanges([...archivedChanges, ...activeChanges]);
  const changes = await Promise.all(allMetas.map((change) => backend.readChange(change.id)));

  return {
    activeChanges,
    archivedChanges,
    changes,
    specs
  };
}

function sortChanges(changes: ChangeMeta[]): ChangeMeta[] {
  return [...changes].sort((a, b) => {
    const dateA = a.archivedAt ?? "9999-99-99";
    const dateB = b.archivedAt ?? "9999-99-99";
    return dateA.localeCompare(dateB) || a.id.localeCompare(b.id);
  });
}
