import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProjects } from "../../src/sessions/projects.js";

let claurpHomeDir: string;
let fakeHomeDir: string;
const originalHome = process.env.HOME;
const originalClaurpHome = process.env.CLAURP_HOME;

beforeEach(() => {
  claurpHomeDir = mkdtempSync(join(tmpdir(), "claurp-home-"));
  fakeHomeDir = mkdtempSync(join(tmpdir(), "claurp-fakehome-"));
  process.env.CLAURP_HOME = claurpHomeDir;
  process.env.HOME = fakeHomeDir;
});

afterEach(() => {
  if (originalClaurpHome === undefined) delete process.env.CLAURP_HOME;
  else process.env.CLAURP_HOME = originalClaurpHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(claurpHomeDir, { recursive: true, force: true });
  rmSync(fakeHomeDir, { recursive: true, force: true });
});

function writeConfig(config: unknown): void {
  writeFileSync(join(claurpHomeDir, "config.json"), JSON.stringify(config), "utf8");
}

describe("loadProjects", () => {
  it("(a) loads a valid config, expanding ~ to os.homedir() and mapping names to projects", () => {
    mkdirSync(join(fakeHomeDir, "notes"), { recursive: true });
    writeConfig({ defaultProject: "notes", projects: { notes: { cwd: "~/notes" } } });

    const { defaultProject, byName } = loadProjects();

    expect(defaultProject.name).toBe("notes");
    expect(defaultProject.cwd).toBe(join(fakeHomeDir, "notes"));
    expect(byName.get("notes")).toEqual({ name: "notes", cwd: join(fakeHomeDir, "notes") });
  });

  it("(b) throws a helpful error naming a template when the config file is missing", () => {
    // No config.json written to claurpHomeDir.
    expect(() => loadProjects()).toThrow(/template/i);
  });

  it("(c) throws when a project's cwd does not exist on disk", () => {
    const missingDir = join(fakeHomeDir, "does-not-exist");
    writeConfig({ defaultProject: "notes", projects: { notes: { cwd: missingDir } } });

    expect(() => loadProjects()).toThrow();
  });

  it("(d) throws when a project's cwd is relative rather than absolute", () => {
    writeConfig({ defaultProject: "notes", projects: { notes: { cwd: "dev/notes" } } });

    expect(() => loadProjects()).toThrow();
  });
});
