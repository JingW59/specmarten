import { join } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SpecMartenConfig } from "../../config/config.js";
import { readContentLanguage, writeContentLanguage } from "../../config/config.js";
import { TOOL } from "../../constants.js";
import { contentLanguageSchema, type ContentLanguage } from "../content-language.js";
import { runProcess } from "../../util/process.js";
import { renderViews } from "../renderers/index.js";
import { renderDashboardHtml } from "../renderers/dashboard.js";
import { readState } from "../state/store.js";

const DASHBOARD_WRITE_HEADER = "x-specmarten-dashboard";

export interface DashboardOptions {
  root: string;
  config: SpecMartenConfig;
  buildOnly?: boolean;
  serve?: boolean;
  port?: number;
}

export interface DashboardSummary {
  dashboardPath: string;
  opened: boolean;
  url?: string;
  close?: () => Promise<void>;
}

export async function runDashboard(options: DashboardOptions): Promise<DashboardSummary> {
  const state = await readState(options.root);
  await renderViews(options.root, state);
  const dashboardPath = join(options.root, TOOL.dataDir, "dashboard.html");
  const shouldOpen = !options.buildOnly && options.config.dashboard.autoOpen;

  if (options.serve) {
    const server = await startDashboardServer(options.root, options.port ?? 0);
    if (shouldOpen) {
      await openFile(server.url);
    }

    return {
      dashboardPath,
      opened: shouldOpen,
      url: server.url,
      close: server.close
    };
  }

  if (shouldOpen) {
    await openFile(dashboardPath);
  }

  return {
    dashboardPath,
    opened: shouldOpen
  };
}

interface DashboardServer {
  url: string;
  close: () => Promise<void>;
}

async function startDashboardServer(root: string, port: number): Promise<DashboardServer> {
  const server = createServer((request, response) => {
    handleDashboardRequest(root, request, response).catch((error) => {
      response.statusCode = error instanceof DashboardBadRequestError ? 400 : 500;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}

async function handleDashboardRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard.html")) {
    const [state, contentLanguage] = await Promise.all([readState(root), readContentLanguage(root)]);
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(renderDashboardHtml(state, { contentLanguage, writablePreferences: true }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/preferences/language") {
    if (!isAllowedPreferenceWriteRequest(request)) {
      response.statusCode = 403;
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: "Forbidden" }));
      return;
    }

    const contentLanguage = await readPreferenceContentLanguage(request);
    await writeContentLanguage(root, contentLanguage);
    await renderViews(root, await readState(root));
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ contentLanguage }));
    return;
  }

  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end("Not found");
}

async function readPreferenceContentLanguage(request: IncomingMessage): Promise<ContentLanguage> {
  try {
    const body = await readRequestBody(request);
    const payload = JSON.parse(body || "{}") as { contentLanguage?: unknown };
    return contentLanguageSchema.parse(payload.contentLanguage);
  } catch {
    throw new DashboardBadRequestError("Invalid dashboard preference request.");
  }
}

class DashboardBadRequestError extends Error {}

export function isAllowedPreferenceWriteRequest(request: Pick<IncomingMessage, "headers">): boolean {
  return (
    headerValue(request.headers[DASHBOARD_WRITE_HEADER]) === "1" &&
    isLocalHostHeader(headerValue(request.headers.host)) &&
    isAllowedOriginHeader(headerValue(request.headers.origin), headerValue(request.headers.host))
  );
}

function isAllowedOriginHeader(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.protocol === "http:" && isLocalHostName(parsed.hostname) && (!host || parsed.host === host);
  } catch {
    return false;
  }
}

function isLocalHostHeader(host: string | undefined): boolean {
  if (!host) {
    return false;
  }

  const hostname = host.split(":")[0]?.toLowerCase();
  return isLocalHostName(hostname);
}

function isLocalHostName(hostname: string | undefined): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (chunks.reduce((sum, item) => sum + item.length, 0) > 1024) {
      throw new Error("Request body too large.");
    }
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function openFile(path: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", path] : [path];
  await runProcess(command, args);
}
