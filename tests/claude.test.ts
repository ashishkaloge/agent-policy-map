import { afterEach, describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { run, fix, byState, paths, findByPath, hasDiagnostic, mkTemp, rmTemp, writeFile } from "./helpers.js";

describe("claude adapter", () => {
  const importsRoot = fix("claude/imports");

  it("resolves relative imports and ignores fenced/inline imports", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    const importPaths = paths(map.sources.filter((s) => s.kind === "claude-import"));
    expect(importPaths).toContain("./docs/rel.md");
    // Fenced and inline code imports must not be followed.
    expect(importPaths).not.toContain("./docs/should-not-import.md");
    expect(importPaths).not.toContain("./docs/also-ignored.md");
  });

  it("follows imports up to 5 hops and reports over-depth", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    const importPaths = paths(map.sources.filter((s) => s.kind === "claude-import"));
    expect(importPaths).toContain("./docs/chain5.md");
    expect(importPaths).not.toContain("./docs/chain6.md");
    expect(hasDiagnostic(map, "import-over-depth")).toBe(true);
  });

  it("detects import cycles and missing imports", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    expect(hasDiagnostic(map, "import-cycle")).toBe(true);
    expect(hasDiagnostic(map, "missing-import")).toBe(true);
  });

  it("treats unconditional rules as active and non-matching path rules as excluded", () => {
    const root = fix("claude/rules");
    const map = run({
      agent: "claude",
      target: fix("claude/rules/src/app.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(map, "./.claude/rules/global.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/typescript.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/backend/typescript.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/python.md")?.state).toBe("excluded");
  });

  it("excludes memory matched by claudeMdExcludes", () => {
    const root = fix("claude/excludes");
    const map = run({
      agent: "claude",
      target: fix("claude/excludes/vendor/lib.ts"),
      cwd: root,
      root,
    });
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    const vendor = findByPath(map, "./vendor/CLAUDE.md");
    expect(vendor?.state).toBe("excluded");
    expect(vendor?.matchReason).toMatch(/claudeMdExcludes/);
    expect(findByPath(map, "./vendor/.claude/rules/ignored.md")?.state).toBe("excluded");
  });

  it("reports ambiguous same-scope CLAUDE.md and .claude/CLAUDE.md without inventing order", () => {
    const root = fix("claude/ambiguous");
    const map = run({
      agent: "claude",
      target: fix("claude/ambiguous/src/app.ts"),
      cwd: root,
      root,
    });
    expect(hasDiagnostic(map, "ambiguous-precedence")).toBe(true);
    // Both are present and active; neither is asserted to win.
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./CLAUDE.md")?.order).toBeUndefined();
    expect(findByPath(map, "./.claude/CLAUDE.md")?.order).toBeUndefined();
  });

  it("loads user rules only with opt-in and reports project-rule priority", () => {
    const root = fix("claude/rules");
    const map = run({
      agent: "claude",
      target: fix("claude/rules/src/app.ts"),
      cwd: root,
      root,
      includeUser: true,
      env: { HOME: fix("home/user") },
    });
    const userRule = findByPath(map, "~/.claude/rules/typescript.md");
    expect(userRule?.state).toBe("active");
    expect(userRule?.matchReason).toMatch(/project rules take priority/i);
  });

  it("marks managed and session state as unknown-external by default", () => {
    const root = fix("claude/rules");
    const map = run({ agent: "claude", target: fix("claude/rules/src/app.ts"), cwd: root, root });
    const unknown = byState(map, "unknown-external");
    expect(unknown.some((s) => s.kind === "claude-managed")).toBe(true);
    expect(unknown.some((s) => s.kind === "claude-session")).toBe(true);
  });

  it("does not read imports that resolve outside the project root", () => {
    const map = run({
      agent: "claude",
      target: fix("claude/imports/src/app.ts"),
      cwd: importsRoot,
      root: importsRoot,
    });
    // No external import in this fixture, but the safety property is asserted in safety.test.ts.
    expect(map.diagnostics.every((d) => d.code !== "external-import")).toBe(true);
  });
});

describe("Claude AGENTS.md discovery", () => {
  const temps: string[] = [];
  afterEach(() => { while (temps.length) rmTemp(temps.pop()!); });

  function project(files: Record<string, string>, mode?: string, plugin = "cc-plugin-agents-md@builtin") {
    const base = mkTemp("apm-claude-agents-");
    temps.push(base);
    const root = path.join(base, "project");
    const home = path.join(base, "home");
    for (const [file, content] of Object.entries(files)) writeFile(path.join(root, file), content);
    writeFile(path.join(root, "src/app.ts"), "export {};\n");
    if (mode !== undefined) writeFile(path.join(home, ".claude/settings.json"), JSON.stringify({
      pluginConfigs: { [plugin]: { options: { instructionFiles: mode } } },
    }));
    return { agent: "claude" as const, target: path.join(root, "src/app.ts"), cwd: root, root, env: { HOME: home } };
  }

  it("loads AGENTS.md and .claude/AGENTS.md by default and expands their imports", () => {
    const input = project({
      "AGENTS.md": "@shared.md\n", ".claude/AGENTS.md": "Dot-folder guidance.\n",
      "shared.md": "Shared guidance.\n", "src/AGENTS.md": "Nested guidance.\n",
      "AGENTS.override.md": "Not a Claude file.\n", "AGENTS.local.md": "Not a Claude file.\n",
    });
    const map = run(input);
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./shared.md")?.kind).toBe("claude-import");
    expect(findByPath(map, "./src/AGENTS.md")?.state).toBe("conditional");
    expect(findByPath(map, "./AGENTS.override.md")).toBeUndefined();
    expect(findByPath(map, "./AGENTS.local.md")).toBeUndefined();
    expect(map.assumptions.join(" ")).toContain("v2.1.285+");
  });

  it.each(["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"])(
    "suppresses fallback when %s exists on the launch path, even if empty",
    (name) => {
      const input = project({ "AGENTS.md": "Shared guidance.\n", [name]: "" });
      const map = run({ ...input, cwd: path.join(input.root, "src") });
      expect(findByPath(map, "./AGENTS.md")).toBeUndefined();
    },
  );

  it("lets nested Claude files suppress only their own AGENTS.md", () => {
    const map = run(project({
      "AGENTS.md": "Root guidance.\n", "src/CLAUDE.md": "Nested Claude guidance.\n",
      "src/AGENTS.md": "Nested shared guidance.\n",
    }));
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./src/CLAUDE.md")?.state).toBe("conditional");
    expect(findByPath(map, "./src/AGENTS.md")).toBeUndefined();
  });

  it("keeps user memory and project rules alongside automatic AGENTS.md", () => {
    const input = project({
      "AGENTS.md": "Shared guidance.\n", ".claude/rules/style.md": "Style guidance.\n",
    });
    writeFile(path.join(input.env.HOME, ".claude/CLAUDE.md"), "Personal guidance.\n");
    const map = run({ ...input, includeUser: true });
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "~/.claude/CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./.claude/rules/style.md")?.state).toBe("active");
  });

  it("applies exclusions to AGENTS.md without following excluded imports", () => {
    const input = project({ "AGENTS.md": "@shared.md\n", "shared.md": "Shared guidance.\n" });
    writeFile(path.join(input.root, ".claude/settings.json"), JSON.stringify({ claudeMdExcludes: ["**/AGENTS.md"] }));
    const map = run(input);
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("excluded");
    expect(findByPath(map, "./shared.md")).toBeUndefined();
  });

  it.each(["cc-plugin-agents-md@builtin", "agents-md@builtin"])(
    "honors the combined mode from user settings (%s) and deduplicates imports", (plugin) => {
      const input = project({
        "AGENTS.md": "@shared.md\n", "CLAUDE.md": "@AGENTS.md\n",
        "shared.md": "Shared guidance.\n", "src/AGENTS.md": "Nested shared guidance.\n",
        "src/CLAUDE.md": "Nested Claude guidance.\n",
      }, "claude-md-and-agents-md", plugin);
      const map = run({ ...input, includeUser: true });
      expect(map.sources.filter((s) => s.path === "./AGENTS.md")).toHaveLength(1);
      expect(findByPath(map, "./AGENTS.md")?.kind).toBe("claude-agents-md");
      expect(map.sources.filter((s) => s.path === "./shared.md")).toHaveLength(1);
      expect(findByPath(map, "./src/AGENTS.md")?.state).toBe("conditional");
      expect(findByPath(map, "./CLAUDE.md")!.order).toBeLessThan(findByPath(map, "./AGENTS.md")!.order!);
    },
  );

  it("does not read user instruction modes without opt-in or honor project/local modes", () => {
    const input = project({ "AGENTS.md": "Shared guidance.\n" }, "claude-md");
    const settings = JSON.stringify({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "managed-only" } } } });
    writeFile(path.join(input.root, ".claude/settings.json"), settings);
    writeFile(path.join(input.root, ".claude/settings.local.json"), settings);
    expect(findByPath(run(input), "./AGENTS.md")?.state).toBe("active");
    expect(findByPath(run({ ...input, includeUser: true }), "./AGENTS.md")).toBeUndefined();
  });

  it("does not count a CLAUDE.md symlink to AGENTS.md twice in combined mode", () => {
    const input = project({ "AGENTS.md": "@shared.md\n", "shared.md": "Shared guidance.\n" }, "claude-md-and-agents-md");
    fs.symlinkSync("AGENTS.md", path.join(input.root, "CLAUDE.md"));
    const map = run({ ...input, includeUser: true });
    expect(findByPath(map, "./CLAUDE.md")?.state).toBe("active");
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("excluded");
    expect(findByPath(map, "./AGENTS.md")?.matchReason).toContain("Already loaded through ./CLAUDE.md");
    expect(map.sources.filter((s) => s.path === "./shared.md")).toHaveLength(1);
  });

  it("keeps explicitly imported nested AGENTS.md active, including its imports", () => {
    const input = project({
      "CLAUDE.md": "@src/AGENTS.md\n", "src/AGENTS.md": "@shared.md\n",
      "src/shared.md": "Shared guidance.\n",
    }, "claude-md-and-agents-md");
    const map = run({ ...input, includeUser: true });
    expect(map.sources.filter((s) => s.path === "./src/AGENTS.md")).toHaveLength(1);
    expect(findByPath(map, "./src/AGENTS.md")?.state).toBe("active");
    expect(findByPath(map, "./src/shared.md")?.state).toBe("active");
  });

  it("models managed-only startup exclusions while retaining on-demand project rules", () => {
    const input = project({
      "AGENTS.md": "Shared guidance.\n", "CLAUDE.md": "Project guidance.\n",
      ".claude/rules/global.md": "Startup rule.\n",
      ".claude/rules/typed.md": "---\npaths: src/**/*.ts\n---\nTyped rule.\n",
      "src/CLAUDE.md": "Nested guidance.\n", "src/AGENTS.md": "Nested shared guidance.\n",
      "src/.claude/rules/local.md": "Nested rule.\n",
    }, "managed-only");
    const map = run({ ...input, includeUser: true });
    expect(findByPath(map, "./CLAUDE.md")).toBeUndefined();
    expect(findByPath(map, "./AGENTS.md")?.state).toBe("excluded");
    expect(findByPath(map, "./src/AGENTS.md")?.state).toBe("excluded");
    expect(findByPath(map, "./.claude/rules/global.md")?.state).toBe("excluded");
    expect(findByPath(map, "./.claude/rules/typed.md")?.state).toBe("active");
    expect(findByPath(map, "./src/CLAUDE.md")?.state).toBe("conditional");
    expect(findByPath(map, "./src/.claude/rules/local.md")?.state).toBe("conditional");
  });
});
