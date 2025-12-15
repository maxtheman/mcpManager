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

function App() {
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [installResult, setInstallResult] = useState<InstallResult | null>(
    null,
  );
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

  useEffect(() => {
    refreshStatus();
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
    </main>
  );
}

export default App;
