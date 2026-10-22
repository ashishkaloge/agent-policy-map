import path from "node:path";
import { AGENT_NAMES } from "../adapters/registry.js";
import type {
  AgentName,
  ComparisonSource,
  ComparisonSuggestion,
  PolicySource,
} from "../types.js";

/**
 * Official documentation behind every suggestion. Each suggestion relies on
 * one documented discovery rule; none of them claims what an agent obeys.
 */
export const SUGGESTION_DOCS = {
  claudeImports: "https://code.claude.com/docs/en/memory#import-additional-files",
  claudeAgentsMd:
    "https://code.claude.com/docs/en/memory#share-one-file-with-other-coding-tools",
  claudeRules: "https://code.claude.com/docs/en/memory#path-specific-rules",
  claudeExcludes:
    "https://code.claude.com/docs/en/memory#exclude-specific-claude-md-files",
  codex: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
  cursor: "https://cursor.com/docs/rules",
  copilot:
    "https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-custom-instructions",
} as const;

const LOADABLE_STATES = new Set(["active", "conditional", "manual"]);

/**
 * Whole files another agent can import or absorb. Cursor rule references
 * count here because Cursor documents them as pointers the agent may open,
 * not as imports that Claude Code or Copilot CLI would expand.
 */
const DOC_KINDS = new Set([
  "codex-agents-md",
  "codex-agents-fallback",
  "claude-memory",
  "claude-agents-md",
  "cursor-agents-md",
  "cursor-reference",
  "copilot-agents-md",
  "copilot-claude-md",
  "copilot-gemini-md",
  "copilot-repo-instructions",
]);
/** Agent-specific rule formats that can carry their own path scope. */
const RULE_KINDS = new Set(["claude-rule", "cursor-mdc", "copilot-path-instructions"]);
/** Files reached through `@` imports that Claude Code and Copilot CLI both expand. */
const IMPORT_KINDS = new Set(["claude-import", "copilot-import"]);
const CODEX_DOC_KINDS = new Set([
  "codex-agents-md",
  "codex-agents-override",
  "codex-agents-fallback",
]);
/** Files Copilot CLI reads by name in its standard locations. */
const COPILOT_NAMES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "GEMINI.md",
  ".github/copilot-instructions.md",
]);
/** Instruction files other agents read by name, which Codex can adopt as fallbacks. */
const CODEX_FALLBACK_NAMES = new Set(["CLAUDE.md", "GEMINI.md"]);
const SCOPE_MARKERS = new Set([".github", ".claude", ".cursor"]);

type Family = "doc" | "rule" | "import";

type ProjectFile = {
  /** Root-relative POSIX path without the leading `./`. */
  rel: string;
  name: string;
  /** Directory the file sits in, `.` for the project root. */
  dir: string;
  /** Directory the file applies to: the parent of `.github`, `.claude`, or `.cursor`. */
  scope: string;
};

type SuggestContext = {
  /** Display path of the launch directory, as in `PolicyComparison.cwd`. */
  cwd: string;
  sources: ComparisonSource[];
};

type SuggestInput = {
  entries: PolicySource[];
  file: ProjectFile;
  family: Family;
  context: SuggestContext;
};

type Suggestion = Omit<ComparisonSuggestion, "agent">;

function projectRel(display: string): string | null {
  if (!display.startsWith("./") || display === "./") return null;
  return display.slice(2);
}

function projectFile(rel: string): ProjectFile {
  const parts = rel.split("/");
  let marker = -1;
  for (let i = parts.length - 2; i >= 0; i--) {
    if (SCOPE_MARKERS.has(parts[i] ?? "")) {
      marker = i;
      break;
    }
  }
  const dir = path.posix.dirname(rel);
  const scope = marker === -1 ? dir : parts.slice(0, marker).join("/") || ".";
  return { rel, name: path.posix.basename(rel), dir, scope };
}

