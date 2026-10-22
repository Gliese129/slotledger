import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

/** Merge the server into project config, preserving other servers and slotboard tool policies. */
export function codexConfig(root: string, node: string, self: string): string {
  const path = join(root, ".codex", "config.toml");
  const config = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  const table = (value: unknown): Record<string, any> => {
    if (value === undefined) return {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Expected a TOML table in ${path}`);
    return value as Record<string, any>;
  };
  const servers = table(config.mcp_servers);
  const previous = table(servers.slotboard);
  // Switching this named server to stdio must also remove incompatible HTTP settings.
  const { url, bearer_token_env_var, http_headers, env_http_headers, http_headers_helper, auth, oauth, ...settings } = previous;
  config.mcp_servers = {
    ...servers,
    slotboard: {
      ...settings,
      command: node,
      args: [self],
      cwd: root,
      env: { ...table(previous.env), SLOTBOARD_ROOT: root, SLOTBOARD_CLIENT: "codex" },
      env_vars: [...new Set([...(Array.isArray(previous.env_vars) ? previous.env_vars : []), "CODEX_THREAD_ID"])],
      tool_timeout_sec: previous.tool_timeout_sec ?? 3600,
    },
  };
  return stringify(config);
}

export function installCodex(root: string, config: string, self: string): void {
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "config.toml"), config);
  const skillDir = join(root, ".agents", "skills", "slotboard");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), readFileSync(join(dirname(self), "..", "skill", "SKILL.md")));
}
