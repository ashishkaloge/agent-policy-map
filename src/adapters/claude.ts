import path from "node:path";
import fs from "node:fs";
import type { Diagnostic, PolicySource, SourceState } from "../types.js";
import type { AdapterResult, AgentAdapter, InspectContext } from "./types.js";
import { MAX_WALK_DEPTH } from "../constants.js";
import {
  dirsRootToLeaf,
  displayFor,
  isDir,
  isFile,
  loadFile,
  makeSource,
  readTextForContext,
  sourceFromFile,
  symlinkDiagnostics,
  type LoadedFile,
} from "./shared.js";
import { isInside, relPosix, toPosix } from "../fs/paths.js";
import { isReadError } from "../fs/read.js";
import { walkDir } from "../fs/walk.js";
import { parseFrontmatter } from "../frontmatter/parse.js";
import { validateFrontmatter } from "../frontmatter/validate.js";
import { matchPatterns, normalizePatterns } from "../match/glob.js";
import { resolveImports } from "./claude-imports.js";
import { ruleScope } from "./rule-scope.js";

const SURFACE = "Claude Code";

export const claudeAdapter: AgentAdapter = {
  name: "claude",
  surface: SURFACE,
  inspect(ctx: InspectContext): AdapterResult {
    const sources: PolicySource[] = [];
    const diagnostics: Diagnostic[] = [];
    const assumptions: string[] = [];
    let order = 0;

    const { excludes, instructionMode } = readClaudeSettings(ctx, diagnostics);
    const managedOnly = instructionMode === "managed-only";
    const importRoots: Array<{ file: LoadedFile; state: SourceState }> = [];
    const loadedMemories = new Map<string, string>();

    const addMemory: AddMemory = (file, kind, state, reason, options = {}) => {
      const excludedBy =
        options.excludable === false
          ? undefined
          : excludes.find((glob) => matchPatterns([glob], toPosix(file.abs)).matched);
      if (excludedBy) {
        sources.push(
          sourceFromFile(file, {
            kind,
            state: "excluded",
            matchReason: `Excluded by claudeMdExcludes pattern "${excludedBy}"`,
          }),
        );
        return;
      }
      const identity = memoryIdentity(file.abs);
      const previous = loadedMemories.get(identity);
      if (kind === "claude-agents-md" && previous !== undefined) {
        sources.push(sourceFromFile(file, {
          kind, state: "excluded",
          matchReason: `Already loaded through ${previous}; Claude does not read the same AGENTS.md twice`,
        }));
        return;
      }
      const init =
        state === "active" && options.ordered !== false
          ? { kind, state, order: ++order, matchReason: reason }
          : { kind, state, matchReason: reason };
      sources.push(sourceFromFile(file, init));
      if (state === "active" || state === "conditional") {
        importRoots.push({ file, state });
        loadedMemories.set(identity, file.display);
      }
    };

    // 1. Managed (enterprise) policy: a real system file, opt-in to read.
    if (ctx.includeUser) {
      const managed = managedPath();
      if (managed) {
        const f = loadFile(ctx, managed);
        if (f && f.read) {
          addMemory(f, "claude-managed", "active", "Managed enterprise policy (system location)", {
            excludable: false,
          });
        }
      }
    } else {
      sources.push(
        makeSource({
          path: "(managed enterprise policy)",
          kind: "claude-managed",
          state: "unknown-external",
          matchReason:
            "Managed enterprise policy lives in a system location and may be set by an administrator; not inspected without --include-user",
        }),
      );
    }

    // 2. User memory (~/.claude/CLAUDE.md), opt-in.
    if (!managedOnly && ctx.includeUser && ctx.env.home) {
      const f = loadFile(ctx, path.join(ctx.env.home, ".claude", "CLAUDE.md"));
      if (f && f.read) addMemory(f, "claude-user-memory", "active", "User memory at ~/.claude/CLAUDE.md");
    } else if (!ctx.includeUser) {
      assumptions.push(
        "User memory (~/.claude/CLAUDE.md) was not inspected. Pass --include-user to include it.",
      );
    }

    // 3. Project memory: root → cwd, all active (documented recursive read).
    const rootToCwd = dirsRootToLeaf(ctx.root, ctx.cwd);
    const loadAgents =
      instructionMode === "claude-md-and-agents-md" ||
      (instructionMode === "claude-md-or-agents-md" && !rootToCwd.some(hasClaudeMemory));
    for (const dir of rootToCwd) {
      if (!managedOnly) {
        collectDirMemories(ctx, dir, "active", "on the root→cwd memory path", addMemory, diagnostics);
      }
      if (loadAgents || managedOnly) {
        collectAgentMemories(ctx, dir, managedOnly ? "excluded" : "active", managedOnly
          ? "Project instructions is managed-only; project AGENTS.md files are not loaded"
          : `on the root→cwd memory path (Project instructions: ${instructionMode})`, addMemory);
      }
    }

    // 4. Nested memory below cwd toward the target: conditional lazy loads.
    const targetDir = path.dirname(ctx.targetAbs);
    if (isInside(ctx.cwd, targetDir) && targetDir !== ctx.cwd) {
      const below = dirsRootToLeaf(ctx.cwd, targetDir).filter((d) => d !== ctx.cwd);
      for (const dir of below) {
        collectDirMemories(
          ctx,
          dir,
          "conditional",
          "below cwd; loaded lazily only when Claude reads a file in this subtree",
          addMemory,
          diagnostics,
        );
        if (loadAgents && (instructionMode === "claude-md-and-agents-md" || !hasClaudeMemory(dir))) {
          collectAgentMemories(ctx, dir, "conditional",
            "below cwd; loaded lazily when Claude reads a file in this subtree", addMemory);
        } else if (managedOnly) {
          collectAgentMemories(ctx, dir, "excluded",
            "Project instructions is managed-only; project AGENTS.md files are not loaded", addMemory);
        }
      }
    }

    // 5. Imports for every discovered memory file.
    // In combined mode, an AGENTS.md already loaded directly must not also
    // appear as an import (including through a symlink). Its imports are
    // expanded once from its own root below.
    const directAgents = new Map(importRoots
      .filter(({ file }) => path.basename(file.abs) === "AGENTS.md")
      .map((memory) => [memoryIdentity(memory.file.abs), memory]));
    for (const { file, state } of importRoots) {
      const res = resolveImports(
        ctx,
        { abs: file.abs, content: file.read.content, display: file.display },
        state,
        new Set(directAgents.keys()),
        (identity) => {
          const direct = directAgents.get(identity);
          if (direct && state === "active" && direct.state === "conditional") {
            direct.state = "active";
            const source = sources.find((entry) => entry.path === direct.file.display && entry.kind === "claude-agents-md");
            if (source) {
              source.state = "active";
              source.matchReason = `AGENTS.md imported by active memory at ${file.display}`;
            }
          }
        },
      );
      sources.push(...res.sources);
      diagnostics.push(...res.diagnostics);
    }

    // 6. User and project rules under .claude/rules/**/*.md.
    if (!managedOnly && ctx.includeUser && ctx.env.home) {
      discoverClaudeRules(
        ctx,
        sources,
        diagnostics,
        excludes,
        path.join(ctx.env.home, ".claude", "rules"),
        true,
      );
    }
    discoverClaudeRules(ctx, sources, diagnostics, excludes, undefined, false, managedOnly);

    // 7. Local, project, and session-derived state we cannot see.
    sources.push(
      makeSource({
        path: "(session / --add-dir memory)",
        kind: "claude-session",
        state: "unknown-external",
        matchReason:
          "Memory added at runtime (e.g. session #-memories, --add-dir roots) is not visible to a static local scan",
      }),
    );

    assumptions.push(
      "Order reflects the documented load sequence, not a guaranteed conflict winner; Claude does not define a universal precedence for conflicting instructions.",
      "CLAUDE.md files above --root are outside this inspection scope and may still be loaded by Claude Code.",
      `Models current Claude Code (v2.1.285+) with its AGENTS.md plugin available and Project instructions set to ${instructionMode}. Automatic AGENTS.md discovery began in v2.1.277. Plugin availability, session --settings, and managed settings overrides are not inspected.`,
      "AGENTS.md files above --root are outside this inspection scope; a CLAUDE.md or CLAUDE.local.md there can disable automatic AGENTS.md fallback.",
    );
    if (!ctx.includeUser) assumptions.push(
      "The Project instructions setting in user settings was not inspected; the documented claude-md-or-agents-md default is assumed. Pass --include-user to read user settings.",
    );

    return { surface: SURFACE, sources, diagnostics, assumptions, omittedByCapBytes: 0 };
  },
};

