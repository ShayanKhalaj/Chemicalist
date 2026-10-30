"use strict";

/**
 * Shared React components, hooks and the application shell.
 */

function hookUseFetch() {
  return `import { useCallback, useEffect, useRef, useState } from 'react';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Tiny data hook with request-cancellation semantics: only the latest request
 * may update state, so fast filter changes never render stale results.
 */
export function useFetch<T>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
  options: { skip?: boolean } = {},
): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(!options.skip);
  const [nonce, setNonce] = useState(0);
  const requestId = useRef(0);
  const skip = options.skip === true;

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return;
    }
    const current = ++requestId.current;
    setLoading(true);
    setError(undefined);
    loader()
      .then((result) => {
        if (current === requestId.current) setData(result);
      })
      .catch((failure: unknown) => {
        if (current === requestId.current) setError(failure);
      })
      .finally(() => {
        if (current === requestId.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, skip]);

  return { data, error, loading, reload };
}
`;
}

function componentsUi() {
  return `import type { ReactNode } from 'react';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>{label}</p>
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="state">
      <h2>{title}</h2>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ messages, onRetry }: { messages: string[]; onRetry?: () => void }) {
  return (
    <div className="state" role="alert">
      <h2>Something went wrong</h2>
      <ul style={{ textAlign: 'left', display: 'inline-block' }}>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      {onRetry ? (
        <p>
          <button type="button" className="button" onClick={onRetry}>
            Try again
          </button>
        </p>
      ) : null}
    </div>
  );
}

export function Alert({ tone = 'error', messages }: { tone?: 'error' | 'success' | 'warning'; messages: string[] }) {
  if (messages.length === 0) return null;
  return (
    <div className={'alert alert--' + tone} role="alert">
      {messages.length === 1 ? messages[0] : (
        <ul>
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation" onClick={onCancel}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <h2 id="confirm-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog__actions">
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="button button--danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
`;
}

function authContext() {
  return `import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getToken, onUnauthorized, request, setToken } from '../api/client';
import type { SessionPayload, TokenClaims } from '../api/types';

interface AuthState {
  token: string | null;
  claims: TokenClaims | null;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

/** Decodes the JWT payload for display only; the backend is the security authority. */
export function decodeClaims(token: string): TokenClaims | null {
  try {
    const payload = token.split('.')[1];
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const parsed = JSON.parse(json) as TokenClaims;
    if (parsed.exp && parsed.exp * 1000 < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string | null>(() => {
    const stored = getToken();
    return stored && decodeClaims(stored) ? stored : null;
  });

  const logout = useCallback(() => {
    setToken(null);
    setTokenState(null);
  }, []);

  useEffect(() => {
    onUnauthorized(() => logout());
  }, [logout]);

  const login = useCallback(async (identifier: string, password: string) => {
    const session = await request<SessionPayload>('POST', '/platform/auth/login', { identifier, password });
    setToken(session.accessToken);
    setTokenState(session.accessToken);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ token, claims: token ? decodeClaims(token) : null, login, logout }),
    [token, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside <AuthProvider>');
  return context;
}
`;
}

function loginPage() {
  return `import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth/AuthContext';
import { Alert } from '../components/ui';
import { errorMessages } from '../api/client';

export function LoginPage({ appTitle }: { appTitle: string }) {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setErrors([]);
    try {
      await login(identifier.trim(), password);
    } catch (error) {
      setErrors(errorMessages(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login">
      <form className="card card__body form" onSubmit={submit}>
        <div>
          <h1>{appTitle}</h1>
          <p className="subtitle">Sign in to continue</p>
        </div>
        <Alert messages={errors} />
        <div className="field">
          <label htmlFor="identifier">Username or email<span className="required-mark">*</span></label>
          <input id="identifier" type="text" autoComplete="username" required value={identifier} onChange={(event) => setIdentifier(event.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="password">Password<span className="required-mark">*</span></label>
          <input id="password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
        </div>
        <button type="submit" className="button button--primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
`;
}

