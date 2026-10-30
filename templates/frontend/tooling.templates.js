"use strict";

/**
 * Frontend tooling files: package.json, tsconfig, Vite config, entry points,
 * application shell, shared components and API client.
 */

function packageJson(ctx) {
  return JSON.stringify(
    {
      name: ctx.app.name + "-ui",
      private: true,
      version: "1.0.0",
      scripts: {
        dev: "next dev -p 3030",
        build: "next build",
        start: "next start -p 3030",
        lint: "next lint",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        next: "^15.5.0",
        react: "^19.1.1",
        "react-dom": "^19.1.1",
      },
      devDependencies: {
        "@types/node": "^22.10.0",
        "@types/react": "^19.1.0",
        "@types/react-dom": "^19.1.0",
        typescript: "~5.9.2",
      },
      engines: { node: ">=20" },
    },
    null,
    2,
  );
}

function tsconfig() {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "preserve",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    },
    null,
    2,
  );
}

function nextConfig() {
  return `import type { NextConfig } from 'next';

// The UI talks to the NestJS API. Override with NEXT_PUBLIC_API_URL when the
// API is not reachable at this origin (e.g. behind a different gateway).
const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
`;
}

function nextEnvTypes() {
  return `/// <reference types="next" />
/// <reference types="next/image-types/global" />

// NOTE: This file should not be edited — see https://nextjs.org/docs/app/api-reference/config/typescript
`;
}





function indexHtml(ctx) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#0f766e" />
    <title>${escapeHtml(ctx.app.ui.title)}</title>
  </head>
  <body />
</html>
`;
}

function apiClient(ctx) {
  return `/**
 * Central API configuration.
 *
 * NEXT_PUBLIC_API_URL: absolute API base (e.g. https://api.example.com).
 * When unset, requests use the same origin under the API prefix
 * (${ctx.app.urlPrefix(false)}), which the Next.js config proxies to the NestJS server.
 */
const explicitBase = (process.env.NEXT_PUBLIC_API_URL ?? '').replace(/\\/+$/, '');
const apiPrefix = '${ctx.app.urlPrefix(false)}';

export const TOKEN_STORAGE_KEY = 'chemicalist.access-token';

export function getToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  if (token) window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function apiUrl(path: string): string {
  const normalized = path.startsWith('/') ? path : '/' + path;
  return explicitBase ? explicitBase + normalized : apiPrefix + normalized;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

let unauthorizedHandler: (() => void) | undefined;

/** Registered by the auth provider so a 401 everywhere returns to the login screen. */
export function onUnauthorized(handler: () => void): void {
  unauthorizedHandler = handler;
}

export async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;

  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the API at ' + apiUrl(path) + '. Is the backend running?', error);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { code?: string; message?: string; details?: unknown };
    if (response.status === 401) unauthorizedHandler?.();
    const message = typeof record.message === 'string' ? record.message : 'Request failed with status ' + response.status;
    throw new ApiError(response.status, record.code ?? 'REQUEST_FAILED', message, record.details);
  }

  return payload as T;
}

/** Converts Fastify/Nest validation details into a flat list of messages. */
export function errorMessages(error: unknown): string[] {
  if (error instanceof ApiError) {
    const details = error.details as { issues?: Array<{ path?: Array<string | number>; message?: string }> } | undefined;
    if (details?.issues?.length) {
      return details.issues.map((issue) => (issue.path?.join('.') ?? 'field') + ': ' + (issue.message ?? 'invalid value'));
    }
    if (Array.isArray(error.details)) return error.details.map(String);
    return [error.message];
  }
  return [error instanceof Error ? error.message : String(error)];
}
`;
}

function apiServer(ctx) {
  return `/**
 * Server-side API client used by Server Components.
 *
 * Requests are forwarded to the NestJS API. Next.js does not forward the
 * browser's cookies/tokens automatically, so the bearer token is read from a
 * cookie (set at login) or from the API_TOKEN environment variable.
 */
import { cookies } from 'next/headers';

