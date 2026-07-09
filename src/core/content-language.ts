import { z } from "zod";

export const contentLanguageSchema = z.enum(["en", "zh"]);
export type ContentLanguage = z.infer<typeof contentLanguageSchema>;

export const DEFAULT_CONTENT_LANGUAGE: ContentLanguage = "en";

export function contentLanguageLabel(language: ContentLanguage): string {
  return language === "zh" ? "Chinese" : "English";
}

export function contentLanguageInstruction(language: ContentLanguage): string {
  return `Generated content language:
- Generate all new model-authored mission, roadmap, stream, track, phase, task, question, note, and patrol report text in ${contentLanguageLabel(language)}.
- Preserve existing state text in its current language; do not translate historical roadmap or task content unless the user explicitly asks.`;
}