/**
 * Application shell for the Next.js App Router.
 *
 * Studio screens live in `src/labs/<lab>/studios/<studio>/...`. The generated
 * route tree mirrors that layout:
 *   src/app/<lab>/<studio>/<route>/page.tsx
 *   src/app/<lab>/<studio>/<route>/new/page.tsx
 *   src/app/<lab>/<studio>/<route>/[id]/edit/page.tsx
 */
function appShell(ctx) {
  const navGroups = new Map();
  for (const studio of ctx.studios) {
    if (!navGroups.has(studio.lab)) navGroups.set(studio.lab, []);
    navGroups.get(studio.lab).push(studio);
  }

  const nav = [...navGroups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([lab, studios]) => {
      const links = studios
        .sort((a, b) => (a.studio < b.studio ? -1 : 1))
        .map((studio) => {
          const firstModel = (studio.models || [])[0];
          if (!firstModel) return "";
          return (
            '        <Link href="/' +
            studio.labSlug +
            "/" +
            studio.studioSlug +
            "/" +
            firstModel.route +
            '" className="nav-link" onClick={onNavigate}>\n' +
            "          " +
            escapeJsx(studio.title) +
            "\n" +
            "        </Link>"
          );
        })
        .filter(Boolean)
        .join("\n");
      if (!links) return "";
      return (
        '      <div className="sidebar__group">' +
        escapeJsx(lab) +
        "</div>\n" +
        links
      );
    })
    .filter(Boolean)
    .join("\n");

  return `'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthContext';

export interface ShellStudio {
  key: string;
  lab: string;
  studio: string;
  labSlug: string;
  studioSlug: string;
  title: string;
  route: string;
  models: Array<{ route: string; label: string }>;
}

export const shellStudios: ShellStudio[] = ${JSON.stringify(ctx.shellStudios, null, 2)};

/** Client-side shell: navigation, session state and sign-out. */
export function AppShell({ title, children }: { title: string; children: ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { claims, logout, token } = useAuth();
  const onNavigate = () => setMenuOpen(false);

  return (
    <div className="shell">
      <aside className={menuOpen ? 'sidebar open' : 'sidebar'} aria-label="Main navigation">
        <div className="sidebar__brand">
          ${escapeJsx(ctx.app.ui.title)}
          <small>Chemicalist</small>
        </div>
${nav}
      </aside>
      <div className="main">
        <header className="header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button type="button" className="menu-toggle" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-label="Toggle navigation">
              ☰
            </button>
            <h1 className="header__title">{title}</h1>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {token ? <span className="header__meta">{claims?.email ?? 'signed in'}</span> : null}
            {token ? (
              <button type="button" className="button button--sm button--ghost" onClick={logout}>
                Sign out
              </button>
            ) : null}
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
`;
}

/**
 * Root page: the dashboard listing every generated studio. A Server Component.
 */
function appDashboard(ctx) {
  return `import Link from 'next/link';
import { shellStudios } from '../components/AppShell';

export default function DashboardPage() {
  const groups = new Map<string, typeof shellStudios>();
  for (const studio of shellStudios) {
    groups.set(studio.lab, [...(groups.get(studio.lab) ?? []), studio]);
  }

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Overview</h1>
          <p>${escapeJsx(ctx.app.title)} — ${ctx.frontendModels.length} generated model screens</p>
        </div>
      </div>
      <div className="form__grid">
        {[...groups.entries()].map(([lab, studios]) => (
          <section key={lab} className="card">
            <div className="card__body">
              <h2 style={{ marginTop: 0, fontSize: '1rem' }}>{lab}</h2>
              <ul style={{ paddingLeft: 18, margin: 0 }}>
                {studios.map((studio) => {
                  const first = studio.models[0];
                  return (
                    <li key={studio.key}>
                      {first ? (
                        <Link href={'/' + studio.labSlug + '/' + studio.studioSlug + '/' + first.route}>
                          {studio.title}
                        </Link>
                      ) : (
                        studio.title
                      )}
                      <span className="header__meta"> — {studio.models.length} model(s)</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
`;
}