function managedPath(): string | null {
  switch (process.platform) {
    case "darwin":
      return "/Library/Application Support/ClaudeCode/CLAUDE.md";
    case "win32":
      return path.join(process.env["ProgramFiles"] ?? "C:\\Program Files", "ClaudeCode", "CLAUDE.md");
    default:
      return "/etc/claude-code/CLAUDE.md";
  }
}

type AddMemory = (
  file: LoadedFile,
  kind: string,
  state: SourceState,
  reason: string,
  options?: { excludable?: boolean; ordered?: boolean },
) => void;

function hasClaudeMemory(dir: string): boolean {
  return ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]
    .some((name) => isFile(path.join(dir, name)));
}

function memoryIdentity(abs: string): string {
  try { return fs.realpathSync(abs); } catch { return abs; }
}

function collectAgentMemories(
  ctx: InspectContext,
  dir: string,
  state: SourceState,
  where: string,
  add: AddMemory,
): void {
  for (const name of ["AGENTS.md", ".claude/AGENTS.md"]) {
    const file = loadFile(ctx, path.join(dir, name));
    if (file?.read) add(file, "claude-agents-md", state, `${name} ${where}`);
  }
}

/**
 * Collect CLAUDE.md, .claude/CLAUDE.md, and CLAUDE.local.md in one directory.
 * When both CLAUDE.md and .claude/CLAUDE.md exist, emit an ambiguity
 * diagnostic instead of inventing an order between them.
 */