const apiBase = (process.env.API_URL ?? 'http://localhost:${ctx.app.api.port}').replace(/\\/+$/, '');
const apiPrefix = '${ctx.app.urlPrefix(false)}';

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

async function authToken(): Promise<string | null> {
  if (process.env.API_TOKEN) return process.env.API_TOKEN;
  try {
    const store = await cookies();
    return store.get('chemicalist.access-token')?.value ?? null;
  } catch {
    return null;
  }
}

export async function serverRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const normalized = path.startsWith('/') ? path : '/' + path;
  const url = apiBase + apiPrefix + normalized;
  const token = await authToken();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.Authorization = 'Bearer ' + token;

  const response = await fetch(url, {
    ...init,
    headers,
    cache: 'no-store',
  });

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const record = (payload ?? {}) as { code?: string; message?: string };
    throw new ServerApiError(
      response.status,
      record.code ?? 'REQUEST_FAILED',
      typeof record.message === 'string' ? record.message : 'Request failed with status ' + response.status,
    );
  }

  return payload as T;
}
`;
}

function apiTypes() {
  return `import type { JsonValue } from './json';

/** Envelope returned by every list endpoint. */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface SessionPayload {
  accessToken: string;
  expiresIn: string;
}

export interface TokenClaims {
  sub: string;
  email: string;
  roles: string[];
  tenantId?: string;
  exp: number;
}

export type { JsonValue };
`;
}

function jsonType() {
  return `export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
`;
}

function layout(ctx) {
  return `import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './styles.css';
import { AuthProvider } from './components/providers';

