import { join } from "node:path";
import { TOOL } from "../../constants.js";
import { writeText } from "../../util/fs.js";
import { DEFAULT_CONTENT_LANGUAGE, type ContentLanguage } from "../content-language.js";
import {
  derivePhaseProgress,
  derivePhaseStatus,
  deriveStreamProgress,
  deriveTrackProgress,
  EMPTY_PROGRESS_COUNTS,
  findCurrentStream,
  type ProgressCounts
} from "../progress/progress.js";
import type { SpecMartenPhase, SpecMartenState, SpecMartenStream, SpecMartenTask, SpecMartenTrack } from "../state/schema.js";

type PatrolVerdict = "PASS" | "WARN" | "BLOCK";
type LocaleKey = keyof typeof EN_LOCALE;

const AUTO_REFRESH_MS = 60_000;
const EARLY_PHASE_FOLD_LIMIT = 4;

const EN_LOCALE = {
  "page.title": "SpecMarten · Project Status Dashboard",
  "page.heading": "SpecMarten Project Status Dashboard",
  "topbar.crumb": "specmarten / status",
  "locale.aria": "Switch dashboard language",
  "theme.aria": "Toggle theme",
  "refresh.label": "Auto refresh",
  "refresh.value": "Every {seconds}s",
  "refresh.countdown": "Refresh in {seconds}s",
  "header.subtitle": "Project Status Dashboard",
  "summary.aria": "Project summary",
  "mission.missing": "[TODO: mission is not set]",
  "progress.title": "Current Stream Progress",
  "progress.noCurrent": "No current stream",
  "progress.subhead": "{version} · {label} · {done}/{total} tasks",
  "status.done": "Done",
  "status.inProgress": "In progress",
  "status.todo": "Todo",
  "patrol.title": "Drift Patrol",
  "patrol.pending": "Pending",
  "patrol.none.before": "No drift patrol has run yet. Run ",
  "patrol.none.after": " to show a verdict here.",
  "patrol.pass": "No drift detected",
  "patrol.warn": "Review recommended",
  "patrol.block": "Spec drift detected",
  "patrol.report": "View report ↗",
  "roadmap.title": "Roadmap",
  "roadmap.hint": "Grouped by stream · supersedes = next milestone, parallel = concurrent tracks",
  "consistency.title": "OpenSpec Consistency",
  "consistency.description": "These OpenSpec changes are not linked to a roadmap task yet.",
  "consistency.active": "Active",
  "consistency.archived": "Archived",
  "empty.noStreams": "No streams yet.",
  "empty.before": "Run ",
  "empty.after": " to create the first stream and start maintaining the roadmap.",
  "connector.mark": "↓ supersedes",
  "connector.text": "{label} supersedes the previous stream and restarts at P1",
  "stream.active": "Active",
  "stream.maintained": "Maintained",
  "stream.planned": "Planned",
  "stream.expand": "Expand history",
  "stream.supersedes": "· supersedes {version}",
  "parallel.label": "Parallel tracks",
  "phase.none": "No phases in this scope.",
  "task.none": "No tasks yet",
  "task.showMore": "Show {count} hidden tasks",
  "footer.summary": "{count} streams · current {current} · maintained from OpenSpec history"
} as const;

const ZH_LOCALE: Record<LocaleKey, string> = {
  "page.title": "SpecMarten · 项目状态看板",
  "page.heading": "SpecMarten 项目状态看板",
  "topbar.crumb": "specmarten / 状态",
  "locale.aria": "切换看板语言",
  "theme.aria": "切换主题",
  "refresh.label": "自动刷新",
  "refresh.value": "每 {seconds} 秒",
  "refresh.countdown": "{seconds} 秒后刷新",
  "header.subtitle": "项目状态看板",
  "summary.aria": "项目摘要",
  "mission.missing": "[待办：尚未设置使命]",
  "progress.title": "当前流进度",
  "progress.noCurrent": "暂无当前流",
  "progress.subhead": "{version} · {label} · {done}/{total} 个任务",
  "status.done": "已完成",
  "status.inProgress": "进行中",
  "status.todo": "待办",
  "patrol.title": "漂移巡检",
  "patrol.pending": "待检查",
  "patrol.none.before": "还没有运行漂移巡检。运行 ",
  "patrol.none.after": " 后会在这里显示结论。",
  "patrol.pass": "未发现漂移",
  "patrol.warn": "建议复核",
  "patrol.block": "发现规格漂移",
  "patrol.report": "查看报告 ↗",
  "roadmap.title": "路线图",
  "roadmap.hint": "按流分组 · supersedes = 下一个里程碑，parallel = 并行轨道",
  "consistency.title": "OpenSpec 一致性",
  "consistency.description": "这些 OpenSpec change 还没有链接到路线图任务。",
  "consistency.active": "活跃",
  "consistency.archived": "已归档",
  "empty.noStreams": "还没有流。",
  "empty.before": "运行 ",
  "empty.after": " 创建第一个流并开始维护路线图。",
  "connector.mark": "↓ 替代",
  "connector.text": "{label} 替代前一个流，并从 P1 重新开始",
  "stream.active": "活跃",
  "stream.maintained": "已维护",
  "stream.planned": "已规划",
  "stream.expand": "展开历史",
  "stream.supersedes": "· 替代 {version}",
  "parallel.label": "并行轨道",
  "phase.none": "此范围还没有阶段。",
  "task.none": "还没有任务",
  "task.showMore": "显示 {count} 个隐藏任务",
  "footer.summary": "{count} 个流 · 当前 {current} · 基于 OpenSpec 历史维护"
};