/** Display a root-relative directory or a file inside it, e.g. `./src/CLAUDE.md`. */
function at(dir: string, file = ""): string {
  if (dir === ".") return `./${file}`;
  return file === "" ? `./${dir}` : `./${dir}/${file}`;
}

function isAncestorOrSelf(dir: string, of: string): boolean {
  return dir === "." || of === dir || of.startsWith(`${dir}/`);
}

function loadable(entries: PolicySource[]): boolean {
  return entries.some((entry) => LOADABLE_STATES.has(entry.state));
}

/**
 * Classify a row by the kinds that load it. Manual-only rows are on demand by
 * design, so no other agent is told to load them automatically.
 */
function familyOf(source: ComparisonSource): Family | null {
  const kinds = new Set(
    AGENT_NAMES.flatMap((agent) =>
      source.agents[agent]
        .filter((entry) => entry.state === "active" || entry.state === "conditional")
        .map((entry) => entry.kind),
    ),
  );
  if (kinds.size === 0) return null;
  if ([...kinds].every((kind) => IMPORT_KINDS.has(kind))) return "import";
  if ([...kinds].some((kind) => RULE_KINDS.has(kind))) return "rule";
  if ([...kinds].some((kind) => DOC_KINDS.has(kind))) return "doc";
  return null;
}

function codexReadsDocIn(dir: string, sources: ComparisonSource[]): boolean {
  return sources.some((source) => {
    const rel = projectRel(source.path);
    return (
      rel !== null &&
      path.posix.dirname(rel) === dir &&
      source.agents.codex.some(
        (entry) => CODEX_DOC_KINDS.has(entry.kind) && LOADABLE_STATES.has(entry.state),
      )
    );
  });
}

function suggestClaude({ entries, file, family }: SuggestInput): Suggestion | undefined {
  if (entries.length > 0) {
    if (loadable(entries)) return undefined;
    return entries.some((entry) => entry.matchReason.includes("claudeMdExcludes"))
      ? {
          text: "remove the claudeMdExcludes pattern that skips this file",
          reference: SUGGESTION_DOCS.claudeExcludes,
        }
      : undefined;
  }
  if (family === "import") {
    return {
      text: "it loads once Claude Code loads the file that @-imports it",
      reference: SUGGESTION_DOCS.claudeImports,
    };
  }
  if (family === "rule") {
    return {
      text: `copy it into ${at(file.scope, ".claude/rules/")} as a .md rule; a \`paths:\` field keeps it path-scoped`,
      reference: SUGGESTION_DOCS.claudeRules,
    };
  }
  if (file.name === "AGENTS.md") {
    return {
      text: `add \`@AGENTS.md\` to ${at(file.dir, "CLAUDE.md")}, creating it if needed`,
      reference: SUGGESTION_DOCS.claudeAgentsMd,
    };
  }
  return {
    text: `add \`@${path.posix.relative(file.scope, file.rel)}\` to ${at(file.scope, "CLAUDE.md")}`,
    reference: SUGGESTION_DOCS.claudeImports,
  };
}

