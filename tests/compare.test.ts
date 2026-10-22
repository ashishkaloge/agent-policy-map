import { describe, expect, it } from "vitest";
import path from "node:path";
import { compare } from "../src/core/compare.js";
import { SUGGESTION_DOCS } from "../src/core/suggest.js";
import type { AgentName, ComparisonSource } from "../src/types.js";
import { fix, mkTemp, rmTemp, writeFile } from "./helpers.js";

function compareFixture(
  fixtureRoot: string,
  target: string,
  cwd = fixtureRoot,
) {
  return compare({
    target,
    cwd,
    root: fixtureRoot,
    env: {},
  });
}

function sourceAt(
  sources: ComparisonSource[],
  sourcePath: string,
): ComparisonSource {
  const source = sources.find((candidate) => candidate.path === sourcePath);
  if (!source) throw new Error(`Missing comparison source ${sourcePath}`);
  return source;
}

function states(source: ComparisonSource, agent: AgentName): string[] {
  return source.agents[agent].map((entry) => entry.state);
}

describe("cross-agent comparison", () => {
  it("compares the four modeled surfaces in stable registry order", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(
      root,
      fix("copilot/basic/src/app.ts"),
    );

    expect(Object.keys(result.agents)).toEqual([
      "codex",
      "claude",
      "cursor",
      "copilot",
    ]);
    expect(Object.values(result.agents).map((agent) => agent.surface)).toEqual([
      "Codex CLI",
      "Claude Code",
      "Cursor IDE",
      "GitHub Copilot CLI",
    ]);
    expect(result.command).toBe("compare");
    expect(result.summary.meaningfulDifferences).toBe(14);
  });

  it("keeps agent-specific discovery and exclusion states honest", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(
      root,
      fix("copilot/basic/src/app.ts"),
    );
    const agents = sourceAt(result.sources, "./AGENTS.md");
    const claude = sourceAt(result.sources, "./CLAUDE.md");
    const excluded = sourceAt(
      result.sources,
      "./.github/instructions/python.instructions.md",
    );

    expect(states(agents, "codex")).toEqual(["active"]);
    expect(states(agents, "claude")).toEqual([]);
    expect(states(agents, "cursor")).toEqual(["active"]);
    expect(states(agents, "copilot")).toEqual(["active"]);
    expect(states(claude, "claude")).toEqual(["active"]);
    expect(states(claude, "copilot")).toEqual(["active"]);
    expect(states(excluded, "copilot")).toEqual(["excluded"]);
    expect(excluded.meaningfulDifference).toBe(false);
  });

  it.each([
    {
      root: "codex/nested",
      cwd: "codex/nested/apps/api",
      target: "codex/nested/apps/api/src/auth.ts",
      differences: 2,
    },
    {
      root: "claude/rules",
      cwd: "claude/rules",
      target: "claude/rules/src/app.ts",
      differences: 4,
    },
    {
      root: "cursor/modes",
      cwd: "cursor/modes",
      target: "cursor/modes/src/app.ts",
      differences: 6,
    },
  ])(
    "finds $differences meaningful differences in $root",
    ({ root, cwd, target, differences }) => {
      const result = compareFixture(fix(root), fix(target), fix(cwd));
      expect(result.summary.meaningfulDifferences).toBe(differences);
    },
  );

  it("is deterministic and never returns instruction content", () => {
    const root = fix("copilot/basic");
    const input = {
      target: fix("copilot/basic/src/app.ts"),
      cwd: root,
      root,
      env: {},
    };
    const first = JSON.stringify(compare(input));
    const second = JSON.stringify(compare(input));

    expect(second).toBe(first);
    expect(first).not.toContain("Use npm for installs across this repository.");
    expect(first).not.toContain('"contents"');
  });

  it("redacts sensitive paths without losing entries that share a redacted path", () => {
    const root = mkTemp("apm-compare-redaction-");
    try {
      const firstToken = ["sk", "proj", "FAKEFAKEFAKEFAKEFAKE"].join("-");
      const secondToken = ["sk", "proj", "OTHEROTHEROTHEROTHEROTHER"].join("-");
      writeFile(path.join(root, "src", "app.ts"), "export {};\n");
      writeFile(path.join(root, `${firstToken}.md`), "First imported policy.\n");
      writeFile(path.join(root, `${secondToken}.md`), "Second imported policy.\n");
      writeFile(
        path.join(root, "CLAUDE.md"),
        `@./${firstToken}.md\n@./${secondToken}.md\n`,
      );

      const result = compare({
        target: path.join(root, "src", "app.ts"),
        cwd: root,
        root,
        env: {},
      });
      const serialized = JSON.stringify(result);
      const redacted = result.sources.find(
        (source) => source.path === "./[REDACTED].md",
      );

      expect(serialized).not.toContain(firstToken);
      expect(serialized).not.toContain(secondToken);
      expect(redacted?.agents.claude).toHaveLength(2);
    } finally {
      rmTemp(root);
    }
  });
});

