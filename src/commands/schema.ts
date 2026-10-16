import type { Router } from "../api/client.ts";
import type { CatalogModel } from "../api/types.ts";
import type { Context } from "../context.ts";
import type { CommandSpec, Parsed } from "../lib/args.ts";
import { routerFor } from "../lib/body.ts";
import { CliError, ExitCode } from "../lib/errors.ts";
import { modelFields } from "../lib/model-fields.ts";
import { FIELD_FLAGS, fieldType, routerSchema } from "../lib/schema.ts";
import type { FieldSchema } from "../lib/schema-types.ts";
import { type Palette, wrap } from "../lib/ui.ts";
import { resolveModel } from "./shared.ts";

export const schema: CommandSpec = {
  name: "schema",
  aliases: ["inputs"],
  group: "Models and jobs",
  summary: "Show every input a model takes: type, limits, choices and flag",
  description:
    "Lists the request fields the model takes, with the flag that sets each one: its endpoint's fields from the API's " +
    "OpenAPI document, narrowed to the model's own row in the live catalog (fields it does not take dropped, its " +
    "resolutions, aspect ratios, qualities, formats, duration and image count). Offline, every field of the endpoint is " +
    "listed. Every field is a flag (`--seed 7`), and --set field=value works too. Prices are in `opensume models <id>`.",
  args: [{ name: "model", required: true, complete: "models", description: "A model id from `opensume models`" }],
  flags: [
    { name: "full", type: "boolean", description: "Print each field's whole description" },
    { name: "all", type: "boolean", description: "Include deprecated aliases" },
  ],
  examples: ["opensume schema gpt-image-2", "opensume schema veed-subtitles --full", "opensume inputs kling-3 --json"],
  run: schemaCommand,
};

/** The router the vendored schemas file a model id under, if they know it. */
export function vendoredRouter(id: string): Router | undefined {
  for (const router of ["image", "video"] as const) {
    const models: readonly unknown[] = routerSchema(router).fields.model?.enum ?? [];
    if (models.includes(id)) return router;
  }
  return undefined;
}

/** The router for a model id: offline when the vendored schemas know it, else from the live catalog. */
export async function routerForModel(ctx: Context, id: string): Promise<Router> {
  return vendoredRouter(id) ?? routerFor(await resolveModel(ctx, id));
}

/** The model's catalog row, or null offline: the schema then lists the whole endpoint. */
async function liveModel(ctx: Context, id: string): Promise<CatalogModel | null> {
  try {
    return await resolveModel(ctx, id);
  } catch (error) {
    // An unknown model is the caller's mistake; a host that does not answer is not.
    if (error instanceof CliError && error.code === "model_not_found") throw error;
    return null;
  }
}

async function schemaCommand(parsed: Parsed, ctx: Context): Promise<number> {
  const { ui } = ctx;
  const id = parsed.args[0] as string;
  const live = await liveModel(ctx, id);
  const router = vendoredRouter(id) ?? (live ? routerFor(live) : await routerForModel(ctx, id));
  const { endpoint, required } = routerSchema(router);
  const fields = modelFields(router, id, live?.capabilities, routerSchema(router).fields);
  const showAll = parsed.flags.all === true;
  const visible = Object.entries(fields).filter(([name, f]) => name !== "model" && (showAll || !f.deprecated));

  if (ctx.json) {
    ui.json({
      model: id,
      router,
      endpoint,
      narrowed_to_model: live !== null,
      required: required.filter((r) => r !== "model" && r in fields),
      fields: Object.fromEntries(visible.map(([name, f]) => [name, { ...f, flag: FIELD_FLAGS[name] ?? `--${name}` }])),
    });
    return ExitCode.Ok;
  }
  for (const line of renderInputs(id, router, ui.c, ui.width, {
    full: parsed.flags.full === true,
    all: showAll,
    fields,
    narrowed: live !== null,
  })) {
    ui.out(line);
  }
  return ExitCode.Ok;
}

const firstSentence = (text: string) => {
  const match = /^(.+?[.!?])(\s|$)/su.exec(text.trim());
  return (match?.[1] ?? text).replace(/\s+/gu, " ");
};

/** The inputs table, shared by `schema` and `run <model> --help`. */
export function renderInputs(
  model: string,
  router: Router,
  c: Palette,
  width: number,
  options: {
    full?: boolean;
    all?: boolean;
    /** The model's own fields (`modelFields`); the whole endpoint when absent. */
    fields?: Readonly<Record<string, FieldSchema>>;
    /** True when `fields` came from the live catalog row. */
    narrowed?: boolean;
  } = {},
): string[] {
  const schema = routerSchema(router);
  const { endpoint, required } = schema;
  const fields = options.fields ?? schema.fields;
  const rows: { name: string; type: string; flag: string; note: string; field: FieldSchema }[] = [];
  for (const [name, field] of Object.entries(fields)) {
    if (name === "model" || (field.deprecated && !options.all)) continue;
    rows.push({
      name: `${name}${required.includes(name) ? " *" : ""}`,
      type: fieldType(field),
      flag: FIELD_FLAGS[name] ?? `--${name}`,
      note: field.description ?? "",
      field,
    });
    for (const [sub, inner] of Object.entries(field.properties ?? {})) {
      rows.push({
        name: `  ${name}.${sub}${field.required?.includes(sub) ? " *" : ""}`,
        type: fieldType(inner),
        flag: `--${name}.${sub}`,
        note: inner.description ?? "",
        field: inner,
      });
    }
  }
  const nameWidth = Math.max(...rows.map((r) => r.name.length));
  const typeWidth = Math.min(Math.max(...rows.map((r) => r.type.length)), 32);
  const out = [`${c.bold(model)} ${c.dim("—")} inputs for ${endpoint}`, ""];
  out.push(c.dim(`${"FIELD".padEnd(nameWidth)}  ${"TYPE".padEnd(typeWidth)}  FLAG`));
  const noteWidth = Math.max(width - 6, 30);
  for (const row of rows) {
    const type = row.type.length > typeWidth ? `${row.type.slice(0, typeWidth - 1)}…` : row.type;
    out.push(`${row.name.padEnd(nameWidth)}  ${type.padEnd(typeWidth)}  ${c.dim(row.flag)}`);
    // The note goes under the row, where it has the whole width.
    const indent = row.name.startsWith("  ") ? "      " : "    ";
    const text = row.note.replace(/\s+/gu, " ").trim();
    if (!text) continue;
    if (options.full) {
      for (const line of wrap(text, noteWidth - indent.length)) out.push(`${indent}${c.dim(line)}`);
      if (row.field.enum && row.field.enum.length > 6) {
        for (const line of wrap(`One of: ${row.field.enum.join(", ")}`, noteWidth - indent.length)) {
          out.push(`${indent}${c.dim(line)}`);
        }
      }
    } else {
      const note = firstSentence(text);
      const room = noteWidth - indent.length;
      out.push(`${indent}${c.dim(note.length > room ? `${note.slice(0, room - 1)}…` : note)}`);
    }
  }
  out.push("");
  out.push(
    c.dim(
      "* required. Every field is a flag: --field value, dots for nested (--captions.style glass). --set field=value works too.",
    ),
  );
  if (options.narrowed === false)
    out.push(c.dim("The catalog did not answer, so this is every field of the endpoint, not only this model's."));
  if (!options.full)
    out.push(
      c.dim(`Whole descriptions: opensume schema ${model} --full. Limits and prices: opensume models ${model}.`),
    );
  return out;
}