const DASHBOARD_LOCALES = { en: EN_LOCALE, zh: ZH_LOCALE };

export interface DashboardRenderOptions {
  contentLanguage?: ContentLanguage;
  writablePreferences?: boolean;
}

/**
 * Render a stream-aware, self-contained HTML dashboard.
 *
 * This function must remain a pure function of state. Validation compares this
 * output with the dashboard on disk, so rendering cannot read the current time
 * or introduce randomness. Relative times are computed in the browser only.
 */
export function renderDashboardHtml(state: SpecMartenState, options: DashboardRenderOptions = {}): string {
  const contentLanguage = options.contentLanguage ?? DEFAULT_CONTENT_LANGUAGE;
  return `<!doctype html>
<html lang="${contentLanguage === "zh" ? "zh-Hans" : "en"}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title data-i18n="page.title">${escapeHtml(EN_LOCALE["page.title"])}</title>
  <style>${STYLES}</style>
  <script>${THEME_BOOT}</script>
</head>
<body>
  <h1 class="sr-only">${i18n("page.heading")}</h1>
  ${renderTopBar()}
  <main class="shell" data-specmarten-dashboard data-content-language="${contentLanguage}" data-writable-preferences="${options.writablePreferences ? "true" : "false"}" data-auto-refresh-ms="${AUTO_REFRESH_MS}">
    ${renderHeader(state)}
    <section class="summary" aria-label="Project summary" data-i18n-aria-label="summary.aria">
      ${renderProgressCard(state)}
      ${renderPatrolCard(state)}
    </section>
    ${renderConsistencyBand(state)}
    ${renderRoadmap(state)}
    ${renderFooter(state)}
    <script type="application/json" id="specmarten-state">${escapeHtml(JSON.stringify(state))}</script>
  </main>
  <script>${DASHBOARD_BOOT}${REFRESH_COUNTDOWN_BOOT}</script>
</body>
</html>`;
}

export async function writeDashboard(
  root: string,
  state: SpecMartenState,
  options: DashboardRenderOptions = {}
): Promise<void> {
  await writeText(join(root, TOOL.dataDir, "dashboard.html"), renderDashboardHtml(state, options));
}

function resolveSupersedesVersion(state: SpecMartenState, supersedesId: string): string {
  return state.streams.find((stream) => stream.id === supersedesId)?.version ?? supersedesId;
}

function patrolDescriptor(verdict: PatrolVerdict): string {
  if (verdict === "PASS") return i18n("patrol.pass");
  if (verdict === "WARN") return i18n("patrol.warn");
  return i18n("patrol.block");
}

// Partial renderers

function renderTopBar(): string {
  const seconds = String(AUTO_REFRESH_MS / 1000);
  return `<div class="topbar" data-print-hide><div class="topbar__inner"><span class="topbar__crumb">${i18n("topbar.crumb")}</span><div class="topbar__actions"><span class="refresh-status" aria-live="polite">${i18n("refresh.label")}<span class="refresh-status__sep">·</span>${i18nTemplate("refresh.value", { seconds })}<span class="refresh-status__sep">·</span>${i18nTemplate("refresh.countdown", { seconds }, ' class="refresh-status__countdown" data-refresh-countdown')}</span><button id="locale-toggle" class="locale-toggle" type="button" aria-label="${escapeHtml(EN_LOCALE["locale.aria"])}">中文</button><button id="theme-toggle" class="theme-toggle" type="button" aria-label="${escapeHtml(EN_LOCALE["theme.aria"])}" data-i18n-aria-label="theme.aria">☾</button></div></div></div>`;
}

function renderHeader(state: SpecMartenState): string {
  const mission = state.mission ? i18nUserText(state.mission) : i18n("mission.missing");
  return `<header class="header"><div class="header__main"><div class="header__id"><span class="logo" aria-hidden="true">SM</span><span class="header__name">SpecMarten</span><span class="header__divider" aria-hidden="true"></span><span class="header__sub">${i18n("header.subtitle")}</span></div><p class="mission">${mission}</p></div></header>`;
}

function renderSegmentedBar(counts: ProgressCounts): string {
  if (counts.total === 0) return "";
  return `<span class="seg seg--done" style="flex-grow:${counts.done}"></span><span class="seg seg--wip" style="flex-grow:${counts.inProgress}"></span><span class="seg seg--todo" style="flex-grow:${counts.todo}"></span>`;
}

function renderLegend(counts: ProgressCounts): string {
  return `<li class="legend__item"><span class="dot dot--done"></span><b>${counts.done}</b> ${i18n("status.done")}</li><li class="legend__item"><span class="dot dot--wip"></span><b>${counts.inProgress}</b> ${i18n("status.inProgress")}</li><li class="legend__item"><span class="dot dot--todo"></span><b>${counts.todo}</b> ${i18n("status.todo")}</li>`;
}

function renderVersionsTimeline(state: SpecMartenState): string {
  if (state.streams.length === 0) return "";
  const items = state.streams.map((stream) => {
    if (stream.state === "active") return `<span class="vt vt--active">● ${escapeHtml(stream.version)}</span>`;
    if (stream.state === "maintained") return `<span class="vt vt--done">✓ ${escapeHtml(stream.version)}</span>`;
    return `<span class="vt vt--planned">○ ${escapeHtml(stream.version)}</span>`;
  });
  return items.join(`<span class="vt-sep" aria-hidden="true">→</span>`);
}

