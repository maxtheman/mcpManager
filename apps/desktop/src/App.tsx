import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type BinaryStatus = { path: string; exists: boolean };
type ClientInstallStatus = {
  detected: boolean;
  installed: boolean;
  details?: string | null;
};
type StatusResult = {
  gateway: BinaryStatus;
  codex: ClientInstallStatus;
  claude_desktop: ClientInstallStatus;
  claude_code: ClientInstallStatus;
};
type InstallResult = {
  gateway_path: string;
  codex: ClientInstallStatus;
  claude_desktop: ClientInstallStatus;
  claude_code: ClientInstallStatus;
};

type Upstream = {
  id: string;
  enabled: boolean;
  command: string;
  args: string[];
  env: Record<string, string>;
  env_vars: string[];
};

type Registry = { version: number; upstreams: Upstream[] };

type ApplyResult = {
  codex?: ClientInstallStatus | null;
  claude_desktop?: ClientInstallStatus | null;
  claude_code?: ClientInstallStatus | null;
  registry_path: string;
};

function App() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [snippetId, setSnippetId] = useState("");
  const [snippet, setSnippet] = useState("");
  const [applyCodex, setApplyCodex] = useState(true);
  const [applyClaudeDesktop, setApplyClaudeDesktop] = useState(true);
  const [applyClaudeCode, setApplyClaudeCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canInstall = useMemo(() => !busy, [busy]);

  async function refreshStatus() {
    setError(null);
    try {
      const next = await invoke<StatusResult>("get_status");
      setStatus(next);
    } catch (e) {
      setError(String(e));
    }
  }

  async function installEverywhere() {
    setBusy(true);
    setError(null);
    setInstallResult(null);
    try {
      const res = await invoke<InstallResult>("install_gateway_everywhere");
      setInstallResult(res);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshRegistry() {
    setError(null);
    try {
      const next = await invoke<Registry>("registry_get");
      next.upstreams.sort((a, b) => a.id.localeCompare(b.id));
      setRegistry(next);
    } catch (e) {
      setError(String(e));
    }
  }

  async function addFromSnippet() {
    setBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      await invoke<Upstream>("registry_add_from_snippet", {
        id: snippetId.trim() ? snippetId.trim() : null,
        snippet,
      });
      setSnippet("");
      await refreshRegistry();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleServer(id: string, enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<Registry>("registry_set_enabled", { id, enabled });
      next.upstreams.sort((a, b) => a.id.localeCompare(b.id));
      setRegistry(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeServer(id: string) {
    setBusy(true);
    setError(null);
    try {
      const next = await invoke<Registry>("registry_remove", { id });
      next.upstreams.sort((a, b) => a.id.localeCompare(b.id));
      setRegistry(next);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyRegistry() {
    setBusy(true);
    setError(null);
    setApplyResult(null);
    try {
      const res = await invoke<ApplyResult>("registry_apply", {
        codex: applyCodex,
        claude_desktop: applyClaudeDesktop,
        claude_code: applyClaudeCode,
      });
      setApplyResult(res);
      await refreshStatus();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshStatus();
    refreshRegistry();
  }, []);

  return (
    <main className="container">
      <h1>mcpManager</h1>
      <p>Installs the local MCP gateway and registers it with Codex / Claude.</p>

      <div className="row">
        <button onClick={refreshStatus} disabled={busy}>
          Refresh
        </button>
        <button onClick={installEverywhere} disabled={!canInstall}>
          {busy ? "Working…" : "Install / Update + Register"}
        </button>
        <button onClick={refreshRegistry} disabled={busy}>
          Refresh Servers
        </button>
      </div>

      {error ? (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>{error}</p>
      ) : null}

      {status ? (
        <div style={{ textAlign: "left", maxWidth: 900, margin: "0 auto" }}>
          <h2>Status</h2>
          <ul>
            <li>
              Gateway binary:{" "}
              <code>{status.gateway.path}</code>{" "}
              {status.gateway.exists ? "(present)" : "(missing)"}
            </li>
            <li>
              Codex: {status.codex.installed ? "installed" : "not installed"}{" "}
              <span style={{ opacity: 0.7 }}>
                (<code>{status.codex.details}</code>)
              </span>
            </li>
            <li>
              Claude Desktop:{" "}
              {status.claude_desktop.installed ? "installed" : "not installed"}{" "}
              <span style={{ opacity: 0.7 }}>
                (<code>{status.claude_desktop.details}</code>)
              </span>
            </li>
            <li>
              Claude Code CLI:{" "}
              {status.claude_code.detected ? "detected" : "not found"}{" "}
              {status.claude_code.installed ? "(installed)" : ""}
            </li>
          </ul>
        </div>
      ) : null}

      {installResult ? (
        <div style={{ textAlign: "left", maxWidth: 900, margin: "0 auto" }}>
          <h2>Last install</h2>
          <ul>
            <li>
              Gateway path: <code>{installResult.gateway_path}</code>
            </li>
            <li>
              Codex:{" "}
              {installResult.codex.installed ? "ok" : "failed"}{" "}
              <span style={{ opacity: 0.7 }}>{installResult.codex.details}</span>
            </li>
            <li>
              Claude Desktop:{" "}
              {installResult.claude_desktop.installed ? "ok" : "failed"}{" "}
              <span style={{ opacity: 0.7 }}>
                {installResult.claude_desktop.details}
              </span>
            </li>
            <li>
              Claude Code:{" "}
              {installResult.claude_code.installed ? "ok" : "skipped/failed"}{" "}
              <span style={{ opacity: 0.7 }}>
                {installResult.claude_code.details}
              </span>
            </li>
          </ul>
        </div>
      ) : null}

      <div style={{ textAlign: "left", maxWidth: 900, margin: "24px auto" }}>
        <h2>Servers</h2>
        <p style={{ opacity: 0.8 }}>
          Paste a server snippet (Codex TOML, Claude Desktop JSON, or a line from{" "}
          <code>claude mcp list</code>) and mcpManager will store it in{" "}
          <code>~/.mcpmanager/registry.json</code>. Toggle enabled/disabled, then apply to clients.
        </p>

        <div style={{ display: "grid", gap: 8 }}>
          <label>
            Optional ID override (if snippet doesn't contain a name):{" "}
            <input
              value={snippetId}
              onChange={(e) => setSnippetId(e.target.value)}
              disabled={busy}
              style={{ width: "100%" }}
              placeholder="e.g. playwright2"
            />
          </label>
          <label>
            Snippet:
            <textarea
              value={snippet}
              onChange={(e) => setSnippet(e.target.value)}
              disabled={busy}
              style={{ width: "100%", minHeight: 120 }}
              placeholder={`Examples:\n\n[mcp_servers.playwright]\ncommand = \"npx\"\nargs = [\"@playwright/mcp@latest\"]\n\nor\n\n{\"command\":\"npx\",\"args\":[\"-y\",\"@playwright/mcp@latest\"],\"env\":{\"API_KEY\":\"...\"}}\n\nor\n\nplaywright: npx -y @playwright/mcp@latest - ✓ Connected`}
            />
          </label>
          <div className="row">
            <button onClick={addFromSnippet} disabled={busy || !snippet.trim()}>
              Add / Update From Snippet
            </button>
          </div>
        </div>

        <h3 style={{ marginTop: 18 }}>Registry</h3>
        {registry ? (
          registry.upstreams.length ? (
            <ul>
              {registry.upstreams.map((u) => (
                <li key={u.id} style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <code style={{ minWidth: 140 }}>{u.id}</code>
                    <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <input
                        type="checkbox"
                        checked={u.enabled}
                        onChange={(e) => toggleServer(u.id, e.target.checked)}
                        disabled={busy}
                      />
                      enabled
                    </label>
                    <button onClick={() => removeServer(u.id)} disabled={busy}>
                      Remove
                    </button>
                  </div>
                  <div style={{ opacity: 0.85 }}>
                    <div>
                      <span style={{ opacity: 0.7 }}>Command:</span>{" "}
                      <code>
                        {u.command} {u.args.join(" ")}
                      </code>
                    </div>
                    {Object.keys(u.env).length ? (
                      <div>
                        <span style={{ opacity: 0.7 }}>Env:</span>{" "}
                        <code>
                          {Object.keys(u.env)
                            .sort()
                            .map((k) => `${k}=*****`)
                            .join(", ")}
                        </code>
                      </div>
                    ) : null}
                    {u.env_vars.length ? (
                      <div>
                        <span style={{ opacity: 0.7 }}>Env Vars:</span>{" "}
                        <code>{u.env_vars.slice().sort().join(", ")}</code>
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p style={{ opacity: 0.8 }}>No servers in registry yet.</p>
          )
        ) : (
          <p style={{ opacity: 0.8 }}>Loading…</p>
        )}

        <h3 style={{ marginTop: 18 }}>Apply</h3>
        <div style={{ display: "grid", gap: 6, maxWidth: 520 }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={applyCodex}
              onChange={(e) => setApplyCodex(e.target.checked)}
              disabled={busy}
            />
            Write to Codex config (`~/.codex/config.toml`)
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={applyClaudeDesktop}
              onChange={(e) => setApplyClaudeDesktop(e.target.checked)}
              disabled={busy}
            />
            Write to Claude Desktop config (macOS)
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={applyClaudeCode}
              onChange={(e) => setApplyClaudeCode(e.target.checked)}
              disabled={busy}
            />
            Apply to Claude Code CLI (runs `claude mcp add-json/remove`)
          </label>
          <button onClick={applyRegistry} disabled={busy}>
            Apply Registry To Clients
          </button>
        </div>

        {applyResult ? (
          <div style={{ marginTop: 12 }}>
            <h4>Last apply</h4>
            <pre style={{ whiteSpace: "pre-wrap" }}>
              {JSON.stringify(applyResult, null, 2)}
            </pre>
          </div>
        ) : null}
      </div>
    </main>
  );
}

export default App;