function collectDirMemories(
  ctx: InspectContext,
  dir: string,
  state: SourceState,
  where: string,
  add: AddMemory,
  diagnostics: Diagnostic[],
): void {
  const rootMd = loadFile(ctx, path.join(dir, "CLAUDE.md"));
  const dotMd = loadFile(ctx, path.join(dir, ".claude", "CLAUDE.md"));
  const localMd = loadFile(ctx, path.join(dir, "CLAUDE.local.md"));

  const ambiguous = Boolean(rootMd?.read && dotMd?.read);
  if (rootMd && rootMd.read) {
    add(rootMd, "claude-memory", state, `CLAUDE.md ${where}`, { ordered: !ambiguous });
  }
  if (dotMd && dotMd.read) {
    add(dotMd, "claude-memory", state, `.claude/CLAUDE.md ${where}`, {
      ordered: !ambiguous,
    });
  }
  if (localMd && localMd.read) {
    add(localMd, "claude-local-memory", state, `CLAUDE.local.md ${where}`);
  }

  if (rootMd && rootMd.read && dotMd && dotMd.read) {
    diagnostics.push({
      code: "ambiguous-precedence",
      level: "warning",
      message: `Both CLAUDE.md and .claude/CLAUDE.md exist in ${displayFor(ctx, dir) || "."}; official docs do not define which wins`,
      paths: [rootMd.display, dotMd.display],
    });
  }
}

function discoverClaudeRules(
  ctx: InspectContext,
  sources: PolicySource[],
  diagnostics: Diagnostic[],
  excludes: string[],
  userRulesDir?: string,
  userRules = false,
  managedOnly = false,
): void {
  const targetDir = path.dirname(ctx.targetAbs);
  const leaf = isInside(ctx.root, targetDir) ? targetDir : ctx.cwd;
  const walks = userRules
    ? userRulesDir && isDir(userRulesDir)
      ? [
          walkDir(userRulesDir, {
            root: userRulesDir,
            budget: ctx.walkBudget,
            maxDepth: MAX_WALK_DEPTH,
            filter: (abs) => abs.endsWith(".md"),
          }),
        ]
      : []
    : ctx.mode === "discover"
      ? [
          walkDir(ctx.root, {
            root: ctx.root,
            budget: ctx.walkBudget,
            maxDepth: MAX_WALK_DEPTH,
            filter: isClaudeRule,
          }),
        ]
      : dirsRootToLeaf(ctx.root, leaf)
          .map((dir) => path.join(dir, ".claude", "rules"))
          .filter(isDir)
          .map((dir) =>
            walkDir(dir, {
              root: ctx.root,
              budget: ctx.walkBudget,
              maxDepth: MAX_WALK_DEPTH,
              filter: isClaudeRule,
            }),
          );
  const targetRelRoot = relPosix(ctx.root, ctx.targetAbs);

  for (const res of walks) {
    diagnostics.push(...symlinkDiagnostics(ctx, res));
    for (const entry of res.files) {
      const read = readTextForContext(ctx, entry.abs);
      if (isReadError(read)) continue;
      const display = displayFor(ctx, entry.abs);
      const parsed = parseFrontmatter(read.content);
      diagnostics.push(...validateFrontmatter("claude-rule", parsed, display));

      const excludedBy = excludes.find((glob) =>
        matchPatterns([glob], toPosix(entry.abs)).matched,
      );
      if (excludedBy) {
        sources.push(
          makeSource({
            path: display,
            kind: userRules ? "claude-user-rule" : "claude-rule",
            state: "excluded",
            matchReason: `Excluded by claudeMdExcludes absolute-path pattern "${excludedBy}"`,
            bytes: read.bytes,
            lines: read.lines,
            contentHash: read.contentHash,
          }),
        );
        continue;
      }

      // Scope: a nested .claude/rules applies to its containing directory subtree.
      const scopeDir = userRules ? ctx.root : (ruleScope(entry.abs, ".claude") ?? ctx.root);
      const inScope =
        userRules ||
        ctx.mode === "discover" ||
        isInside(scopeDir, ctx.targetAbs) ||
        scopeDir === ctx.root;

      const fm = parsed.data ?? {};
      const patterns = normalizePatterns(fm["paths"]);

      let state: SourceState;
      let reason: string;
      if (managedOnly && patterns.length === 0 && isInside(scopeDir, ctx.cwd)) {
        state = "excluded";
        reason = "Project instructions is managed-only; unscoped project rules are not loaded at launch";
      } else if (!inScope) {
        state = "excluded";
        reason = `Rule scope ${displayFor(ctx, scopeDir) || "."} does not contain the target`;
      } else if (patterns.length === 0) {
        state = managedOnly ? "conditional" : "active";
        reason = userRules
          ? "User rule has no `paths`, so it applies in scope; project rules take priority on conflicts"
          : managedOnly
            ? "Nested project rule loads on demand when Claude opens a file in its subtree"
            : "Project rule has no `paths`, so it applies to all files in scope";
      } else if (ctx.mode === "discover") {
        state = "conditional";
        reason = `Path-scoped rule: applies to files matching \`paths\` (${patterns.join(", ")})`;
      } else {
        const m = matchPatterns(patterns, targetRelRoot);
        if (m.matched) {
          state = "active";
          reason = userRules
            ? `User rule \`paths\` matched via "${m.by}"; project rules take priority on conflicts`
            : `Rule \`paths\` matched the target via "${m.by}"`;
        } else {
          state = "excluded";
          reason = `Rule \`paths\` (${patterns.join(", ")}) do not match the target`;
        }
      }

      sources.push(
        makeSource({
          path: display,
          kind: userRules ? "claude-user-rule" : "claude-rule",
          state,
          matchReason: reason,
          bytes: read.bytes,
          lines: read.lines,
          contentHash: read.contentHash,
        }),
      );
    }
  }
}

