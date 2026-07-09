import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../src/core/renderers/dashboard.js";
import type { SpecMartenState } from "../src/core/state/schema.js";

describe("dashboard renderer", () => {
  it("renders streams, supersedes connectors, tracks, phases, and task glyphs", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).toContain("data-specmarten-dashboard");
    expect(html).toContain("Account access");
    expect(html).toContain("<details class=\"stream stream--maintained\">");
    expect(html).toContain("Status reporting");
    expect(html).toContain("↓ supersedes");
    expect(html).toContain("Status reporting supersedes the previous stream and restarts at P1");
    expect(html).toContain("· supersedes v1");
    expect(html).toContain("Account lane");
    expect(html).toContain("Operations lane");
    expect(html).toContain("Status shell");
    expect(html).toContain("Publish account status");
    expect(html).toContain("✓");
    expect(html).toContain("◐");
    expect(html).toContain("○");
  });

  it.each(["PASS", "WARN", "BLOCK"] as const)("renders %s patrol verdict styling and report link", (verdict) => {
    const html = renderDashboardHtml(exampleState(verdict));

    expect(html).toContain(`patrol--${verdict.toLowerCase()}`);
    expect(html).toContain(`>${verdict}<`);
    expect(html).toContain("drift-check");
    expect(html).toContain("reports/drift-check.md");
  });

  it("forces unsafe patrol report hrefs to inert relative links", () => {
    const state = exampleState("WARN");
    const html = renderDashboardHtml({
      ...state,
      lastPatrol: state.lastPatrol ? { ...state.lastPatrol, report: "javascript:alert(1)" } : null
    });

    expect(html).toContain("href=\"#\"");
    expect(html).not.toContain("href=\"javascript:");
  });

  it("renders an empty patrol state without a broken report link", () => {
    const state = exampleState("PASS");
    const html = renderDashboardHtml({ ...state, lastPatrol: null });

    expect(html).toContain("patrol--none");
    expect(html).toContain("Pending");
    expect(html).toContain("specmarten patrol");
    expect(html).not.toContain("class=\"report-link\"");
  });

  it("is self-contained and theme-aware", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
    expect(html).toContain("id=\"specmarten-state\"");
    expect(html).toContain("localStorage.getItem(k)");
    expect(html).toContain("specmarten-theme");
    expect(html).toContain("prefers-color-scheme");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("<link");
    expect(html).not.toContain("<img");
  });

  it("ships a Chinese dashboard language toggle for chrome and supported state text", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).toContain("id=\"locale-toggle\"");
    expect(html).toContain("specmarten-dashboard-locale");
    expect(html).toContain("data-content-language=\"en\"");
    expect(html).toContain("data-writable-preferences=\"false\"");
    expect(html).toContain("项目状态看板");
    expect(html).toContain("当前流进度");
    expect(html).toContain("漂移巡检");
    expect(html).toContain("路线图");
    expect(html).toContain("data-i18n-template=\"progress.subhead\"");
    expect(html).toContain("data-i18n-user-text=\"Status reporting\"");
    expect(html).not.toContain("userTextLocales");
  });

  it("can render a writable Chinese dashboard preference bridge", () => {
    const html = renderDashboardHtml(exampleState("PASS"), { contentLanguage: "zh", writablePreferences: true });

    expect(html).toContain("<html lang=\"zh-Hans\">");
    expect(html).toContain("data-content-language=\"zh\"");
    expect(html).toContain("data-writable-preferences=\"true\"");
    expect(html).toContain("/api/preferences/language");
    expect(html).toContain("'x-specmarten-dashboard':'1'");
    expect(html).toContain("JSON.stringify({contentLanguage:locale})");
    expect(html).toContain("userNode.textContent=userNode.getAttribute('data-i18n-user-text')");
  });

  it("includes static auto-refresh behavior", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).toContain("data-auto-refresh-ms=\"60000\"");
    expect(html).toContain("data-refresh-countdown");
    expect(html).toContain("Auto refresh");
    expect(html).toContain("自动刷新");
    expect(html).toContain("Refresh in 60s");
    expect(html).toContain("秒后刷新");
    expect(html).toContain("window.setInterval(render,1000)");
    expect(html).toContain("window.setTimeout(function(){window.location.reload();},autoRefreshMs)");
  });

  it("omits page-level last-updated chrome while keeping state metadata", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).not.toContain("Last updated");
    expect(html).not.toContain("最后更新");
    expect(html).not.toContain("data-i18n-template=\"footer.updated\"");
    expect(html).not.toContain("Updated Jun 30");
    expect(html).not.toContain("class=\"header__updated\"");
    expect(html).toContain("&quot;updatedAt&quot;:&quot;2026-06-30T00:00:00.000Z&quot;");
  });

  it("omits patrol recency chrome while keeping patrol timestamp metadata", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).not.toContain("Latest");
    expect(html).not.toContain("最新");
    expect(html).not.toContain("class=\"patrol__time\"");
    expect(html).not.toContain("<time datetime=\"2026-06-30T00:00:00.000Z\"");
    expect(html).toContain("&quot;at&quot;:&quot;2026-06-30T00:00:00.000Z&quot;");
  });

  it("folds oversized P1/P2 task lists and prioritizes unfinished tasks", () => {
    const state = exampleState("PASS");
    const phase = state.streams[1]?.tracks?.[0]?.phases[0];
    expect(phase).toBeTruthy();
    phase!.tasks = [
      { id: "done-a", title: "Completed setup", status: "done", changes: ["setup"] },
      { id: "todo-a", title: "Backfill empty state", status: "todo", changes: [] },
      { id: "done-b", title: "Completed metrics", status: "done", changes: ["metrics"] },
      { id: "wip-a", title: "Wire alert countdown", status: "in-progress", changes: ["countdown"] },
      { id: "todo-b", title: "Fold old tasks", status: "todo", changes: ["folding"] },
      { id: "done-c", title: "Completed review", status: "done", changes: ["review"] }
    ];

    const html = renderDashboardHtml(state);

    expect(html).toContain("<details class=\"task-fold\">");
    expect(html).toContain("Show 2 hidden tasks");
    expect(html).toContain("\"task.showMore\":\"显示 {count} 个隐藏任务\"");
    expect(html.indexOf("Wire alert countdown")).toBeLessThan(html.indexOf("Backfill empty state"));
    expect(html.indexOf("Backfill empty state")).toBeLessThan(html.indexOf("Completed setup"));
    expect(html.indexOf("Completed metrics")).toBeGreaterThan(html.indexOf("task-fold__body"));
  });

  it("renders OpenSpec consistency issues when active or archived changes are unlinked", () => {
    const html = renderDashboardHtml({
      ...exampleState("WARN"),
      unlinkedActiveChanges: ["restore-high-fidelity-analysis-flow"],
      unlinkedChanges: ["serve-self-hosted-readiness-mode"]
    });

    expect(html).toContain("OpenSpec Consistency");
    expect(html).toContain("These OpenSpec changes are not linked to a roadmap task yet.");
    expect(html).toContain("restore-high-fidelity-analysis-flow");
    expect(html).toContain("serve-self-hosted-readiness-mode");
    expect(html).toContain("OpenSpec 一致性");
  });

  it("wraps long roadmap text instead of truncating it with ellipsis", () => {
    const html = renderDashboardHtml(exampleState("PASS"));

    expect(html).toContain("grid-template-columns:repeat(auto-fit,minmax(min(248px,100%),1fr))");
    expect(html).toContain(".task{display:grid;grid-template-columns:auto minmax(0,1fr);");
    expect(html).toContain(".task__title{font-size:12.5px;min-width:0;overflow-wrap:anywhere;white-space:normal;line-height:1.42;}");
    expect(html).toContain(".task .chip{grid-column:2;justify-self:start;}");
    expect(html).not.toContain("text-overflow:ellipsis");
  });

  it("renders a nonblank empty roadmap state", () => {
    const html = renderDashboardHtml({
      version: 2,
      updatedAt: "2026-06-30T00:00:00.000Z",
      mission: "Empty state",
      currentVersion: "",
      streams: [],
      lastPatrol: null,
      baseline: null,
      unlinkedActiveChanges: [],
      unlinkedChanges: []
    });

    expect(html).toContain("SpecMarten Project Status Dashboard");
    expect(html).toContain("No streams yet");
    expect(html).toContain("specmarten new-stream");
    expect(html).toContain("id=\"specmarten-state\"");
  });

  it("covers the canonical mixed-stream design fixture", async () => {
    const fixture = JSON.parse(
      await readFile(new URL("./fixtures/mixed-stream-state.json", import.meta.url), "utf8")
    ) as SpecMartenState;
    const html = renderDashboardHtml(fixture);

    expect(html).toContain("✓ v1");
    expect(html).toContain("● v2");
    expect(html).toContain("v2 · Status reporting · 1/3 tasks");
    expect(html).toContain("Parallel tracks");
    expect(html).toContain("Account lane");
    expect(html).toContain("Operations lane");
    expect(html).toContain("id=\"specmarten-state\"");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
  });
});

