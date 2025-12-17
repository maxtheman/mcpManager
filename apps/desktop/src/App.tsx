import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type BinaryStatus = { path: string; exists: boolean };
type ClientInstallStatus = { detected: boolean; installed: boolean; details?: string | null };
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
  cursor?: ClientInstallStatus | null;
  registry_path: string;
};
type ImportResult = {
  imported_codex: number;
  imported_claude_desktop: number;
  imported_cursor: number;
  registry: Registry;
  registry_path: string;
};

type Tab = "dashboard" | "servers" | "apply";

function okLabel(s: ClientInstallStatus | null | undefined) {
  if (!s) return "skipped";
  return s.installed ? "ok" : s.detected ? "failed" : "skipped";
}

function maskEnv(env: Record<string, string>) {
  const keys = Object.keys(env).sort();
  if (!keys.length) return null;
  return keys.map((k) => `${k}=*****`).join(", ");
}

function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(null);
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [snippetId, setSnippetId] = useState("");
  const [snippet, setSnippet] = useState("");
  const [expandedServer, setExpandedServer] = useState<string | null>(null);

  const [importCodex, setImportCodex] = useState(true);
  const [importClaudeDesktop, setImportClaudeDesktop] = useState(true);
  const [importCursor, setImportCursor] = useState(false);

  const [applyCodex, setApplyCodex] = useState(true);
  const [applyClaudeDesktop, setApplyClaudeDesktop] = useState(true);
  const [applyClaudeCode, setApplyClaudeCode] = useState(false);
  const [applyCursor, setApplyCursor] = useState(false);

  const [cursorProjectDir, setCursorProjectDir] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAct = useMemo(() => !busy, [busy]);

  async function refreshAll() {
    setError(null);
    try {
      const [st, reg] = await Promise.all([
        invoke<StatusResult>("get_status"),
        invoke<Registry>("registry_get"),
      ]);
      reg.upstreams.sort((a, b) => a.id.localeCompare(b.id));
      setStatus(st);
      setRegistry(reg);
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
      await refreshAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importFromClients() {
    setBusy(true);
    setError(null);
    setImportResult(null);
    try {
      const res = await invoke<ImportResult>("registry_import_from_clients", {
        codex: importCodex,
        claude_desktop: importClaudeDesktop,
        cursor: importCursor,
        cursor_project_dir: cursorProjectDir.trim() ? cursorProjectDir.trim() : null,
      });
      res.registry.upstreams.sort((a, b) => a.id.localeCompare(b.id));
      setRegistry(res.registry);
      setImportResult(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function addFromSnippet() {
    setBusy(true);
    setError(null);
    try {
      await invoke<Upstream>("registry_add_from_snippet", {
        id: snippetId.trim() ? snippetId.trim() : null,
        snippet,
      });
      setSnippet("");
      setSnippetId("");
      await refreshAll();
      setTab("servers");
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
      if (expandedServer === id) setExpandedServer(null);
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
        cursor: applyCursor,
        cursor_project_dir: cursorProjectDir.trim() ? cursorProjectDir.trim() : null,
      });
      setApplyResult(res);
      await refreshAll();
      setTab("dashboard");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    refreshAll();
  }, []);

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandTitle">mcpManager</div>
          <div className="brandSub">Registry → clients</div>
        </div>

        <nav className="nav">
          <button
            className={tab === "dashboard" ? "navBtn navBtnActive" : "navBtn"}
            onClick={() => setTab("dashboard")}
            disabled={busy}
          >
            Dashboard
          </button>
          <button
            className={tab === "servers" ? "navBtn navBtnActive" : "navBtn"}
            onClick={() => setTab("servers")}
            disabled={busy}
          >
            Servers
          </button>
          <button
            className={tab === "apply" ? "navBtn navBtnActive" : "navBtn"}
            onClick={() => setTab("apply")}
            disabled={busy}
          >
            Apply
          </button>
        </nav>

        <div className="sidebarFooter">
          <button className="primaryBtn" onClick={refreshAll} disabled={!canAct}>
            Refresh
          </button>
          <button onClick={installEverywhere} disabled={!canAct}>
            Install Gateway
          </button>
        </div>
      </aside>

      <section className="content">
        <header className="topbar">
          <div className="topbarTitle">
            {tab === "dashboard" ? "Dashboard" : tab === "servers" ? "Servers" : "Apply"}
          </div>
          {busy ? <div className="pill">Working…</div> : null}
        </header>

        {error ? <div className="errorBox">{error}</div> : null}

        {tab === "dashboard" ? (
          <div className="grid">
            <div className="card">
              <div className="cardTitle">Gateway</div>
              <div className="kv">
                <div className="k">Binary</div>
                <div className="v">
                  {status ? (
                    <>
                      <code>{status.gateway.path}</code>{" "}
                      <span className={status.gateway.exists ? "ok" : "bad"}>
                        {status.gateway.exists ? "present" : "missing"}
                      </span>
                    </>
                  ) : (
                    "…"
                  )}
                </div>
              </div>
              {installResult ? (
                <div className="note">
                  Last install: <code>{installResult.gateway_path}</code>
                </div>
              ) : null}
            </div>

            <div className="card">
              <div className="cardTitle">Clients</div>
              <div className="kv">
                <div className="k">Codex</div>
                <div className="v">
                  <span className={status?.codex?.installed ? "ok" : "bad"}>
                    {status?.codex?.installed ? "ok" : "not installed"}
                  </span>{" "}
                  {status?.codex?.details ? <code>{status.codex.details}</code> : null}
                </div>
              </div>
              <div className="kv">
                <div className="k">Claude Desktop</div>
                <div className="v">
                  <span className={status?.claude_desktop?.installed ? "ok" : "bad"}>
                    {status?.claude_desktop?.installed ? "ok" : "not installed"}
                  </span>{" "}
                  {status?.claude_desktop?.details ? (
                    <code>{status.claude_desktop.details}</code>
                  ) : null}
                </div>
              </div>
              <div className="kv">
                <div className="k">Claude Code</div>
                <div className="v">
                  {status?.claude_code?.detected ? "detected" : "not found"}
                </div>
              </div>
              {applyResult ? (
                <div className="note">
                  Last apply: Codex {okLabel(applyResult.codex)}, Claude Desktop{" "}
                  {okLabel(applyResult.claude_desktop)}, Claude Code{" "}
                  {okLabel(applyResult.claude_code)}, Cursor {okLabel(applyResult.cursor)}
                </div>
              ) : null}
            </div>

            <div className="card">
              <div className="cardTitle">Registry</div>
              <div className="kv">
                <div className="k">Servers</div>
                <div className="v">
                  {registry ? (
                    <>
                      {registry.upstreams.length}{" "}
                      <span className="muted">
                        ({registry.upstreams.filter((u) => u.enabled).length} enabled)
                      </span>
                    </>
                  ) : (
                    "…"
                  )}
                </div>
              </div>
              <div className="note">
                Use the Servers tab to import existing configs or paste a new server.
              </div>
            </div>
          </div>
        ) : null}

        {tab === "servers" ? (
          <div className="stack">
            <div className="card">
              <div className="cardTitle">Add / Import</div>
              <div className="split">
                <div>
                  <div className="sectionTitle">Import from configs</div>
                  <div className="checks">
                    <label>
                      <input
                        type="checkbox"
                        checked={importCodex}
                        onChange={(e) => setImportCodex(e.target.checked)}
                        disabled={busy}
                      />{" "}
                      Codex
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={importClaudeDesktop}
                        onChange={(e) => setImportClaudeDesktop(e.target.checked)}
                        disabled={busy}
                      />{" "}
                      Claude Desktop
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={importCursor}
                        onChange={(e) => setImportCursor(e.target.checked)}
                        disabled={busy}
                      />{" "}
                      Cursor project (`.cursor/mcp.json`)
                    </label>
                  </div>
                  {importCursor ? (
                    <input
                      value={cursorProjectDir}
                      onChange={(e) => setCursorProjectDir(e.target.value)}
                      disabled={busy}
                      placeholder="Cursor project dir (optional)"
                    />
                  ) : null}
                  <div className="toolbar">
                    <button onClick={importFromClients} disabled={!canAct}>
                      Import
                    </button>
                    {importResult ? (
                      <div className="muted">
                        Imported: Codex {importResult.imported_codex}, Claude Desktop{" "}
                        {importResult.imported_claude_desktop}, Cursor{" "}
                        {importResult.imported_cursor}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div>
                  <div className="sectionTitle">Paste a server</div>
                  <input
                    value={snippetId}
                    onChange={(e) => setSnippetId(e.target.value)}
                    disabled={busy}
                    placeholder="Optional ID override"
                  />
                  <textarea
                    value={snippet}
                    onChange={(e) => setSnippet(e.target.value)}
                    disabled={busy}
                    placeholder="Paste Codex TOML, Claude Desktop JSON, or a `claude mcp list` line"
                  />
                  <div className="toolbar">
                    <button onClick={addFromSnippet} disabled={!canAct || !snippet.trim()}>
                      Add / Update
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="cardTitle">Servers</div>
              {!registry ? (
                <div className="muted">Loading…</div>
              ) : registry.upstreams.length === 0 ? (
                <div className="muted">No servers yet. Import or paste one above.</div>
              ) : (
                <div className="table">
                  {registry.upstreams.map((u) => {
                    const open = expandedServer === u.id;
                    return (
                      <div key={u.id} className={open ? "rowItem rowOpen" : "rowItem"}>
                        <div className="rowMain">
                          <label className="toggle">
                            <input
                              type="checkbox"
                              checked={u.enabled}
                              onChange={(e) => toggleServer(u.id, e.target.checked)}
                              disabled={busy}
                            />
                            <span className="toggleLabel">{u.enabled ? "on" : "off"}</span>
                          </label>

                          <button
                            className="rowName"
                            onClick={() => setExpandedServer(open ? null : u.id)}
                            disabled={busy}
                            title="Show details"
                          >
                            <code>{u.id}</code>
                          </button>

                          <div className="rowCmd" title={`${u.command} ${u.args.join(" ")}`}>
                            <code>
                              {u.command} {u.args.join(" ")}
                            </code>
                          </div>

                          <div className="rowActions">
                            <button onClick={() => removeServer(u.id)} disabled={busy}>
                              Remove
                            </button>
                          </div>
                        </div>

                        {open ? (
                          <div className="rowDetails">
                            {maskEnv(u.env) ? (
                              <div>
                                <span className="muted">Env:</span> <code>{maskEnv(u.env)}</code>
                              </div>
                            ) : null}
                            {u.env_vars.length ? (
                              <div>
                                <span className="muted">Env Vars:</span>{" "}
                                <code>{u.env_vars.slice().sort().join(", ")}</code>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        ) : null}

        {tab === "apply" ? (
          <div className="stack">
            <div className="card">
              <div className="cardTitle">Targets</div>
              <div className="checks">
                <label>
                  <input
                    type="checkbox"
                    checked={applyCodex}
                    onChange={(e) => setApplyCodex(e.target.checked)}
                    disabled={busy}
                  />{" "}
                  Codex
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={applyClaudeDesktop}
                    onChange={(e) => setApplyClaudeDesktop(e.target.checked)}
                    disabled={busy}
                  />{" "}
                  Claude Desktop
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={applyClaudeCode}
                    onChange={(e) => setApplyClaudeCode(e.target.checked)}
                    disabled={busy}
                  />{" "}
                  Claude Code
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={applyCursor}
                    onChange={(e) => setApplyCursor(e.target.checked)}
                    disabled={busy}
                  />{" "}
                  Cursor project (`.cursor/mcp.json`)
                </label>
              </div>
              {applyCursor ? (
                <input
                  value={cursorProjectDir}
                  onChange={(e) => setCursorProjectDir(e.target.value)}
                  disabled={busy}
                  placeholder="Cursor project dir (optional)"
                />
              ) : null}
              <div className="toolbar">
                <button className="primaryBtn" onClick={applyRegistry} disabled={!canAct}>
                  Apply
                </button>
                <div className="muted">
                  Writes enabled servers and moves disabled ones into disabled sections.
                </div>
              </div>
            </div>

            {applyResult ? (
              <div className="card">
                <div className="cardTitle">Last apply</div>
                <div className="kv">
                  <div className="k">Codex</div>
                  <div className="v">{okLabel(applyResult.codex)}</div>
                </div>
                <div className="kv">
                  <div className="k">Claude Desktop</div>
                  <div className="v">{okLabel(applyResult.claude_desktop)}</div>
                </div>
                <div className="kv">
                  <div className="k">Claude Code</div>
                  <div className="v">{okLabel(applyResult.claude_code)}</div>
                </div>
                <div className="kv">
                  <div className="k">Cursor</div>
                  <div className="v">{okLabel(applyResult.cursor)}</div>
                </div>
                <div className="note">
                  Registry: <code>{applyResult.registry_path}</code>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default App;