function isClaudeRule(abs: string): boolean {
  return abs.endsWith(".md") && toPosix(abs).includes("/.claude/rules/");
}

type InstructionMode = "claude-md-or-agents-md" | "claude-md-and-agents-md" | "claude-md" | "managed-only";
const INSTRUCTION_MODES = new Set<string>([
  "claude-md-or-agents-md", "claude-md-and-agents-md", "claude-md", "managed-only",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

/** Project/local settings contribute exclusions, but cannot set instructionFiles. */
function readClaudeSettings(ctx: InspectContext, diagnostics: Diagnostic[]): {
  excludes: string[];
  instructionMode: InstructionMode;
} {
  const patterns: string[] = [];
  let instructionMode: InstructionMode = "claude-md-or-agents-md";
  const userSettings = ctx.includeUser && ctx.env.home
    ? path.join(ctx.env.home, ".claude", "settings.json") : undefined;
  const settings = [
    ...(userSettings ? [userSettings] : []),
    path.join(ctx.root, ".claude", "settings.json"),
    path.join(ctx.root, ".claude", "settings.local.json"),
  ];
  for (const p of settings) {
    if (!isFile(p)) continue;
    const read = readTextForContext(ctx, p);
    if (isReadError(read)) continue;
    try {
      const json = record(JSON.parse(read.content));
      const raw = json["claudeMdExcludes"];
      if (Array.isArray(raw)) {
        for (const v of raw) if (typeof v === "string") patterns.push(v);
      }
      if (p === userSettings) {
        const plugins = record(json["pluginConfigs"]);
        const config = record(plugins["cc-plugin-agents-md@builtin"] ?? plugins["agents-md@builtin"]);
        const mode = record(config["options"])["instructionFiles"];
        if (typeof mode === "string" && INSTRUCTION_MODES.has(mode)) {
          instructionMode = mode as InstructionMode;
        } else if (mode !== undefined) {
          diagnostics.push({
            code: "invalid-settings", level: "warning",
            message: "Unsupported Project instructions value in user settings; assuming claude-md-or-agents-md",
            paths: [displayFor(ctx, p)],
          });
        }
      }
    } catch {
      diagnostics.push({
        code: "invalid-settings",
        level: "warning",
        message: `Could not parse ${displayFor(ctx, p)} as JSON; instruction settings ignored`,
        paths: [displayFor(ctx, p)],
      });
    }
  }
  return { excludes: patterns, instructionMode };
}
