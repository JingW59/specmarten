import { readContentLanguage } from "../../config/config.js";
import type { SpecMartenState } from "../state/schema.js";
import { writeDashboard } from "./dashboard.js";
import { writeRoadmap } from "./roadmap.js";

export async function renderViews(root: string, state: SpecMartenState): Promise<void> {
  const contentLanguage = await readContentLanguage(root);
  await Promise.all([writeRoadmap(root, state), writeDashboard(root, state, { contentLanguage })]);
}