function suggestionsFor(
  source: ComparisonSource,
  agent: AgentName,
): string[] {
  return source.suggestions
    .filter((suggestion) => suggestion.agent === agent)
    .map((suggestion) => suggestion.text);
}

function compareTemp(
  files: Record<string, string>,
  target = "src/app.ts",
): ReturnType<typeof compare> {
  const root = mkTemp("apm-suggest-");
  try {
    for (const [file, content] of Object.entries(files)) {
      writeFile(path.join(root, file), content);
    }
    writeFile(path.join(root, target), "export {};\n");
    return compare({ target: path.join(root, target), cwd: root, root, env: {} });
  } finally {
    rmTemp(root);
  }
}

describe("documented suggestions", () => {
  it("suggests an AGENTS.md import for Claude Code next to each AGENTS.md", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(root, fix("copilot/basic/src/app.ts"));
    const agents = sourceAt(result.sources, "./AGENTS.md");
    const nested = sourceAt(result.sources, "./src/AGENTS.md");

    expect(agents.suggestions).toEqual([
      {
        agent: "claude",
        text: "add `@AGENTS.md` to ./CLAUDE.md, creating it if needed",
        reference: SUGGESTION_DOCS.claudeAgentsMd,
      },
    ]);
    expect(suggestionsFor(nested, "claude")).toEqual([
      "add `@AGENTS.md` to ./src/CLAUDE.md, creating it if needed",
    ]);
    expect(suggestionsFor(nested, "codex")).toEqual([
      "launch Codex from ./src; Codex CLI reads AGENTS.md only from the project root down to the launch directory",
    ]);
  });

  it("only suggests changes for agents that do not load a meaningful difference", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(root, fix("copilot/basic/src/app.ts"));
    const docs = new Set<string>(Object.values(SUGGESTION_DOCS));

    for (const source of result.sources) {
      if (!source.meaningfulDifference) {
        expect(source.suggestions).toEqual([]);
        continue;
      }
      for (const suggestion of source.suggestions) {
        expect(docs.has(suggestion.reference)).toBe(true);
        expect(
          source.agents[suggestion.agent].some((entry) =>
            ["active", "conditional", "manual"].includes(entry.state),
          ),
        ).toBe(false);
      }
    }
    expect(
      sourceAt(result.sources, "./.github/instructions/python.instructions.md")
        .suggestions,
    ).toEqual([]);
  });

  it("routes import-only files through the file that imports them", () => {
    const root = fix("copilot/basic");
    const result = compareFixture(root, fix("copilot/basic/src/app.ts"));
    const imported = sourceAt(result.sources, "./agents-shared.md");

    expect(suggestionsFor(imported, "claude")).toEqual([
      "it loads once Claude Code loads the file that @-imports it",
    ]);
    expect(suggestionsFor(imported, "codex")).toEqual([
      "move shared guidance into ./AGENTS.md, which Codex CLI reads",
    ]);
    expect(suggestionsFor(imported, "copilot")).toEqual([]);
  });

  it("offers a Codex fallback name only where no AGENTS.md exists", () => {
    const rules = compareFixture(
      fix("claude/rules"),
      fix("claude/rules/src/app.ts"),
    );
    const basic = compareFixture(
      fix("copilot/basic"),
      fix("copilot/basic/src/app.ts"),
    );

    expect(suggestionsFor(sourceAt(rules.sources, "./CLAUDE.md"), "codex")).toEqual([
      'list "CLAUDE.md" in project_doc_fallback_filenames, or move shared guidance into ./AGENTS.md, which Codex CLI reads',
    ]);
    expect(suggestionsFor(sourceAt(basic.sources, "./CLAUDE.md"), "codex")).toEqual([
      "move shared guidance into ./AGENTS.md, which Codex CLI reads",
    ]);
  });

  it("maps path-scoped rules to each agent's own rule format", () => {
    const result = compareFixture(
      fix("claude/rules"),
      fix("claude/rules/src/app.ts"),
    );
    const rule = sourceAt(result.sources, "./.claude/rules/typescript.md");

    expect(suggestionsFor(rule, "cursor")).toEqual([
      "copy it into ./.cursor/rules/ as an .mdc rule; `globs:` keeps it path-scoped",
    ]);
    expect(suggestionsFor(rule, "copilot")).toEqual([
      "copy it into ./.github/instructions/ as a *.instructions.md file with `applyTo` set to the files it covers",
    ]);
    expect(suggestionsFor(rule, "claude")).toEqual([]);
  });

  it("does not push manual Cursor rules into other agents", () => {
    const result = compareFixture(
      fix("cursor/modes"),
      fix("cursor/modes/src/app.ts"),
    );
    const manual = sourceAt(result.sources, "./.cursor/rules/manual.mdc");
    const helper = sourceAt(result.sources, "./helper.md");

    expect(manual.meaningfulDifference).toBe(true);
    expect(manual.suggestions).toEqual([]);
    expect(suggestionsFor(helper, "claude")).toEqual([
      "add `@helper.md` to ./CLAUDE.md",
    ]);
    expect(suggestionsFor(helper, "copilot")).toEqual([
      "add `@helper.md` to ./AGENTS.md",
    ]);
  });

  it("explains documented exclusions instead of suggesting a new file", () => {
    const override = compareFixture(
      fix("codex/override-basic"),
      fix("codex/override-basic/src/app.ts"),
    );
    const excludes = compareFixture(
      fix("claude/excludes"),
      fix("claude/excludes/vendor/lib.ts"),
    );

    expect(suggestionsFor(sourceAt(override.sources, "./AGENTS.md"), "codex")).toEqual([
      "merge it into ./AGENTS.override.md, which replaces AGENTS.md in that directory",
    ]);
    expect(sourceAt(override.sources, "./AGENTS.override.md").suggestions).toEqual([]);
    expect(
      sourceAt(excludes.sources, "./vendor/CLAUDE.md").suggestions.find(
        (suggestion) => suggestion.agent === "claude",
      ),
    ).toEqual({
      agent: "claude",
      text: "remove the claudeMdExcludes pattern that skips this file",
      reference: SUGGESTION_DOCS.claudeExcludes,
    });
  });

  it("points at the Codex byte cap when it truncates a shared file", () => {
    const result = compareTemp({
      ".codex/config.toml": "project_doc_max_bytes = 8\n",
      "AGENTS.md": "Use npm for installs across this repository.\n",
    });
    const agents = sourceAt(result.sources, "./AGENTS.md");

    expect(agents.meaningfulDifference).toBe(true);
    expect(suggestionsFor(agents, "codex")).toEqual([
      "shorten the AGENTS.md files on the launch path or raise project_doc_max_bytes (32 KiB by default)",
    ]);
  });

  it("leaves personal Claude files without suggestions", () => {
    const result = compareTemp({ "CLAUDE.local.md": "Personal notes.\n" });
    const local = sourceAt(result.sources, "./CLAUDE.local.md");

    expect(local.meaningfulDifference).toBe(true);
    expect(local.suggestions).toEqual([]);
  });
});
