export interface ChangeTaskProgress {
  completed: number;
  total: number;
  complete: boolean;
}

export interface ChangeMeta {
  id: string;
  status: "active" | "archived";
  title?: string;
  archivedAt?: string;
  specsTouched: string[];
  taskProgress?: ChangeTaskProgress;
}

export interface ChangeDetail extends ChangeMeta {
  proposal?: string;
  tasks?: string;
  specDeltas: Array<{ path: string; content: string }>;
}

export interface SpecMeta {
  id: string;
  path: string;
  hash?: string;
}

export interface SpecsSnapshot {
  specsHash: string;
  copiedFiles: number;
}

export interface SpecBackend {
  isPresent(): Promise<boolean>;
  listActiveChanges(): Promise<ChangeMeta[]>;
  listArchivedChanges(): Promise<ChangeMeta[]>;
  readChange(id: string): Promise<ChangeDetail>;
  listSpecs(): Promise<SpecMeta[]>;
  getCurrentMarker(): Promise<string>;
  getSpecsHash(): Promise<string>;
  snapshotSpecs(destination: string): Promise<SpecsSnapshot>;
  hasChangedSince(marker?: string): Promise<boolean>;
}