function renderProgressCard(state: SpecMartenState): string {
  const current = findCurrentStream(state);
  const counts = current ? deriveStreamProgress(current) : EMPTY_PROGRESS_COUNTS;
  const subhead = current
    ? i18nTemplate("progress.subhead", {
        version: current.version,
        label: current.label,
        done: String(counts.done),
        total: String(counts.total)
      })
    : i18n("progress.noCurrent");
  return `<div class="card progress-card"><div class="progress-card__head"><span class="card-label">${i18n("progress.title")}</span><span class="versions">${renderVersionsTimeline(state)}</span></div><div class="progress-card__main"><span class="progress-card__pct">${counts.progressPercent}%</span><span class="progress-card__sub">${subhead}</span></div><div class="segbar segbar--lg">${renderSegmentedBar(counts)}</div><ul class="legend">${renderLegend(counts)}</ul></div>`;
}

function renderPatrolCard(state: SpecMartenState): string {
  const patrol = state.lastPatrol ?? null;
  if (!patrol) {
    return `<div class="patrol patrol--none"><div class="patrol__head"><span class="card-label">${i18n("patrol.title")}</span></div><div class="patrol__main"><span class="patrol__dot" aria-hidden="true"></span><span class="patrol__verdict">${i18n("patrol.pending")}</span><span class="patrol__desc">${i18n("patrol.none.before")}<code>specmarten patrol</code>${i18n("patrol.none.after")}</span></div></div>`;
  }
  const verdictKey = patrol.verdict.toLowerCase();
  return `<div class="patrol patrol--${verdictKey}"><div class="patrol__head"><span class="card-label">${i18n("patrol.title")}</span></div><div class="patrol__main"><span class="patrol__dot" aria-hidden="true"></span><span class="patrol__verdict">${escapeHtml(patrol.verdict)}</span><span class="patrol__desc">${patrolDescriptor(patrol.verdict)}</span></div><div class="patrol__foot"><span class="chip chip--change">${escapeHtml(patrol.change)}</span><a class="report-link" href="${escapeHtml(safeRelativeHref(patrol.report))}">${i18n("patrol.report")}</a></div></div>`;
}

function renderConsistencyBand(state: SpecMartenState): string {
  const active = state.unlinkedActiveChanges;
  const archived = state.unlinkedChanges;
  if (active.length === 0 && archived.length === 0) {
    return "";
  }

  return `<section class="consistency" aria-label="OpenSpec consistency"><div class="consistency__head"><span class="card-label">${i18n("consistency.title")}</span><span class="consistency__desc">${i18n("consistency.description")}</span></div><div class="consistency__groups">${renderConsistencyGroup("consistency.active", active)}${renderConsistencyGroup("consistency.archived", archived)}</div></section>`;
}

function renderConsistencyGroup(labelKey: LocaleKey, changes: string[]): string {
  if (changes.length === 0) {
    return "";
  }

  return `<div class="consistency__group"><span class="consistency__label">${i18n(labelKey)}</span><div class="consistency__chips">${changes.map((change) => `<span class="chip chip--change">${escapeHtml(change)}</span>`).join("")}</div></div>`;
}

function renderRoadmap(state: SpecMartenState): string {
  const head = `<div class="roadmap__head"><h2 class="roadmap__title">${i18n("roadmap.title")}</h2><span class="roadmap__hint">${i18n("roadmap.hint")}</span></div>`;
  if (state.streams.length === 0) {
    return `<section class="roadmap" aria-label="Roadmap" data-i18n-aria-label="roadmap.title">${head}<div class="empty-state"><p>${i18n("empty.noStreams")}</p><p class="empty-hint">${i18n("empty.before")}<code>specmarten new-stream "Name"</code>${i18n("empty.after")}</p></div></section>`;
  }
  return `<section class="roadmap" aria-label="Roadmap" data-i18n-aria-label="roadmap.title">${head}<div class="streams">${state.streams.map((stream) => renderStream(stream, state)).join("")}</div></section>`;
}

function renderStream(stream: SpecMartenStream, state: SpecMartenState): string {
  const connector = stream.supersedes ? renderConnector(stream) : "";
  return connector + (stream.state === "maintained" ? renderMaintainedStream(stream) : renderStreamCard(stream, state));
}

function renderConnector(stream: SpecMartenStream): string {
  return `<div class="connector"><span class="connector__mark">${i18n("connector.mark")}</span><span class="connector__text">${i18nTemplate("connector.text", { label: stream.label })}</span></div>`;
}

function renderVersionBadge(version: string, accent: boolean): string {
  return `<span class="badge${accent ? " badge--accent" : ""}">${escapeHtml(version)}</span>`;
}

function renderStatePill(stream: SpecMartenStream): string {
  if (stream.state === "active") return `<span class="pill pill--accent">${i18n("stream.active")}</span>`;
  if (stream.state === "maintained") return `<span class="pill">${i18n("stream.maintained")}</span>`;
  return `<span class="pill">${i18n("stream.planned")}</span>`;
}

function renderMaintainedStream(stream: SpecMartenStream): string {
  const counts = deriveStreamProgress(stream);
  return `<details class="stream stream--maintained"><summary class="stream__summary"><span class="arrow" aria-hidden="true">▸</span>${renderVersionBadge(stream.version, false)}<span class="stream__label">${i18nUserText(stream.label)}</span>${renderStatePill(stream)}<span class="stream__meta"><span class="segbar segbar--mini">${renderSegmentedBar(counts)}</span><span class="stream__count">${counts.done}/${counts.total}</span><span class="stream__hint">${i18n("stream.expand")}</span></span></summary><div class="stream__body">${renderStreamBody(stream)}</div></details>`;
}