function exampleState(verdict: "PASS" | "WARN" | "BLOCK"): SpecMartenState {
  return {
    version: 2,
    updatedAt: "2026-06-30T00:00:00.000Z",
    mission: "Improve account status visibility for support teams.",
    currentVersion: "v2",
    streams: [
      {
        id: "account",
        version: "v1",
        label: "Account access",
        state: "maintained",
        phases: [
        {
          id: "account-p1",
          title: "Account basics",
          status: "done",
          tasks: [{ id: "account-1", title: "Create sign-in flow", status: "done", changes: ["account-login"] }]
        },
        {
          id: "status-page-polish",
          title: "Status Page Polish",
          status: "done",
          tasks: [
            {
              id: "status-summary-copy",
              title: "Clarify status summary copy for support staff",
              status: "done",
              changes: ["status-page"]
            },
            {
              id: "status-filtering",
              title: "Add filtering for open account issues",
              status: "done",
              changes: ["status-page"]
            },
            {
              id: "status-wrapping",
              title: "Wrap long account notes on desktop and mobile",
              status: "done",
              changes: ["status-page"]
            },
            {
              id: "status-review-notes",
              title: "Add review notes for support escalation",
              status: "done",
              changes: ["status-page"]
            }
          ]
        },
        {
          id: "support-handoff",
          title: "Support Handoff",
          status: "in-progress",
          tasks: [
            {
              id: "handoff-notes",
              title:
                "Collect account context, status notes, and next owner before escalation",
              status: "in-progress",
              changes: ["support-handoff"]
            }
          ]
        }
      ]
    },
      {
        id: "status",
        version: "v2",
        label: "Status reporting",
        state: "active",
        supersedes: "account",
        tracks: [
          {
            id: "account-lane",
            label: "Account lane",
            phases: [
              {
                id: "status-p1",
                title: "Status shell",
                status: "in-progress",
                tasks: [
                  { id: "status-1", title: "Publish account status", status: "in-progress", changes: ["status-page"] },
                  { id: "status-2", title: "Show empty state", status: "todo", changes: [] }
                ]
              }
            ]
          },
          {
            id: "operations",
            label: "Operations lane",
            phases: [
              {
                id: "status-p2",
                title: "Review cards",
                status: "done",
                tasks: [{ id: "status-3", title: "Show support verdict", status: "done", changes: ["review-card"] }]
              }
            ]
          }
        ]
      }
    ],
    lastPatrol: {
      change: "drift-check",
      verdict,
      report: "reports/drift-check.md",
      at: "2026-06-30T00:00:00.000Z"
    },
    baseline: null,
    unlinkedActiveChanges: [],
    unlinkedChanges: []
  };
}