function suggestCodex({ entries, file, family, context }: SuggestInput): Suggestion | undefined {
  if (entries.some((entry) => /project-doc (byte )?cap/.test(entry.matchReason))) {
    return {
      text: "shorten the AGENTS.md files on the launch path or raise project_doc_max_bytes (32 KiB by default)",
      reference: SUGGESTION_DOCS.codex,
    };
  }
  if (entries.length > 0) {
    if (loadable(entries)) return undefined;
    return entries.some((entry) => entry.matchReason.startsWith("Replaced by AGENTS.override.md"))
      ? {
          text: `merge it into ${at(file.dir, "AGENTS.override.md")}, which replaces AGENTS.md in that directory`,
          reference: SUGGESTION_DOCS.codex,
        }
      : undefined;
  }

  const onPath = isAncestorOrSelf(file.scope, projectRel(context.cwd) ?? ".");
  if (family === "doc" && file.name === "AGENTS.md" && file.dir === file.scope) {
    return onPath
      ? undefined
      : {
          text: `launch Codex from ${at(file.dir)}; Codex CLI reads AGENTS.md only from the project root down to the launch directory`,
          reference: SUGGESTION_DOCS.codex,
        };
  }
  const destination = onPath
    ? `${at(file.scope, "AGENTS.md")}, which Codex CLI reads`
    : "an AGENTS.md between the project root and the launch directory";
  if (
    CODEX_FALLBACK_NAMES.has(file.name) &&
    file.dir === file.scope &&
    onPath &&
    !codexReadsDocIn(file.dir, context.sources)
  ) {
    return {
      text: `list "${file.name}" in project_doc_fallback_filenames, or move shared guidance into ${destination}`,
      reference: SUGGESTION_DOCS.codex,
    };
  }
  return {
    text: `move shared guidance into ${destination}`,
    reference: SUGGESTION_DOCS.codex,
  };
}

function suggestCursor({ entries, file, family }: SuggestInput): Suggestion | undefined {
  // Cursor applies AGENTS.md to its own directory subtree, so a missing one is
  // outside the target's path by design.
  if (entries.length > 0 || file.name === "AGENTS.md") return undefined;
  if (family === "rule") {
    return {
      text: `copy it into ${at(file.scope, ".cursor/rules/")} as an .mdc rule; \`globs:\` keeps it path-scoped`,
      reference: SUGGESTION_DOCS.cursor,
    };
  }
  return {
    text:
      family === "import"
        ? "copy it into an AGENTS.md or .cursor/rules/*.mdc rule that covers the target"
        : `move shared guidance into ${at(file.scope, "AGENTS.md")} or a .cursor/rules/*.mdc rule`,
    reference: SUGGESTION_DOCS.cursor,
  };
}

function suggestCopilot({ entries, file, family }: SuggestInput): Suggestion | undefined {
  if (entries.length > 0) return undefined;
  if (family === "import") {
    return {
      text: "it loads once Copilot CLI loads the file that @-references it",
      reference: SUGGESTION_DOCS.copilot,
    };
  }
  if (family === "rule") {
    return {
      text: `copy it into ${at(file.scope, ".github/instructions/")} as a *.instructions.md file with \`applyTo\` set to the files it covers`,
      reference: SUGGESTION_DOCS.copilot,
    };
  }
  // A known name that Copilot CLI skipped sits outside its standard locations.
  if (COPILOT_NAMES.has(path.posix.relative(file.scope, file.rel))) return undefined;
  return {
    text: `add \`@${path.posix.relative(file.scope, file.rel)}\` to ${at(file.scope, "AGENTS.md")}`,
    reference: SUGGESTION_DOCS.copilot,
  };
}

const SUGGESTERS: Record<AgentName, (input: SuggestInput) => Suggestion | undefined> = {
  codex: suggestCodex,
  claude: suggestClaude,
  cursor: suggestCursor,
  copilot: suggestCopilot,
};

/**
 * Suggest documented changes for one meaningful difference in a project file.
 * Rows outside the project, manual-only rules, and personal or agent-specific
 * files such as CLAUDE.local.md, AGENTS.override.md, and skills get none.
 */
export function suggestChanges(
  source: ComparisonSource,
  context: SuggestContext,
): ComparisonSuggestion[] {
  if (!source.meaningfulDifference) return [];
  const rel = projectRel(source.path);
  if (rel === null) return [];
  const family = familyOf(source);
  if (family === null) return [];

  const file = projectFile(rel);
  const suggestions: ComparisonSuggestion[] = [];
  for (const agent of AGENT_NAMES) {
    const suggestion = SUGGESTERS[agent]({
      entries: source.agents[agent],
      file,
      family,
      context,
    });
    if (suggestion) suggestions.push({ agent, ...suggestion });
  }
  return suggestions;
}
