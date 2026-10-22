import picomatch from "picomatch";
import { basename } from "node:path";
import type { Change } from "./git.js";
import type { SlotState, State } from "./fold.js";
import type { Config, Topic } from "./types.js";

const IGNORED = (p: string) => p.startsWith(".project/") || p === "STATUS.md";

const DEP_MANIFESTS = new Set([
  "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "pom.xml",
  "build.gradle", "build.gradle.kts", "Podfile", "Package.swift", "composer.json",
]);
const isDepManifest = (p: string) => DEP_MANIFESTS.has(basename(p)) || /requirements[^/]*\.txt$/.test(p);

const isSchema = picomatch([
  "**/migrations/**", "**/migrate/**", "**/*.sql", "**/schema.*", "**/*.prisma",
  "**/*.proto", "**/openapi.*", "**/*.graphql",
], { dot: true });

const isDoc = (p: string) => /\.(md|mdx)$/i.test(p);

export interface Analysis {
  changes: Change[];
  undeclared: { topic: string; files: string[] }[];
  /** Coarse hint when no topics are configured: code changed but this session recorded no decision */
  coarse?: { files: number };
  newDocs: string[];
  depManifests: string[];
  schemaUndeclared: string[];
}

/** A slot's topics: explicit topics plus any topic id that appears in the key name */
export function slotTopics(slot: SlotState, topics: Topic[]): string[] {
  const name = slot.key.split("/").slice(1).join("/");
  const inferred = topics.filter((t) => name.split(/[-_/.]/).includes(t.id) || name === t.id).map((t) => t.id);
  return [...new Set([...slot.topics, ...inferred])];
}

export function topicsForPath(path: string, topics: Topic[]): string[] {
  return topics.filter((t) => picomatch(t.paths, { dot: true })(path)).map((t) => t.id);
}

export function analyze(state: State, config: Config, sessionId: string, changes: Change[]): Analysis {
  const relevant = changes.filter((c) => !IGNORED(c.path));
  const session = state.sessions.get(sessionId);
  const wrote = (session?.wrote ?? []).map((k) => state.slots.get(k)).filter((s): s is SlotState => !!s);

  const declared = new Set(wrote.flatMap((s) => slotTopics(s, config.topics)));
  const byTopic = new Map<string, string[]>();
  for (const c of relevant) {
    for (const t of topicsForPath(c.path, config.topics)) {
      if (!byTopic.has(t)) byTopic.set(t, []);
      byTopic.get(t)!.push(c.path);
    }
  }
  const undeclared = [...byTopic].filter(([t]) => !declared.has(t)).map(([topic, files]) => ({ topic, files }));

  const code = relevant.filter((c) => !isDoc(c.path));
  const coarse = config.topics.length === 0 && wrote.length === 0 && code.length > 0 ? { files: code.length } : undefined;

  return {
    changes: relevant,
    undeclared,
    coarse,
    newDocs: relevant.filter((c) => c.status === "A" && isDoc(c.path)).map((c) => c.path),
    depManifests: relevant.filter((c) => isDepManifest(c.path)).map((c) => c.path),
    schemaUndeclared: wrote.some((s) => s.category === "approach") ? [] : relevant.filter((c) => isSchema(c.path)).map((c) => c.path),
  };
}