function renderStreamCard(stream: SpecMartenStream, state: SpecMartenState): string {
  const counts = deriveStreamProgress(stream);
  const supersedesTail = stream.supersedes
    ? `<span class="stream__supersedes">${i18nTemplate("stream.supersedes", { version: resolveSupersedesVersion(state, stream.supersedes) })}</span>`
    : "";
  const stateClass = stream.state === "active" ? "stream--active" : "stream--planned";
  return `<div class="stream stream--card ${stateClass}"><div class="stream__head">${renderVersionBadge(stream.version, stream.state === "active")}<span class="stream__label">${i18nUserText(stream.label)}</span>${supersedesTail}${renderStatePill(stream)}<span class="stream__meta"><span class="segbar segbar--active">${renderSegmentedBar(counts)}</span><span class="stream__pct">${counts.progressPercent}% · ${counts.done}/${counts.total}</span></span></div><div class="stream__body">${renderStreamBody(stream)}</div></div>`;
}

function renderStreamBody(stream: SpecMartenStream): string {
  const tracks = stream.tracks ?? [];
  if (tracks.length > 0) {
    return `<div class="parallel-label"><span class="parallel-dot" aria-hidden="true"></span>${i18n("parallel.label")}</div><div class="tracks">${tracks.map(renderTrack).join("")}</div>`;
  }
  return renderPhasesGrid(stream.phases ?? []);
}

function renderTrack(track: SpecMartenTrack): string {
  const counts = deriveTrackProgress(track);
  return `<div class="track"><div class="track__head"><span class="track__mark" aria-hidden="true"></span><span class="track__label">${i18nUserText(track.label)}</span><span class="track__count">${counts.done}/${counts.total}</span></div><div class="segbar segbar--track">${renderSegmentedBar(counts)}</div><div class="track__body">${renderPhasesGrid(track.phases)}</div></div>`;
}

function renderPhasesGrid(phases: SpecMartenPhase[]): string {
  if (phases.length === 0) return `<p class="empty-hint">${i18n("phase.none")}</p>`;
  return `<div class="phases-grid">${phases.map((phase, index) => renderPhase(phase, index)).join("")}</div>`;
}

function renderPhase(phase: SpecMartenPhase, index: number): string {
  const counts = derivePhaseProgress(phase);
  const status = derivePhaseStatus(counts);
  const statusLabel = status === "done" ? i18n("status.done") : status === "in-progress" ? i18n("status.inProgress") : i18n("stream.planned");
  const rows = renderPhaseTasks(phase, index);
  return `<div class="phase"><div class="phase__head"><span class="phase__code">P${index + 1}</span><span class="phase__title">${i18nUserText(phase.title)}</span><span class="sr-only">(${statusLabel})</span><div class="segbar segbar--sm">${renderSegmentedBar(counts)}</div><span class="phase__count">${counts.done}/${counts.total}</span></div><div class="phase__body">${rows}</div></div>`;
}

function renderPhaseTasks(phase: SpecMartenPhase, index: number): string {
  if (phase.tasks.length === 0) {
    return `<div class="task task--empty">${i18n("task.none")}</div>`;
  }

  if (!shouldFoldPhaseTasks(phase, index)) {
    return phase.tasks.map(renderTask).join("");
  }

  const prioritized = [...phase.tasks].sort(compareTaskPriority);
  const visible = prioritized.slice(0, EARLY_PHASE_FOLD_LIMIT);
  const hidden = prioritized.slice(EARLY_PHASE_FOLD_LIMIT);
  return `${visible.map(renderTask).join("")}<details class="task-fold"><summary class="task-fold__summary">${i18nTemplate("task.showMore", { count: String(hidden.length) })}</summary><div class="task-fold__body">${hidden.map(renderTask).join("")}</div></details>`;
}

function shouldFoldPhaseTasks(phase: SpecMartenPhase, index: number): boolean {
  return index < 2 && phase.tasks.length > EARLY_PHASE_FOLD_LIMIT;
}

function compareTaskPriority(a: SpecMartenTask, b: SpecMartenTask): number {
  return taskPriority(a) - taskPriority(b);
}

function taskPriority(task: SpecMartenTask): number {
  if (task.status === "in-progress") return 0;
  if (task.status === "todo") return 1;
  return 2;
}

function renderTask(task: SpecMartenTask): string {
  const glyph = taskGlyph(task);
  const changeStr = task.changes.join(", ");
  const chip = changeStr ? `<span class="chip">${escapeHtml(changeStr)}</span>` : "";
  return `<div class="task"><span class="task__glyph ${glyph.cls}" aria-hidden="true">${glyph.char}</span><span class="sr-only">${i18n(glyph.labelKey)}: </span><span class="task__title">${i18nUserText(task.title)}</span>${chip}</div>`;
}

function taskGlyph(task: SpecMartenTask): { char: string; cls: string; labelKey: LocaleKey } {
  if (task.status === "done") return { char: "✓", cls: "g-good", labelKey: "status.done" };
  if (task.status === "in-progress") return { char: "◐", cls: "g-accent", labelKey: "status.inProgress" };
  return { char: "○", cls: "g-faint", labelKey: "status.todo" };
}

function renderFooter(state: SpecMartenState): string {
  return `<footer class="footer"><span>${i18nTemplate("footer.summary", { count: String(state.streams.length), current: state.currentVersion || "—" })}</span></footer>`;
}

