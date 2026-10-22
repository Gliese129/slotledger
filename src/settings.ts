import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Strictness } from "./types.js";
import { STRICTNESS } from "./types.js";

/** What each strictness level asks of the AI; shown in brief and when asking the user */
export const STRICTNESS_GUIDE: Record<Strictness, { summary: string; brief: string }> = {
  strict: {
    summary: "record every goal, approach, env and assum decision; the end-of-turn check nudges the AI about missed records and unverified work; work counts as done only after verify passes",
    brief: "Strictness: strict. Record every goal, approach, env and assum decision as soon as you make it. Work counts as done only after verify passes; don't leave tasks at implemented.",
  },
  balanced: {
    summary: "record goal, approach and env decisions and the assumptions they rest on; the end-of-turn check nudges the AI once about missed records",
    brief: "Strictness: balanced. Record goal, approach and env decisions and the assumptions they rest on; skip execution details.",
  },
  loose: {
    summary: "only goal and approach decisions need recording; the end-of-turn check never interrupts the AI and only adds a note to the report",
    brief: "Strictness: loose. Only goal and approach decisions need recording; everything else is optional.",
  },
};

export function strictnessOf(config: Config): Strictness {
  return config.strictness ?? "balanced";
}

export function isConfigured(config: Config): boolean {
  return !!config.language && !!config.strictness;
}

/** The exact command an AI should run to save the user's choices */
export function configCommand(): string {
  const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(cli)} config --language "<language>" --strictness <${STRICTNESS.join("|")}>`;
}

/** Brief section: either how to record (configured) or what to ask the user first (not configured) */
export function settingsBrief(config: Config): string[] {
  if (!isConfigured(config)) {
    const missing = [!config.language && "language", !config.strictness && "strictness"].filter(Boolean).join(" and ");
    return [
      `⚠ slotboard ${missing} not set for this project. Before recording anything, ask the user:`,
      "1. Which language should decisions, rationales, task titles and questions be written in?",
      `2. How strict should recording be? ${STRICTNESS.map((s) => `${s}: ${STRICTNESS_GUIDE[s].summary}`).join("; ")}. (balanced is the default.)`,
      `Then save their answers with: ${configCommand()}`,
      ...(config.language ? [`Language so far: ${config.language}.`] : []),
      ...(config.strictness ? [STRICTNESS_GUIDE[config.strictness].brief] : []),
    ];
  }
  return [
    `Language: write slot values, rationales, task titles and questions in ${config.language}; keep userQuote verbatim.`,
    STRICTNESS_GUIDE[config.strictness!].brief,
  ];
}

export interface SettingsInput {
  language?: string;
  strictness?: string;
}

export function validateSettings(input: SettingsInput): string | null {
  if (input.strictness && !(STRICTNESS as readonly string[]).includes(input.strictness)) {
    return `--strictness must be one of ${STRICTNESS.join(", ")}; got ${input.strictness}.`;
  }
  if (input.language !== undefined && !input.language.trim()) return "--language can't be empty.";
  return null;
}

/** Merge the given settings into .project/config.json, keeping everything else */
export function writeSettings(root: string, input: SettingsInput): Config {
  const p = join(root, ".project", "config.json");
  const cur = existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : { topics: [], acceptAfterSessions: 3 };
  const next = {
    ...cur,
    ...(input.language ? { language: input.language.trim() } : {}),
    ...(input.strictness ? { strictness: input.strictness } : {}),
  };
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2) + "\n");
  return next;
}