export const metadata: Metadata = {
  title: '${escapeHtml(ctx.app.ui.title)}',
  description: '${escapeHtml(ctx.app.description || ctx.app.ui.title)}',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
`;
}

function providers() {
  return `'use client';

import type { ReactNode } from 'react';
import { AuthProvider as AuthStateProvider } from '../auth/AuthContext';

/** Client-side providers mounted once for the whole application. */
export function AuthProvider({ children }: { children: ReactNode }) {
  return <AuthStateProvider>{children}</AuthStateProvider>;
}
`;
}

function styles(ctx) {
  const colors = {
    background: "#f6f7f9",
    surface: "#ffffff",
    surfaceMuted: "#f1f5f9",
    border: "#e2e8f0",
    text: "#0f172a",
    textMuted: "#64748b",
    primary: "#0f766e",
    primaryHover: "#115e59",
    danger: "#b91c1c",
    dangerBackground: "#fef2f2",
    success: "#15803d",
    successBackground: "#f0fdf4",
    warning: "#b45309",
    warningBackground: "#fffbeb",
    ...(ctx.app.ui.theme.colors || {}),
  };
  const variables = [
    ["bg", "background"],
    ["surface", "surface"],
    ["surface-muted", "surfaceMuted"],
    ["border", "border"],
    ["text", "text"],
    ["text-muted", "textMuted"],
    ["primary", "primary"],
    ["primary-hover", "primaryHover"],
    ["danger", "danger"],
    ["danger-bg", "dangerBackground"],
    ["success", "success"],
    ["success-bg", "successBackground"],
    ["warning", "warning"],
    ["warning-bg", "warningBackground"],
  ];
  const theme = ctx.app.ui.theme;
  const fontFamily =
    theme.typography.fontFamily ||
    "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
  const baseFontSize = theme.typography.baseFontSize || "15px";
  return `:root {
${variables.map(([name, key]) => `  --${name}: ${colors[key]};`).join("\n")}
  --radius: ${theme.radius || "10px"};
  --shadow: 0 1px 2px rgba(15, 23, 42, 0.06), 0 4px 12px rgba(15, 23, 42, 0.04);
  color-scheme: light;
}

* { box-sizing: border-box; }

html, body, #root { height: 100%; }

body {
  margin: 0;
  font-family: ${fontFamily};
  background: var(--bg);
  color: var(--text);
  font-size: ${baseFontSize};
  line-height: 1.5;
}

a { color: var(--primary); text-decoration: none; }
a:hover { text-decoration: underline; }

button, input, select, textarea { font: inherit; color: inherit; }

/* ---------- shell ---------- */
.shell { display: grid; grid-template-columns: 264px 1fr; min-height: 100%; }
.sidebar {
  background: #0b2b2a;
  color: #e2e8f0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 20px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
.sidebar__brand { font-weight: 700; font-size: 1.05rem; padding: 0 10px 16px; color: #fff; letter-spacing: .01em; }
.sidebar__brand small { display: block; font-weight: 400; color: #94a3b8; font-size: .78rem; }
.sidebar__group { margin: 12px 0 4px; padding: 0 10px; font-size: .7rem; text-transform: uppercase; letter-spacing: .08em; color: #7dd3c8; }
.nav-link { display: block; padding: 8px 10px; border-radius: 8px; color: #cbd5e1; font-size: .9rem; }
.nav-link:hover { background: rgba(255,255,255,.06); color: #fff; text-decoration: none; }
.nav-link.active { background: var(--primary); color: #fff; }

.main { display: flex; flex-direction: column; min-width: 0; }
.header {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 14px 28px; background: var(--surface); border-bottom: 1px solid var(--border);
  position: sticky; top: 0; z-index: 10;
}
.header__title { font-size: 1.05rem; font-weight: 600; margin: 0; }
.header__meta { color: var(--text-muted); font-size: .82rem; }
.content { padding: 24px 28px 48px; max-width: 1280px; width: 100%; }

.menu-toggle {
  display: none; border: 1px solid var(--border); background: var(--surface);
  border-radius: 8px; padding: 6px 10px; cursor: pointer;
}

/* ---------- cards & typography ---------- */
.page-title { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 18px; flex-wrap: wrap; }
.page-title h1 { font-size: 1.45rem; margin: 0; }
.page-title p { margin: 4px 0 0; color: var(--text-muted); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); }
.card__body { padding: 20px; }

/* ---------- buttons & forms ---------- */
.button {
  display: inline-flex; align-items: center; gap: 8px; justify-content: center;
  border-radius: 8px; border: 1px solid var(--border); background: var(--surface);
  padding: 8px 14px; cursor: pointer; font-weight: 500; font-size: .9rem;
  transition: background .15s ease, border-color .15s ease;
}
.button:hover:not(:disabled) { background: var(--surface-muted); }
.button:disabled { opacity: .55; cursor: not-allowed; }
.button--primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.button--primary:hover:not(:disabled) { background: var(--primary-hover); }
.button--danger { background: var(--danger); border-color: var(--danger); color: #fff; }
.button--danger:hover:not(:disabled) { background: #991b1b; }
.button--ghost { border-color: transparent; background: transparent; }
.button--sm { padding: 4px 10px; font-size: .82rem; }

.form { display: grid; gap: 16px; }
.form__grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { font-weight: 500; font-size: .88rem; }
.field .hint { color: var(--text-muted); font-size: .78rem; }
.field input, .field select, .field textarea {
  border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; background: #fff; width: 100%;
}
.field input:focus, .field select:focus, .field textarea:focus {
  outline: 2px solid rgba(15, 118, 110, .25); border-color: var(--primary);
}
.field textarea { min-height: 96px; resize: vertical; }
.checkbox { flex-direction: row; align-items: center; gap: 10px; }
.checkbox input { width: 16px; height: 16px; }
.required-mark { color: var(--danger); margin-left: 2px; }
.form__actions { display: flex; gap: 10px; flex-wrap: wrap; }

/* ---------- table ---------- */
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
.toolbar input[type="search"] {
  flex: 1 1 240px; min-width: 200px; border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px;
}
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap; }
th { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); background: var(--surface-muted); }
th button { background: none; border: 0; padding: 0; cursor: pointer; font: inherit; color: inherit; text-transform: inherit; letter-spacing: inherit; }
tbody tr:hover { background: #f8fafc; }
td.wrap { white-space: normal; max-width: 320px; }
.cell-muted { color: var(--text-muted); }
.row-actions { display: flex; gap: 6px; justify-content: flex-end; }

.pagination { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; flex-wrap: wrap; }

/* ---------- states ---------- */
.state { padding: 40px 20px; text-align: center; color: var(--text-muted); }
.state h2 { color: var(--text); font-size: 1.05rem; margin: 0 0 6px; }
.alert { border-radius: 8px; padding: 12px 14px; border: 1px solid; font-size: .9rem; }
.alert--error { background: var(--danger-bg); border-color: #fecaca; color: var(--danger); }
.alert--success { background: var(--success-bg); border-color: #bbf7d0; color: var(--success); }
.alert--warning { background: var(--warning-bg); border-color: #fde68a; color: var(--warning); }
.alert ul { margin: 6px 0 0; padding-left: 18px; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; background: var(--surface-muted); font-size: .78rem; }
.spinner {
  width: 18px; height: 18px; border-radius: 50%; border: 2px solid rgba(15,118,110,.25);
  border-top-color: var(--primary); animation: spin .8s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- dialog ---------- */
.dialog-backdrop {
  position: fixed; inset: 0; background: rgba(15, 23, 42, .45); display: grid; place-items: center; padding: 16px; z-index: 50;
}
.dialog { background: var(--surface); border-radius: var(--radius); max-width: 440px; width: 100%; padding: 24px; box-shadow: var(--shadow); }
.dialog h2 { margin: 0 0 8px; font-size: 1.1rem; }
.dialog p { color: var(--text-muted); margin: 0 0 20px; }
.dialog__actions { display: flex; gap: 10px; justify-content: flex-end; }

/* ---------- login ---------- */
.login { min-height: 100%; display: grid; place-items: center; padding: 24px; }
.login .card { width: 100%; max-width: 380px; }
.login h1 { margin: 0 0 4px; font-size: 1.25rem; }
.login p.subtitle { margin: 0 0 20px; color: var(--text-muted); font-size: .9rem; }

/* ---------- responsive ---------- */
@media (max-width: 900px) {
  .shell { grid-template-columns: 1fr; }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; width: 264px; z-index: 40;
    transform: translateX(-100%); transition: transform .2s ease;
  }
  .sidebar.open { transform: translateX(0); box-shadow: 0 0 0 100vmax rgba(15,23,42,.35); }
  .menu-toggle { display: inline-flex; }
  .content { padding: 18px 16px 40px; }
  .header { padding: 12px 16px; }
}
`;
}

function envExample(ctx) {
  return [
    '# Copy to .env.local when the API is not reachable through the Vite proxy.',
    '# VITE_API_URL=http://localhost:' + ctx.app.api.port,
    '',
  ].join('\n');
}

function gitignore() {
  return [
    'node_modules/',
    '.next/',
    'out/',
    'dist/',
    'coverage/',
    '.env',
    '.env.*',
    '*.log',
    '.DS_Store',
    '',
  ].join('\n');
}

function dockerfile() {
  return `FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package*.json ./
RUN npm install --no-audit --no-fund

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
EXPOSE 3030
CMD ["npm", "run", "start"]
`;
}

function sharedEnums(ctx) {
  if (!ctx.enums.length) return '// No application-wide enums are declared.\nexport {};\n';
  const blocks = ctx.enums.map((item) => {
    const values = item.values
      .map((value) => "  " + value + ": '" + value + "',")
      .join('\n');
    return (
      '/** Enum `' +
      item.name +
      '` (declared in a studio manifest, shared app-wide). */\n' +
      'export const ' +
      item.name +
      ' = {\n' +
      values +
      '\n} as const;\n' +
      'export type ' +
      item.name +
      ' = (typeof ' +
      item.name +
      ')[keyof typeof ' +
      item.name +
      '];'
    );
  });
  return blocks.join('\n\n') + '\n';
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

module.exports = {
  packageJson,
  tsconfig,
  indexHtml,
  apiClient,
  apiServer,
  apiTypes,
  jsonType,
  layout,
  providers,
  nextConfig,
  nextEnvTypes,
  styles,
  envExample,
  gitignore,
  dockerfile,
  sharedEnums,
  escapeHtml,
};
