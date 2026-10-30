"use strict";

/**
 * Frontend output: a Next.js (App Router) + React + TypeScript admin UI. It is
 * a completely separate project from the backend, rooted at the frontend
 * output directory.
 *
 * Layout mirrors the backend foldering: shared shell/API/theme live under
 * `src/app`, and every studio owns its screens under
 * `src/labs/<lab>/studios/<studio>/features/<model>/`. The App Router tree
 * mirrors that layout: `src/app/(secure)/<lab>/<studio>/<route>/page.tsx`.
 */

const components = require("../templates/frontend/components.templates");
const tooling = require("../templates/frontend/tooling.templates");
const { enumImports, tsType } = require("../engine/ts");
const { pascal, camel, kebabPlural } = require("../engine/naming");

/**
 * The frontend is its own project at the frontend output root. Files below are
 * relative to it.
 */
const FRONTEND_ROOT = "";

// Files belonging to the one-time scaffold. They are written on the initial
// bootstrap and are never rewritten by later studio generations, so edits to
// the shell, routing and API client survive. Studio pages additionally track
// `ui.enabled`, so a backend-only studio does not touch the UI at all.
const SCAFFOLD_FILE = Symbol.for("chemicalist.frontend.scaffold");

/**
 * Relative import path from a studio area to `src/app`.
 * Studio files live in `src/labs/<lab>/studios/<studio>/...`, so `src/app` is
 * four levels up.
 */
const APP_IMPORT = "../../../../app";

/**
 * Pages live in `src/app/(secure)/<lab>/<studio>/<route>/{page.tsx,new/, [id]/edit/}`.
 * `new/page.tsx` is one level deeper and `[id]/edit/page.tsx` two, so the
 * path back to `src/app` is computed from the file's own directory.
 */
function appImportFor(pageDir) {
  const depth = pageDir.replace(/\\/g, "/").split("/").filter(Boolean).length;
  return "../".repeat(depth) + "app";
}

/** Path from a page under `src/app` to `src/labs/...` (both under `src`). */
function labsImportFor(pageDir, target) {
  const depth = pageDir.replace(/\\/g, "/").split("/").filter(Boolean).length;
  return "../".repeat(depth) + target;
}

/**
 * Flatten every generated model of the application into the shape the frontend
 * templates consume. Works for both the current studio and previously
 * registered ones, so routes are always the complete set.
 */
function frontendModels(ctx) {
  const studioByKey = new Map(ctx.studios.map((studio) => [studio.key, studio]));
  return ctx.applicationModels
    .map((model) => {
      const manifest = model.manifest;
      const key = manifest.labSlug + "/" + manifest.studioSlug;
      const studio = studioByKey.get(key) || {
        labSlug: manifest.labSlug,
        studioSlug: manifest.studioSlug,
        title: manifest.ui.title,
      };
      const features = {
        read: model.operations.includes("read"),
        create: model.operations.includes("create"),
        update: model.operations.includes("update"),
        delete: model.operations.includes("delete"),
      };
      if (!features.read && !features.create && !features.update && !features.delete) {
        return null;
      }
      return {
        name: model.name,
        label: model.label,
        lab: manifest.lab,
        studio: manifest.studio,
        labSlug: studio.labSlug,
        studioSlug: studio.studioSlug,
        studioTitle: studio.title,
        key,
        route: model.route,
        featureDir: model.route,
        path: "/" + studio.labSlug + "/" + studio.studioSlug + "/" + model.route,
        apiPath:
          (ctx.app.urlPrefix(false) || "") +
          "/" +
          studio.labSlug +
          "/" +
          studio.studioSlug +
          "/" +
          model.route,
        features,
        fields: model.writableFields,
        writableFields: model.writableFields,
        searchable: model.searchFields.length > 0,
        sortable: model.sortFields.length > 0,
      };
    })
    .filter(Boolean);
}