/**
 * Route group + shell used by every generated screen
 * (`src/app/(secure)/layout.tsx`).
 */
function appSecureLayout(ctx) {
  return `'use client';

import type { ReactNode } from 'react';
import { AppShell } from '../components/AppShell';
import { useAuth } from '../auth/AuthContext';
import { LoginPage } from '../components/LoginPage';

/** Redirects unauthenticated visitors to the login form. */
export default function SecureLayout({ children }: { children: ReactNode }) {
  const { token } = useAuth();

  if (!token) {
    return <LoginPage appTitle="${escapeJsx(ctx.app.ui.title)}" />;
  }

  return <AppShell title="${escapeJsx(ctx.app.ui.title)}">{children}</AppShell>;
}
`;
}

function appLoginPage(ctx) {
  return `'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { LoginPage } from '../../components/LoginPage';
import { useAuth } from '../../auth/AuthContext';

export default function LoginRoute() {
  const { token } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (token) router.replace('/');
  }, [token, router]);

  return <LoginPage appTitle="${escapeJsx(ctx.app.ui.title)}" />;
}
`;
}

function pagination() {
  return `import Link from 'next/link';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  /** App Router path of the list route, e.g. "/inventory/catalog/products". */
  basePath?: string;
  /** Current search term, preserved across pages. */
  query?: string;
}

/** Server-rendered pagination: links, no client JavaScript needed. */
export function Pagination({ page, pageSize, total, totalPages, basePath = '', query = '' }: PaginationProps) {
  if (totalPages <= 1) return null;

  const href = (target: number) => {
    const params = new URLSearchParams();
    if (target > 1) params.set('page', String(target));
    if (query) params.set('q', query);
    const suffix = params.toString();
    return suffix ? basePath + '?' + suffix : basePath || '.';
  };

  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);

  return (
    <nav className="pagination" aria-label="Pagination">
      <span className="header__meta">
        Showing {first}–{last} of {total}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        {page > 1 ? (
          <Link className="button button--sm button--ghost" href={href(page - 1)}>
            Previous
          </Link>
        ) : null}
        <span className="header__meta">
          Page {page} of {totalPages}
        </span>
        {page < totalPages ? (
          <Link className="button button--sm button--ghost" href={href(page + 1)}>
            Next
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
`;
}

function appLoading() {
  return `export default function Loading() {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <p>Loading…</p>
    </div>
  );
}
`;
}

function appNotFound() {
  return `import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="state">
      <h2>Page not found</h2>
      <p>The requested screen does not exist.</p>
      <p>
        <Link className="button" href="/">
          Back to overview
        </Link>
      </p>
    </div>
  );
}
`;
}

/**
 * `next.config.ts` with a dev proxy so the browser never needs CORS.
 */
function nextConfigWithProxy(ctx) {
  return `import type { NextConfig } from 'next';

// The UI talks to the NestJS API. In development, requests to the API prefix
// are proxied to the backend; set NEXT_PUBLIC_API_URL to call another origin.
const apiTarget =
  process.env.API_PROXY_TARGET ?? 'http://localhost:${ctx.app.api.port}';

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: true },
  async rewrites() {
    return [
      {
        source: '${ctx.app.urlPrefix(false)}/:path*',
        destination: apiTarget + '${ctx.app.urlPrefix(false)}/:path*',
      },
    ];
  },
};

export default nextConfig;
`;
}

function escapeJsx(value) {
  return String(value).replace(
    /[{}<>]/g,
    (char) =>
      ({ "{": "&#123;", "}": "&#125;", "<": "&lt;", ">": "&gt;" })[char],
  );
}

module.exports = {
  hookUseFetch,
  componentsUi,
  pagination,
  authContext,
  loginPage,
  appShell,
  appDashboard,
  appSecureLayout,
  appLoginPage,
  appNotFound,
  appLoading,
  nextConfigWithProxy,
};
