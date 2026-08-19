// Named projects config: ~/.claurp/config.json (CLAURP_HOME respected, see paths.ts).
// Input validation at the boundary (spec §8: sanitize paths) -- every cwd is ~-expanded,
// resolved to an absolute path, and rejected if it is still relative or does not exist on disk.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { claurpHome } from "../paths.js";

export interface Project {
  name: string;
  cwd: string;
}

const ProjectEntrySchema = z.object({ cwd: z.string().min(1) });
const ConfigSchema = z.object({
  defaultProject: z.string().min(1),
  projects: z.record(ProjectEntrySchema),
});

function configPath(): string {
  return join(claurpHome(), "config.json");
}

function template(): string {
  return JSON.stringify(
    { defaultProject: "notes", projects: { notes: { cwd: "~/dev/notes" } } },
    null,
    2,
  );
}

function missingConfigError(path: string): Error {
  return new Error(
    `claurp config not found at ${path}. Create it -- for example, from this template:\n${template()}`,
  );
}

function invalidConfigError(path: string, detail: string): Error {
  return new Error(
    `claurp config at ${path} is invalid: ${detail}\nExpected shape, e.g. this template:\n${template()}`,
  );
}

/** Expands a leading `~`, resolves to an absolute path, and validates it (spec §8). */
function resolveCwd(projectName: string, rawCwd: string): string {
  const expanded = rawCwd === "~" || rawCwd.startsWith("~/") ? join(homedir(), rawCwd.slice(1)) : rawCwd;
  if (!isAbsolute(expanded)) {
    throw new Error(
      `project "${projectName}" has a relative cwd ("${rawCwd}"); cwd must be absolute or ~-prefixed.`,
    );
  }
  const resolved = resolve(expanded);
  if (!existsSync(resolved)) {
    throw new Error(`project "${projectName}" cwd does not exist: ${resolved}`);
  }
  return resolved;
}

export function loadProjects(): { defaultProject: Project; byName: Map<string, Project> } {
  const path = configPath();
  if (!existsSync(path)) throw missingConfigError(path);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw invalidConfigError(path, `not valid JSON (${(err as Error).message})`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw invalidConfigError(path, parsed.error.message);

  const byName = new Map<string, Project>();
  for (const [name, entry] of Object.entries(parsed.data.projects)) {
    byName.set(name, { name, cwd: resolveCwd(name, entry.cwd) });
  }

  const defaultProject = byName.get(parsed.data.defaultProject);
  if (!defaultProject) {
    throw invalidConfigError(
      path,
      `defaultProject "${parsed.data.defaultProject}" is not one of the declared projects`,
    );
  }

  return { defaultProject, byName };
}