function shellStudios(ctx, models) {
  const byKey = new Map();
  for (const model of models) {
    if (!byKey.has(model.key)) {
      byKey.set(model.key, {
        key: model.key,
        lab: model.lab,
        studio: model.studio,
        labSlug: model.labSlug,
        studioSlug: model.studioSlug,
        title: model.studioTitle,
        route: model.route,
        models: [],
      });
    }
    byKey.get(model.key).models.push({ route: model.route, label: model.label });
  }
  return [...byKey.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Per-model screens
// ---------------------------------------------------------------------------

function escapeJsx(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

function colSpan(field) {
  return field.baseType === "text" || field.baseType === "json" ? "2" : "1";
}

function listColumns(model) {
  const fields = model.writableFields.slice(0, 6);
  return (
    "const columns: Array<{ key: string; label: string; render?: (row: " +
    model.name +
    ") => string }> = [\n" +
    fields
      .map((field) => {
        if (field.baseType === "boolean") {
          return (
            "  { key: '" +
            field.name +
            "', label: '" +
            field.label +
            "', render: (row) => (row." +
            field.name +
            " ? 'Yes' : 'No') },"
          );
        }
        if (field.baseType === "date" || field.baseType === "datetime") {
          return (
            "  { key: '" +
            field.name +
            "', label: '" +
            field.label +
            "', render: (row) => formatDate(row." +
            field.name +
            ") },"
          );
        }
        if (field.baseType === "json" || field.isArray) {
          return (
            "  { key: '" +
            field.name +
            "', label: '" +
            field.label +
            "', render: (row) => (row." +
            field.name +
            " == null ? '' : JSON.stringify(row." +
            field.name +
            ")) },"
          );
        }
        return (
          "  { key: '" + field.name + "', label: '" + field.label + "' },"
        );
      })
      .join("\n") +
    "\n];\n"
  );
}

function featureFlags(model) {
  const enabled = model.operations || [];
  return {
    create: enabled.includes("create"),
    read: enabled.includes("read"),
    update: enabled.includes("update"),
    delete: enabled.includes("delete"),
  };
}


/**
 * List screen — a Next.js Server Component.
 *
 * It renders and fetches on the server (no client bundle, no loading spinner),
 * and nests the small interactive pieces (search, delete) as Client Components.
 */
function generateListPage(ctx, model, pageDir) {
  const f = featureFlags(model);
  const cols = listColumns(model);
  const canCreate = f.create;
  const hasDate = model.writableFields.some(
    (field) => field.baseType === "date" || field.baseType === "datetime",
  );
  const api = model.apiPath;
  const appImport = appImportFor(pageDir);
  const featureRoot = labsImportFor(
    pageDir,
    "labs/" +
      ctx.studio.labSlug +
      "/studios/" +
      ctx.studio.studioSlug +
      "/features/" +
      model.name,
  );

  return `import Link from 'next/link';
import { serverRequest, ServerApiError } from '${appImport}/api/server';
import { EmptyState, ErrorState } from '${appImport}/components/ui';
import { Pagination } from '${appImport}/components/Pagination';
import type { PaginatedResponse } from '${appImport}/api/types';
import type { ${model.name} } from '${featureRoot}/domain/${model.name}.types';
${model.searchable ? "import { " + model.name + "Search } from '" + featureRoot + "/components/" + model.name + "Search';\n" : ""}

${hasDate ? "const formatDate = (value: unknown): string => (value ? new Date(String(value)).toLocaleString() : '');\n" : ""}${cols}
const PAGE_SIZE = 20;

interface PageProps {
  searchParams: Promise<{ page?: string; q?: string }>;
}

export default async function ${model.name}ListPage({ searchParams }: PageProps) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const query = (params.q ?? '').trim();

  let data: PaginatedResponse<${model.name}> | null = null;
  let error: string[] = [];
  try {
    data = await serverRequest<PaginatedResponse<${model.name}>>(
      '${api}?page=' + page + '&pageSize=' + PAGE_SIZE + (query ? '&search=' + encodeURIComponent(query) : ''),
    );
  } catch (failure: unknown) {
    error = failure instanceof ServerApiError ? [failure.message] : ['Unable to load ${model.label} records.'];
  }

  return (
    <div className="page">
      <div className="page-title">
        <div>
          <h1>${model.label}</h1>
          <p>${escapeJsx(model.studioTitle)} — ${escapeJsx(model.name)} records.</p>
        </div>
        ${
          canCreate
            ? `<Link className="button" href="new">
          New ${model.label}
        </Link>`
            : ""
        }
      </div>

      ${model.searchable ? `<${model.name}Search initialQuery={query} />` : ""}

      {error.length ? <ErrorState messages={error} /> : null}

      {data && data.items.length === 0 ? (
        <EmptyState title="No records yet" description="Create the first ${model.label.toLowerCase()} to get started." />
      ) : null}

      {data && data.items.length > 0 ? (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((column) => (
                    <th key={column.key}>{column.label}</th>
                  ))}
                  <th className="table__actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    {columns.map((column) => (
                      <td key={column.key}>
                        {column.render
                          ? column.render(row)
                          : String((row as unknown as Record<string, unknown>)[column.key] ?? '')}
                      </td>
                    ))}
                    <td className="table__actions">
                      ${
                        f.update
                          ? `<Link className="button button--sm button--ghost" href={String(row.id) + '/edit'}>
                        Edit
                      </Link>`
                          : ""
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination
            page={data.page}
            pageSize={data.pageSize}
            total={data.total}
            totalPages={data.totalPages}
            basePath=""
            query={query}
          />
        </>
      ) : null}
    </div>
  );
}
`;
}

/**
 * Interactive search box (Client Component) — keeps the list page a Server
 * Component while still allowing instant filtering.
 */
function generateSearchClient(ctx, model) {
  return `'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

/** Search toolbar for the ${model.label} list. Updates the URL query string. */
export function ${model.name}Search({ initialQuery }: { initialQuery: string }) {
  const [search, setSearch] = useState(initialQuery);
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = new URLSearchParams(params.toString());
    const value = search.trim();
    if (value) next.set('q', value);
    else next.delete('q');
    next.delete('page');
    router.push(pathname + '?' + next.toString());
  }

  return (
    <form className="toolbar" onSubmit={submit}>
      <input
        className="input"
        placeholder="Search…"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <button type="submit" className="button button--ghost">
        Search
      </button>
    </form>
  );
}
`;
}

function formField(field, model) {
  const required = field.optional ? "" : " required";
  const label = field.label + (field.optional ? "" : " *");
  // Every input binds through a typed accessor, so the loose FormState record
  // never leaks a union type into a DOM prop.
  const bind =
    field.baseType === "boolean"
      ? "boolValue(form, '" + field.name + "')"
      : "textValue(form, '" + field.name + "')";
  const update = "setField('" + field.name + "', ";
  const wrapper = (control) =>
    '      <label className="field" style={{ gridColumn: \'span ' +
    colSpan(field) +
    "' }}>\n" +
    "        <span>" +
    label +
    "</span>\n" +
    control +
    (field.description ? "\n        <small>" + field.description + "</small>" : "") +
    "\n      </label>";

  switch (field.baseType) {
    case "boolean":
      return wrapper(
        '        <input\n          type="checkbox"\n          checked={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.checked)} />",
      );
    case "int":
    case "float":
    case "decimal":
      return wrapper(
        '        <input\n          type="number"\n          step="' +
          (field.baseType === "int" ? "1" : "any") +
          '"\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)}" +
          required +
          " />",
      );
    case "date":
    case "datetime":
      return wrapper(
        '        <input\n          type="' +
          (field.baseType === "date" ? "date" : "datetime-local") +
          '"\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)}" +
          required +
          " />",
      );
    case "text":
      return wrapper(
        '        <textarea\n          rows={4}\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)}" +
          required +
          " />",
      );
    case "json":
      return wrapper(
        '        <textarea\n          rows={6}\n          className="mono"\n          placeholder="{}"\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)} />",
      );
    case "enum": {
      const values = field.enumValues || [];
      return wrapper(
        '        <select\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)}" +
          required +
          ">\n" +
          (field.optional ? '          <option value="">—</option>\n' : "") +
          values
            .map((value) => '          <option value="' + value + '">' + value + "</option>")
            .join("\n") +
          "\n        </select>",
      );
    }
    default:
      return wrapper(
        '        <input\n          type="text"\n          value={' +
          bind +
          "}\n          onChange={(event) => " +
          update +
          "event.target.value)}" +
          required +
          " />",
      );
  }
}


/**
 * Create/edit form — a Client Component (it owns form state).
 *
 * `mode === "edit"` reads the record id from the `[id]` route segment and
 * loads it on mount; `mode === "create"` starts from an empty form.
 */
function generateFormPage(ctx, model, editMode, pageDir) {
  const fields = model.writableFields;
  const initial = fields
    .map((field) => {
      if (field.baseType === "boolean") return "    " + field.name + ": false,";
      return "    " + field.name + ": '',";
    })
    .join("\n");

  const hydrate = fields
    .map((field) => {
      if (field.baseType === "boolean") {
        return "      " + field.name + ": Boolean(record." + field.name + "),";
      }
      if (field.baseType === "date") {
        return (
          "      " +
          field.name +
          ": record." +
          field.name +
          " ? new Date(String(record." +
          field.name +
          ")).toISOString().slice(0, 10) : '',"
        );
      }
      if (field.baseType === "datetime") {
        return (
          "      " +
          field.name +
          ": record." +
          field.name +
          " ? new Date(String(record." +
          field.name +
          ")).toISOString().slice(0, 16) : '',"
        );
      }
      if (field.baseType === "json") {
        return (
          "      " +
          field.name +
          ": record." +
          field.name +
          " === null || record." +
          field.name +
          " === undefined ? '' : JSON.stringify(record." +
          field.name +
          ", null, 2),"
        );
      }
      return (
        "      " +
        field.name +
        ": record." +
        field.name +
        " === null || record." +
        field.name +
        " === undefined ? '' : String(record." +
        field.name +
        "),"
      );
    })
    .join("\n");

  const serialize = fields
    .map((field) => {
      if (field.baseType === "boolean") {
        return (
          "    payload." + field.name + " = Boolean(form." + field.name + ");"
        );
      }
      if (
        field.baseType === "int" ||
        field.baseType === "float" ||
        field.baseType === "decimal" ||
        field.baseType === "number"
      ) {
        return (
          "    payload." +
          field.name +
          " = form." +
          field.name +
          " === '' ? null : Number(form." +
          field.name +
          ");"
        );
      }
      if (field.baseType === "date" || field.baseType === "datetime") {
        return (
          "    payload." +
          field.name +
          " = form." +
          field.name +
          " ? new Date(String(form." +
          field.name +
          ")).toISOString() : null;"
        );
      }
      if (field.baseType === "json") {
        return (
          "    payload." +
          field.name +
          " = form." +
          field.name +
          " === '' ? null : JSON.parse(String(form." +
          field.name +
          "));"
        );
      }
      return (
        "    payload." +
        field.name +
        " = form." +
        field.name +
        " === '' ? null : form." +
        field.name +
        ";"
      );
    })
    .join("\n");

  const optionalFilter = fields
    .map((field) => {
      if (field.optional) {
        return (
          "    if (payload." +
          field.name +
          " === null) delete payload." +
          field.name +
          ";"
        );
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");

  const api = model.apiPath;
  const appImport = appImportFor(pageDir);
  const featureRoot = labsImportFor(
    pageDir,
    "labs/" +
      ctx.studio.labSlug +
      "/studios/" +
      ctx.studio.studioSlug +
      "/features/" +
      model.name,
  );
  const listHref =
    "/" + ctx.studio.labSlug + "/" + ctx.studio.studioSlug + "/" + kebabPlural(model.name);
  const editing = editMode === true;
  const componentName = model.name + (editing ? "EditPage" : "CreatePage");

  const idHook = editing
    ? "  const params = useParams<{ id: string }>();\n  const id = params?.id ?? '';\n  const editing = true;"
    : "  const id = '';\n  const editing = false;";

  return `'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';
import { request, errorMessages } from '${appImport}/api/client';
import { ErrorState, LoadingState } from '${appImport}/components/ui';
import type { ${model.name} } from '${featureRoot}/domain/${model.name}.types';

// Inputs hold strings (numbers/dates are converted on submit) and booleans.
type FormValue = string | boolean;
type FormState = Record<string, FormValue>;

const textValue = (form: FormState, name: string): string => {
  const value = form[name];
  return typeof value === 'string' ? value : '';
};

const boolValue = (form: FormState, name: string): boolean => form[name] === true;

const emptyForm: FormState = {
${initial}
};

export default function ${componentName}() {
  const router = useRouter();
${idHook}
  const [form, setForm] = useState<FormState>(emptyForm);
  const [loading, setLoading] = useState(editing);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);

  const setField = (name: string, value: FormValue) =>
    setForm((current) => ({ ...current, [name]: value }));

  useEffect(() => {
    if (!editing || !id) return;
    let active = true;
    setLoading(true);
    request<${model.name}>('GET', '${api}/' + id)
      .then((record) => {
        if (!active) return;
        setForm({
${hydrate}
        });
      })
      .catch((failure: unknown) => {
        if (active) setErrors(errorMessages(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [editing, id]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setErrors([]);
    try {
      const payload: Record<string, unknown> = {};
${serialize}
${optionalFilter}
      if (editing) {
        await request('PATCH', '${api}/' + id, payload);
      } else {
        await request('POST', '${api}', payload);
      }
      router.push('${listHref}');
      router.refresh();
    } catch (failure) {
      setErrors(errorMessages(failure));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState label="Loading ${model.label.toLowerCase()}…" />;

  return (
    <div className="page">
      <div className="page-title">
        <div>
          <h1>{editing ? 'Edit' : 'New'} ${model.label}</h1>
          <p>${model.name} — fields generated from the manifest.</p>
        </div>
        <Link className="button button--ghost" href="${listHref}">
          Back
        </Link>
      </div>

      {errors.length ? <ErrorState messages={errors} /> : null}

      <form className="form-grid card" onSubmit={submit}>
${fields.map((field) => formField(field, model)).join("\n")}
        <div className="form-actions" style={{ gridColumn: 'span 2' }}>
          <button type="submit" className="button" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <Link className="button button--ghost" href="${listHref}">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}
`;
}

function generateTypes(ctx, model) {
  const enums = enumImports(model.fields);
  // This file is at `features/<model>/domain/`; the studio's `domain/` folder
  // holds `enums.business.ts` and `src/app` is four levels up.
  const lines = [];
  if (enums.length) {
    lines.push(
      "import type { " + enums.join(", ") + " } from '../../enums.business';",
    );
  }
  // JSON columns are typed as `JsonValue`, which has to be imported.
  if (model.fields.some((field) => field.baseType === "json")) {
    lines.push("import type { JsonValue } from '" + APP_IMPORT + "/api/json';");
  }
  const members = model.fields
    .map((field) => "  " + field.name + (field.optional ? "?" : "") + ": " + tsType(field) + (field.nullable ? " | null" : "") + ";")
    .join("\n");
  lines.push("/** Shape returned by the API (dates are ISO strings over the wire). */");
  lines.push("export interface " + model.name + " {");
  lines.push(members.replace(/: Date/g, ": string").replace(/: Date\[\]/g, ": string[]"));
  lines.push("}");
  return lines.join("\n") + "\n";
}

function generateStudioEnums(ctx, manifest) {
  const enumByName = new Map(ctx.enums.map((item) => [item.name, item]));
  const blocks = manifest.enums.map((item) => {
    const values = item.values
      .map((value) => "  " + value + ": '" + value + "',")
      .join("\n");
    return "export const " + item.name + " = {\n" + values + "\n} as const;\n" + "export type " + item.name + " = (typeof " + item.name + ")[keyof typeof " + item.name + "];";
  });
  // Enums used by this studio but declared elsewhere are re-exported from a
  // shared module so the feature code always imports from one place.
  const owned = new Set(manifest.enums.map((item) => item.name));
  const referenced = new Set();
  for (const model of manifest.models) {
    for (const field of model.writableFields) {
      if (field.enumName && !owned.has(field.enumName) && enumByName.has(field.enumName)) {
        referenced.add(field.enumName);
      }
    }
  }
  for (const name of [...referenced].sort()) {
    blocks.push(
      "export { " + name + " } from '" + APP_IMPORT + "/shared/enums';",
    );
  }
  if (blocks.length === 0) return "export {};\n";
  return blocks.join("\n\n") + "\n";
}

/**
 * One-time frontend bootstrap: the project skeleton (tooling, shell, router,
 * API client). Never rewritten once it exists.
 */
function addFrontendScaffold(plan, ctx) {
  const owner = { owner: "frontend", [SCAFFOLD_FILE]: true };
  const models = frontendModels(ctx);
  const enriched = {
    ...ctx,
    frontendModels: models,
    shellStudios: shellStudios(ctx, models),
    app: { ...ctx.app, title: ctx.app.title },
  };

  // Project tooling (Next.js App Router).
  plan.add(FRONTEND_ROOT + "package.json", tooling.packageJson(ctx), owner);
  plan.add(FRONTEND_ROOT + "tsconfig.json", tooling.tsconfig(), owner);
  plan.add(FRONTEND_ROOT + "next.config.ts", components.nextConfigWithProxy(ctx), owner);
  plan.add(FRONTEND_ROOT + "next-env.d.ts", tooling.nextEnvTypes(), owner);
  plan.add(FRONTEND_ROOT + ".env.example", tooling.envExample(ctx), owner);
  plan.add(FRONTEND_ROOT + ".gitignore", tooling.gitignore(), owner);
  plan.add(FRONTEND_ROOT + "Dockerfile", tooling.dockerfile(), owner);
  plan.add(FRONTEND_ROOT + ".dockerignore", "node_modules\n.next\nout\n.git\n.env*\n", owner);
  plan.add(FRONTEND_ROOT + "public/robots.txt", "User-agent: *\nAllow: /\n", owner);

  // App Router entries.
  plan.add("src/app/layout.tsx", tooling.layout(ctx), owner);
  plan.add("src/app/styles.css", tooling.styles(ctx), owner);
  plan.add("src/app/not-found.tsx", components.appNotFound(), owner);
  plan.add("src/app/(secure)/layout.tsx", components.appSecureLayout(ctx), owner);
  plan.add("src/app/(secure)/page.tsx", components.appDashboard(enriched), owner);
  plan.add("src/app/login/page.tsx", components.appLoginPage(ctx), owner);
  plan.add("src/app/loading.tsx", components.appLoading(), owner);

  // Shared client infrastructure.
  plan.add(FRONTEND_ROOT + "src/app/api/client.ts", tooling.apiClient(ctx), owner);
  plan.add(FRONTEND_ROOT + "src/app/api/server.ts", tooling.apiServer(ctx), owner);
  plan.add(FRONTEND_ROOT + "src/app/api/types.ts", tooling.apiTypes(), owner);
  plan.add(FRONTEND_ROOT + "src/app/api/json.ts", tooling.jsonType(), owner);
  plan.add(FRONTEND_ROOT + "src/app/api/useFetch.ts", components.hookUseFetch(), owner);
  plan.add(FRONTEND_ROOT + "src/app/components/ui.tsx", components.componentsUi(), owner);
  plan.add(FRONTEND_ROOT + "src/app/components/Pagination.tsx", components.pagination(), owner);
  plan.add(FRONTEND_ROOT + "src/app/components/AppShell.tsx", components.appShell(enriched), owner);
  plan.add(FRONTEND_ROOT + "src/app/components/LoginPage.tsx", components.loginPage(), owner);
  plan.add(FRONTEND_ROOT + "src/app/components/providers.tsx", tooling.providers(), owner);
  plan.add(FRONTEND_ROOT + "src/app/auth/AuthContext.tsx", components.authContext(), owner);
  plan.add(FRONTEND_ROOT + "src/app/shared/enums.ts", tooling.sharedEnums(ctx), owner);
}

/**
 * Per-studio UI pages. Only studios whose manifest enables `ui` get screens;
 * a studio manifest never (re)creates the frontend project itself.
 */
function addFrontendPages(plan, ctx) {
  const owner = { owner: "frontend" };

  // Every studio in the application gets pages, but a studio's own files must
  // only be planned once even when its manifest appears in several contexts.
  const plannedStudios = plan.frontendStudiosPlanned || new Set();
  plan.frontendStudiosPlanned = plannedStudios;

  for (const manifest of ctx.appManifests) {
    if (manifest.ui.enabled === false) continue;
    const root =
      "src/labs/" + manifest.labSlug + "/studios/" + manifest.studioSlug;
    const studioKey = manifest.labSlug + "/" + manifest.studioSlug;
    if (plannedStudios.has(studioKey) && plan.files.has("frontend:" + root + "/domain/enums.business.ts")) {
      continue;
    }
    plannedStudios.add(studioKey);
    const studioOwner = {
      owner: "frontend",
      studio: studioKey,
    };
    plan.add(root + "/domain/enums.business.ts", generateStudioEnums(ctx, manifest), studioOwner);

    for (const model of manifest.models) {
      const featureRoot = root + "/features/" + model.name;
      const modelOwner = studioOwner;
      // The route tree mirrors the studio layout so every screen is a real
      // App Router route segment under `src/app`.
      const routeSegment = kebabPlural(model.name);
      const routeSegments =
        "src/app/(secure)/" +
        manifest.labSlug +
        "/" +
        manifest.studioSlug +
        "/" +
        routeSegment;
      // Import depth is derived from each page's own location.
      const listDir = routeSegments.replace(/^src\//, "");
      const createDir = listDir + "/new";
      const editDir = listDir + "/[id]/edit";

      plan.add(featureRoot + "/domain/" + model.name + ".types.ts", generateTypes(ctx, model), modelOwner);
      plan.add(routeSegments + "/page.tsx", generateListPage(ctx, model, listDir), modelOwner);
      if (model.searchFields && model.searchFields.length > 0) {
        plan.add(
          featureRoot + "/components/" + model.name + "Search.tsx",
          generateSearchClient(ctx, model),
          modelOwner,
        );
      }
      const canCreate = model.operations.includes("create");
      const canUpdate = model.operations.includes("update");
      if (canCreate) {
        plan.add(
          routeSegments + "/new/page.tsx",
          generateFormPage(ctx, model, false, createDir),
          modelOwner,
        );
      }
      if (canUpdate) {
        plan.add(
          routeSegments + "/[id]/edit/page.tsx",
          generateFormPage(ctx, model, true, editDir),
          modelOwner,
        );
      }
    }
  }
}

module.exports = {
  addFrontendScaffold,
  addFrontendPages,
  frontendModels,
};