function i18n(key: LocaleKey): string {
  return `<span data-i18n="${key}">${escapeHtml(EN_LOCALE[key])}</span>`;
}

function i18nTemplate(key: LocaleKey, values: Record<string, string>, attributes = ""): string {
  const attrs = Object.entries(values)
    .map(([name, value]) => ` data-i18n-value-${name}="${escapeHtml(value)}"`)
    .join("");
  return `<span${attributes} data-i18n-template="${key}"${attrs}>${escapeHtml(interpolate(EN_LOCALE[key], values))}</span>`;
}

function i18nUserText(value: string): string {
  return `<span data-i18n-user-text="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
}

function interpolate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_, key: string) => values[key] ?? "");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeRelativeHref(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "#";
  if (trimmed.startsWith("/") || trimmed.includes("\\")) return "#";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return "#";

  const parts = trimmed.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    return "#";
  }

  return parts.join("/");
}

// Head script: set data-theme before body render to avoid theme flash.
const THEME_BOOT = `(function(){try{var k='specmarten-theme';var s=localStorage.getItem(k);var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches;var t=s||(d?'dark':'light');document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

// Body script: theme toggle, language toggle, system-theme updates, and relative <time> labels.
const DASHBOARD_BOOT = `(function(){var root=document.documentElement;var themeBtn=document.getElementById('theme-toggle');var localeBtn=document.getElementById('locale-toggle');var dashboard=document.querySelector('[data-specmarten-dashboard]');var locales=${JSON.stringify(DASHBOARD_LOCALES)};var localeKey='specmarten-dashboard-locale';function icon(){return root.getAttribute('data-theme')==='dark'?'☀':'☾';}function syncTheme(){if(themeBtn){themeBtn.textContent=icon();}}syncTheme();if(themeBtn){themeBtn.addEventListener('click',function(){var next=root.getAttribute('data-theme')==='dark'?'light':'dark';root.setAttribute('data-theme',next);try{localStorage.setItem('specmarten-theme',next);}catch(e){}syncTheme();});}function chosenTheme(){try{return !!localStorage.getItem('specmarten-theme');}catch(e){return false;}}if(window.matchMedia){try{window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change',function(e){if(chosenTheme()){return;}root.setAttribute('data-theme',e.matches?'dark':'light');syncTheme();});}catch(e){}}function defaultLocale(){var value=dashboard?dashboard.getAttribute('data-content-language'):'';return value==='zh'?'zh':'en';}function writablePreferences(){return !!dashboard&&dashboard.getAttribute('data-writable-preferences')==='true';}function getLocale(){if(writablePreferences()){return defaultLocale();}try{var stored=localStorage.getItem(localeKey);if(stored==='zh'||stored==='en'){return stored;}}catch(e){}return defaultLocale();}function persistLocale(locale){try{localStorage.setItem(localeKey,locale);}catch(e){}if(writablePreferences()&&window.fetch){try{window.fetch('/api/preferences/language',{method:'POST',headers:{'content-type':'application/json','x-specmarten-dashboard':'1'},body:JSON.stringify({contentLanguage:locale}),keepalive:true}).catch(function(){});}catch(e){}}}function tr(locale,key){return locales[locale]&&locales[locale][key]?locales[locale][key]:locales.en[key]||'';}function fill(template,el){return template.replace(/\\{([a-zA-Z0-9_-]+)\\}/g,function(_,key){return el.getAttribute('data-i18n-value-'+key)||'';});}function abs(iso,locale){var dt=new Date(iso);if(isNaN(dt.getTime())){return iso;}function p(n){return String(n).padStart(2,'0');}if(locale==='zh'){return dt.getUTCFullYear()+'年'+(dt.getUTCMonth()+1)+'月'+dt.getUTCDate()+'日 · '+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes())+' UTC';}var mon=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return mon[dt.getUTCMonth()]+' '+dt.getUTCDate()+', '+dt.getUTCFullYear()+' · '+p(dt.getUTCHours())+':'+p(dt.getUTCMinutes())+' UTC';}function rel(iso,locale){var t=Date.parse(iso);if(isNaN(t)){return iso;}var s=Math.round((Date.now()-t)/1000);if(s<0){s=0;}if(s<60){return locale==='zh'?'刚刚':'just now';}var m=Math.round(s/60);if(m<60){return locale==='zh'?m+' 分钟前':m+' min ago';}var h=Math.round(m/60);if(h<24){return locale==='zh'?h+' 小时前':h+' hr ago';}var d=Math.round(h/24);if(d===1){return locale==='zh'?'昨天':'yesterday';}if(d<30){return locale==='zh'?d+' 天前':d+' days ago';}return abs(iso,locale);}function syncTimes(locale){var nodes=document.querySelectorAll('time[data-rel]');for(var i=0;i<nodes.length;i++){var el=nodes[i];var iso=el.getAttribute('datetime');if(iso){el.textContent=rel(iso,locale);}}}function applyLocale(locale){root.lang=locale==='zh'?'zh-Hans':'en';document.title=tr(locale,'page.title');var plain=document.querySelectorAll('[data-i18n]');for(var i=0;i<plain.length;i++){var el=plain[i];var key=el.getAttribute('data-i18n');if(key){el.textContent=tr(locale,key);}}var templated=document.querySelectorAll('[data-i18n-template]');for(var j=0;j<templated.length;j++){var node=templated[j];var tkey=node.getAttribute('data-i18n-template');if(tkey){node.textContent=fill(tr(locale,tkey),node);}}var userNodes=document.querySelectorAll('[data-i18n-user-text]');for(var u=0;u<userNodes.length;u++){var userNode=userNodes[u];userNode.textContent=userNode.getAttribute('data-i18n-user-text')||'';}var aria=document.querySelectorAll('[data-i18n-aria-label]');for(var k=0;k<aria.length;k++){var item=aria[k];var akey=item.getAttribute('data-i18n-aria-label');if(akey){item.setAttribute('aria-label',tr(locale,akey));}}if(localeBtn){localeBtn.textContent=locale==='zh'?'English':'中文';localeBtn.setAttribute('aria-label',tr(locale,'locale.aria'));}syncTimes(locale);}var initialLocale=getLocale();applyLocale(initialLocale);if(localeBtn){localeBtn.addEventListener('click',function(){var next=getLocale()==='zh'?'en':'zh';persistLocale(next);applyLocale(next);if(dashboard){dashboard.setAttribute('data-content-language',next);}});}var autoRefreshMs=dashboard?Number(dashboard.getAttribute('data-auto-refresh-ms')):0;if(Number.isFinite(autoRefreshMs)&&autoRefreshMs>0){window.setTimeout(function(){window.location.reload();},autoRefreshMs);}})();`;

const REFRESH_COUNTDOWN_BOOT = `(function(){var dashboard=document.querySelector('[data-specmarten-dashboard]');var node=document.querySelector('[data-refresh-countdown]');if(!dashboard||!node){return;}var autoRefreshMs=Number(dashboard.getAttribute('data-auto-refresh-ms'));if(!Number.isFinite(autoRefreshMs)||autoRefreshMs<=0){return;}var total=Math.ceil(autoRefreshMs/1000);var started=Date.now();var labels={en:'Refresh in {seconds}s',zh:'{seconds} 秒后刷新'};function locale(){return document.documentElement.lang==='zh-Hans'?'zh':'en';}function render(){var elapsed=Math.floor((Date.now()-started)/1000);var remaining=Math.max(0,total-elapsed);node.setAttribute('data-i18n-value-seconds',String(remaining));node.textContent=labels[locale()].replace('{seconds}',String(remaining));}render();window.setInterval(render,1000);})();`;

const STYLES = `
:root{
  --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
  --mono:ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace;
  --bg:#f4f4f6;--surface:#ffffff;--surface-2:#fafafa;--inset:#f0f0f3;
  --fg:#18181b;--fg-dim:#52525b;--fg-faint:#9b9ba3;
  --line:#e8e8ec;--line-strong:#d9d9df;
  --good:#15935a;--warn:#b27a14;--block:#d23f3f;--accent:#7c5cfc;
  --good-bg:rgba(21,147,90,.10);--warn-bg:rgba(178,122,20,.12);--block-bg:rgba(210,63,63,.09);
  --good-line:rgba(21,147,90,.42);--warn-line:rgba(178,122,20,.42);--block-line:rgba(210,63,63,.42);
  --accent-bg:rgba(124,92,252,.10);--accent-fg:#ffffff;
  --shadow:0 1px 2px rgba(24,24,27,.05),0 1px 3px rgba(24,24,27,.05);
  color-scheme:light;
}
:root[data-theme="dark"]{
  --bg:#0b0b0d;--surface:#141417;--surface-2:#1a1a1e;--inset:#0f0f12;
  --fg:#f4f4f5;--fg-dim:#a1a1aa;--fg-faint:#6f6f78;
  --line:#26262b;--line-strong:#34343b;
  --good:#34d17e;--warn:#e3ab43;--block:#f0666b;--accent:#a38dfd;
  --good-bg:rgba(52,209,126,.13);--warn-bg:rgba(227,171,67,.14);--block-bg:rgba(240,102,107,.14);
  --good-line:rgba(52,209,126,.5);--warn-line:rgba(227,171,67,.5);--block-line:rgba(240,102,107,.5);
  --accent-bg:rgba(124,92,252,.20);--accent-fg:#17171b;
  --shadow:0 1px 2px rgba(0,0,0,.5),0 1px 3px rgba(0,0,0,.3);
  color-scheme:dark;
}
*{box-sizing:border-box;}
html,body{margin:0;}
body{background:var(--bg);color:var(--fg);font-family:var(--sans);-webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;min-height:100vh;}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}
code{font-family:var(--mono);}
a{color:var(--accent);text-decoration:none;}
a:hover{text-decoration:underline;}

.topbar{position:sticky;top:0;z-index:20;background:var(--bg);border-bottom:1px solid var(--line);}
.topbar__inner{max-width:1180px;margin:0 auto;padding:9px 24px;display:flex;align-items:center;justify-content:space-between;gap:16px;}
.topbar__crumb{font-family:var(--mono);font-size:11px;color:var(--fg-faint);letter-spacing:.04em;}
.topbar__actions{display:flex;align-items:center;gap:8px;}
.refresh-status{height:30px;border:1px solid var(--line);border-radius:8px;padding:0 9px;display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:10px;color:var(--fg-faint);white-space:nowrap;}
.refresh-status__sep{color:var(--line-strong);}
.refresh-status__countdown{color:var(--fg-dim);font-weight:650;}
.locale-toggle,.theme-toggle{appearance:none;height:30px;border-radius:8px;border:1px solid var(--line-strong);background:var(--surface);color:var(--fg-dim);font-size:13px;line-height:1;cursor:pointer;}
.locale-toggle{min-width:54px;padding:0 10px;font-weight:650;}
.theme-toggle{width:32px;font-size:14px;}
.locale-toggle:hover,.theme-toggle:hover{border-color:var(--accent);color:var(--accent);}

.shell{max-width:1180px;margin:0 auto;padding:30px 32px 36px;}
.header{display:grid;grid-template-columns:minmax(0,1fr);align-items:start;gap:24px;}
.header__main{min-width:0;}
.header__id{display:flex;align-items:center;gap:12px;flex-wrap:wrap;}
.logo{width:30px;height:30px;border-radius:8px;background:var(--accent);color:var(--accent-fg);font-weight:700;font-size:12px;letter-spacing:-.01em;display:inline-flex;align-items:center;justify-content:center;}
.header__name{font-size:19px;font-weight:650;letter-spacing:-.02em;}
.header__divider{width:1px;height:16px;background:var(--line-strong);}
.header__sub{font-size:12px;color:var(--fg-dim);}
.mission{font-size:13px;line-height:1.55;color:var(--fg-dim);max-width:720px;margin:11px 0 0;overflow-wrap:anywhere;}
.card-label{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-faint);font-weight:700;}
.summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(330px,100%),1fr));gap:16px;margin-top:26px;}
.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px 24px;box-shadow:var(--shadow);}
.progress-card__head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.versions{font-family:var(--mono);font-size:11px;display:flex;align-items:center;flex-wrap:wrap;}
.vt{display:inline-flex;align-items:center;}
.vt--active{color:var(--accent);font-weight:700;}
.vt--done{color:var(--good);}
.vt--planned{color:var(--fg-faint);}
.vt-sep{color:var(--line-strong);margin:0 5px;}
.progress-card__main{display:flex;align-items:baseline;gap:11px;margin-top:15px;flex-wrap:wrap;}
.progress-card__pct{font-size:42px;font-weight:680;letter-spacing:-.035em;line-height:.9;}
.progress-card__sub{font-size:13px;color:var(--fg-dim);min-width:0;overflow-wrap:anywhere;}

.segbar{display:flex;border-radius:6px;overflow:hidden;background:var(--inset);}
.segbar--lg{height:10px;margin-top:18px;}
.segbar--active{width:120px;max-width:100%;height:7px;}
.segbar--mini{width:96px;height:6px;}
.segbar--track{height:5px;margin-top:10px;}
.segbar--sm{width:54px;height:5px;}
.seg{height:100%;}
.seg--done{background:var(--good);}
.seg--wip{background:var(--accent);}
.seg--todo{background:var(--line-strong);}
.legend{list-style:none;display:flex;gap:20px;flex-wrap:wrap;margin:15px 0 0;padding:0;}
.legend__item{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--fg-dim);}
.legend__item b{color:var(--fg);font-weight:600;}
.dot{width:9px;height:9px;border-radius:3px;display:inline-block;}
.dot--done{background:var(--good);}
.dot--wip{background:var(--accent);}
.dot--todo{background:var(--line-strong);}

.patrol{border:1px solid var(--verdict-line);background:var(--verdict-bg);border-radius:14px;padding:22px 24px;}
.patrol--pass{--verdict:var(--good);--verdict-bg:var(--good-bg);--verdict-line:var(--good-line);}
.patrol--warn{--verdict:var(--warn);--verdict-bg:var(--warn-bg);--verdict-line:var(--warn-line);}
.patrol--block{--verdict:var(--block);--verdict-bg:var(--block-bg);--verdict-line:var(--block-line);}
.patrol--none{--verdict:var(--fg-faint);--verdict-bg:var(--inset);--verdict-line:var(--line);}
.patrol__head{display:flex;align-items:center;justify-content:space-between;gap:12px;}
.patrol__main{display:flex;align-items:center;gap:13px;margin-top:15px;flex-wrap:wrap;}
.patrol__dot{width:13px;height:13px;border-radius:50%;background:var(--verdict);box-shadow:0 0 0 4px var(--verdict-bg);flex-shrink:0;}
.patrol__verdict{font-size:42px;font-weight:720;letter-spacing:-.03em;color:var(--verdict);line-height:.9;}
.patrol__desc{font-size:13px;color:var(--fg-dim);align-self:flex-end;padding-bottom:4px;}
.patrol__foot{display:flex;align-items:center;gap:10px;margin-top:18px;flex-wrap:wrap;}
.report-link{font-size:12px;font-weight:600;}

.consistency{margin-top:16px;background:var(--warn-bg);border:1px solid var(--warn-line);border-radius:14px;padding:18px 20px;}
.consistency__head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;}
.consistency__desc{font-size:12px;color:var(--fg-dim);}
.consistency__groups{display:flex;flex-direction:column;gap:10px;margin-top:13px;}
.consistency__group{display:grid;grid-template-columns:90px minmax(0,1fr);gap:12px;align-items:start;}
.consistency__label{font-size:12px;font-weight:650;color:var(--warn);}
.consistency__chips{display:flex;gap:7px;flex-wrap:wrap;min-width:0;}

.badge{font-family:var(--mono);font-size:12px;font-weight:700;color:var(--fg-dim);background:var(--inset);border:1px solid var(--line-strong);border-radius:7px;padding:3px 9px;flex-shrink:0;}
.badge--accent{color:var(--accent-fg);background:var(--accent);border-color:var(--accent);}
.pill{font-size:11px;font-weight:600;padding:3px 11px;border-radius:999px;background:var(--inset);color:var(--fg-dim);flex-shrink:0;}
.pill--accent{background:var(--accent-bg);color:var(--accent);}
.chip{font-family:var(--mono);font-size:10px;color:var(--fg-dim);background:var(--inset);border:1px solid var(--line);border-radius:5px;padding:2px 6px;max-width:100%;overflow-wrap:anywhere;white-space:normal;}
.chip--change{font-size:12px;color:var(--fg);background:var(--surface);}

.roadmap{margin-top:30px;}
.roadmap__head{display:flex;align-items:baseline;justify-content:space-between;margin-bottom:14px;gap:12px;flex-wrap:wrap;}
.roadmap__title{font-size:14px;font-weight:650;margin:0;}
.roadmap__hint{font-size:12px;color:var(--fg-dim);}
.streams{display:flex;flex-direction:column;gap:10px;}

.connector{display:flex;align-items:center;gap:10px;padding:1px 0 1px 10px;flex-wrap:wrap;}
.connector__mark{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--accent);}
.connector__text{font-size:11.5px;color:var(--fg-faint);}

.stream{background:var(--surface);border:1px solid var(--line);border-radius:13px;box-shadow:var(--shadow);overflow:hidden;}
.stream__head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid var(--line);flex-wrap:wrap;}
.stream__label{font-size:15px;font-weight:650;letter-spacing:-.01em;min-width:0;overflow-wrap:anywhere;line-height:1.35;}
.stream__supersedes{font-family:var(--mono);font-size:11px;color:var(--fg-faint);}
.stream__meta{margin-left:auto;display:flex;align-items:center;gap:11px;flex-wrap:wrap;}
.stream__pct{font-family:var(--mono);font-size:12px;color:var(--fg-dim);}
.stream__count{font-family:var(--mono);font-size:12px;color:var(--fg-dim);}
.stream__hint{font-size:11px;color:var(--fg-faint);}
.stream__body{padding:16px 18px;}

.parallel-label{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--fg-faint);font-weight:600;margin-bottom:13px;display:flex;align-items:center;gap:8px;}
.parallel-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);}
.tracks{display:flex;flex-direction:column;gap:13px;}
.track{border:1px solid var(--line);border-radius:11px;background:var(--surface-2);padding:14px 15px;}
.track__head{display:flex;align-items:center;gap:9px;}
.track__mark{width:9px;height:9px;border-radius:3px;background:var(--accent);flex-shrink:0;}
.track__label{font-size:13px;font-weight:650;flex:1;min-width:0;overflow-wrap:anywhere;line-height:1.35;}
.track__count{font-family:var(--mono);font-size:11px;color:var(--fg-dim);}
.track__body{margin-top:12px;}

.phases-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(248px,100%),1fr));gap:10px;}
.phase{background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden;}
.phase__head{display:flex;align-items:flex-start;gap:11px;padding:11px 14px;}
.phase__code{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--fg-faint);width:20px;flex-shrink:0;}
.phase__title{font-size:13px;font-weight:600;flex:1;min-width:0;letter-spacing:-.01em;line-height:1.35;overflow-wrap:anywhere;}
.phase__count{font-family:var(--mono);font-size:11px;color:var(--fg-dim);width:26px;text-align:right;flex-shrink:0;}
.phase__body{border-top:0;}
.task{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:10px;row-gap:6px;align-items:flex-start;padding:8px 14px;border-top:1px solid var(--line);}
.task__glyph{font-size:12px;width:15px;text-align:center;line-height:1.45;}
.g-good{color:var(--good);}
.g-accent{color:var(--accent);}
.g-faint{color:var(--fg-faint);}
.task__title{font-size:12.5px;min-width:0;overflow-wrap:anywhere;white-space:normal;line-height:1.42;}
.task .chip{grid-column:2;justify-self:start;}
.task--empty{display:block;color:var(--fg-faint);font-size:12px;}
.task-fold{border-top:1px solid var(--line);background:var(--surface-2);}
.task-fold__summary{list-style:none;cursor:pointer;padding:8px 14px 8px 39px;font-size:11px;font-weight:650;color:var(--accent);}
.task-fold__summary::-webkit-details-marker{display:none;}
.task-fold__summary:hover{text-decoration:underline;}
.task-fold__body{border-top:1px solid var(--line);}

.stream--maintained > summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:12px;padding:15px 18px;outline:none;}
.stream--maintained > summary::-webkit-details-marker{display:none;}
.stream--maintained > summary:hover .arrow{color:var(--accent);}
.stream__summary .stream__label{font-size:14px;}
.arrow{display:inline-block;transition:transform .15s ease;color:var(--fg-faint);font-size:11px;}
details[open] .arrow{transform:rotate(90deg);}

.empty-state{background:var(--surface);border:1px dashed var(--line-strong);border-radius:13px;padding:24px;text-align:center;color:var(--fg-dim);}
.empty-state p{margin:0 0 6px;}
.empty-hint{font-size:12px;color:var(--fg-faint);margin:0;}

.footer{margin-top:26px;padding-top:14px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:12px;font-size:11px;color:var(--fg-faint);font-family:var(--mono);flex-wrap:wrap;}

@media (max-width:760px){
  .shell{padding:22px 16px 28px;}
  .topbar__inner{padding:9px 16px;}
  .refresh-status{display:none;}
  .header{grid-template-columns:1fr;}
  .consistency__group{grid-template-columns:1fr;gap:6px;}
}
@media print{ [data-print-hide]{display:none!important;} details > *:not(summary){display:block!important;} }
`;
