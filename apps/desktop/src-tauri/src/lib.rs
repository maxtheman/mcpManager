use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::Manager;
use toml_edit::{value, Array, DocumentMut, Item, Table};

#[derive(Debug, Serialize)]
struct InstallResult {
    gateway_path: String,
    codex: ClientInstallStatus,
    claude_desktop: ClientInstallStatus,
    claude_code: ClientInstallStatus,
}

#[derive(Debug, Serialize)]
struct StatusResult {
    gateway: BinaryStatus,
    codex: ClientInstallStatus,
    claude_desktop: ClientInstallStatus,
    claude_code: ClientInstallStatus,
}

#[derive(Debug, Serialize)]
struct BinaryStatus {
    path: String,
    exists: bool,
}

#[derive(Debug, Serialize)]
struct ClientInstallStatus {
    detected: bool,
    installed: bool,
    details: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Registry {
    version: u32,
    upstreams: Vec<Upstream>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Upstream {
    id: String,
    #[serde(default = "default_true")]
    enabled: bool,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    env_vars: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[allow(non_snake_case)]
#[derive(Debug, Deserialize)]
struct ClaudeDesktopConfig {
    #[serde(default)]
    mcpServers: serde_json::Map<String, serde_json::Value>,
    #[serde(flatten)]
    other: serde_json::Map<String, serde_json::Value>,
}

fn home_dir() -> Result<PathBuf> {
    // Prefer environment variables so tests and sandboxed environments can redirect safely.
    #[cfg(unix)]
    {
        if let Some(home) = std::env::var_os("HOME") {
            return Ok(PathBuf::from(home));
        }
    }
    #[cfg(windows)]
    {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            return Ok(PathBuf::from(home));
        }
    }
    dirs::home_dir().ok_or_else(|| anyhow!("Could not resolve home directory"))
}

fn gateway_install_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".mcpmanager").join("bin").join("mcpmanager-gateway"))
}

fn registry_path() -> Result<PathBuf> {
    if let Ok(p) = std::env::var("MCPMANAGER_REGISTRY_PATH") {
        if !p.trim().is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    Ok(home_dir()?
        .join(".mcpmanager")
        .join("registry.json"))
}

fn codex_config_path() -> Result<PathBuf> {
    Ok(home_dir()?.join(".codex").join("config.toml"))
}

#[cfg(target_os = "macos")]
fn claude_desktop_config_path() -> Result<PathBuf> {
    Ok(home_dir()?
        .join("Library")
        .join("Application Support")
        .join("Claude")
        .join("claude_desktop_config.json"))
}

#[cfg(not(target_os = "macos"))]
fn claude_desktop_config_path() -> Result<PathBuf> {
    Err(anyhow!(
        "Claude Desktop config path not implemented for this OS yet"
    ))
}

fn backup_path(original: &Path) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let file_name = original
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("config");
    original.with_file_name(format!("{file_name}.bak.{stamp}"))
}

fn write_with_backup(path: &Path, contents: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create dir {parent:?}"))?;
    }
    if path.exists() {
        let backup = backup_path(path);
        fs::copy(path, &backup)
            .with_context(|| format!("backup {:?} -> {:?}", path, backup))?;
    }
    fs::write(path, contents).with_context(|| format!("write {:?}", path))?;
    Ok(())
}

fn read_registry() -> Result<Registry> {
    let path = registry_path()?;
    if !path.exists() {
        return Ok(Registry {
            version: 1,
            upstreams: vec![],
        });
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {:?}", path))?;
    let mut reg: Registry =
        serde_json::from_str(&text).with_context(|| format!("parse JSON {:?}", path))?;
    if reg.version == 0 {
        reg.version = 1;
    }
    Ok(reg)
}

fn write_registry(reg: &Registry) -> Result<PathBuf> {
    let path = registry_path()?;
    let text = serde_json::to_string_pretty(reg).context("serialize registry JSON")?;
    write_with_backup(&path, (text + "\n").as_bytes())?;
    Ok(path)
}

fn split_command_line(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
                continue;
            }
            if ch == '\\' && q == '"' {
                if let Some(next) = chars.next() {
                    cur.push(next);
                    continue;
                }
            }
            cur.push(ch);
            continue;
        }

        if ch == '\'' || ch == '"' {
            quote = Some(ch);
            continue;
        }

        if ch.is_whitespace() {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
            continue;
        }

        if ch == '\\' {
            if let Some(next) = chars.next() {
                cur.push(next);
                continue;
            }
        }

        cur.push(ch);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn parse_upstream_from_snippet(snippet: &str, default_id: Option<&str>) -> Result<Upstream> {
    let snippet = snippet.trim();
    if snippet.is_empty() {
        return Err(anyhow!("Empty snippet"));
    }

    // 1) JSON: either an upstream object or a Claude Desktop-style { mcpServers: { id: {..} } }.
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(snippet) {
        if let Some(obj) = v.as_object() {
            if let (Some(command), Some(args)) = (obj.get("command"), obj.get("args")) {
                let id = default_id
                    .map(|s| s.to_string())
                    .or_else(|| obj.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .or_else(|| obj.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                    .ok_or_else(|| anyhow!("Missing id/name; provide an id field"))?;
                let enabled = obj
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                let command = command
                    .as_str()
                    .ok_or_else(|| anyhow!("command must be a string"))?
                    .to_string();
                let args = args
                    .as_array()
                    .ok_or_else(|| anyhow!("args must be an array"))?
                    .iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                let env = obj
                    .get("env")
                    .and_then(|v| v.as_object())
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                            .collect::<std::collections::BTreeMap<_, _>>()
                    })
                    .unwrap_or_default();
                let env_vars = obj
                    .get("env_vars")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                return Ok(Upstream {
                    id,
                    enabled,
                    command,
                    args,
                    env,
                    env_vars,
                });
            }

            if let Some(servers) = obj.get("mcpServers").and_then(|v| v.as_object()) {
                let id = default_id
                    .map(|s| s.to_string())
                    .or_else(|| servers.keys().next().cloned())
                    .ok_or_else(|| anyhow!("No mcpServers entries found"))?;
                let server = servers
                    .get(&id)
                    .and_then(|v| v.as_object())
                    .ok_or_else(|| anyhow!("mcpServers entry must be an object"))?;
                let command = server
                    .get("command")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| anyhow!("mcpServers.<id>.command missing"))?
                    .to_string();
                let args = server
                    .get("args")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let env_raw = server.get("env").and_then(|v| v.as_object()).cloned();
                let mut env = std::collections::BTreeMap::new();
                let mut env_vars = Vec::new();
                if let Some(map) = env_raw {
                    for (k, v) in map.iter() {
                        if let Some(s) = v.as_str() {
                            if s == format!("${{{}}}", k) {
                                env_vars.push(k.clone());
                            } else {
                                env.insert(k.clone(), s.to_string());
                            }
                        }
                    }
                }
                return Ok(Upstream {
                    id,
                    enabled: true,
                    command,
                    args,
                    env,
                    env_vars,
                });
            }
        }
    }

    // 2) Codex TOML snippet
    if snippet.contains("[mcp_servers.") {
        let doc = snippet
            .parse::<DocumentMut>()
            .context("parse TOML snippet")?;
        let servers = doc
            .get("mcp_servers")
            .and_then(|v| v.as_table())
            .ok_or_else(|| anyhow!("No [mcp_servers] table found in snippet"))?;

        let id = if let Some(id) = default_id {
            id.to_string()
        } else if servers.len() == 1 {
            servers
                .iter()
                .next()
                .map(|(k, _)| k.to_string())
                .ok_or_else(|| anyhow!("No servers found"))?
        } else {
            return Err(anyhow!("Multiple servers found; provide an id"));
        };

        let server = servers
            .get(&id)
            .and_then(|v| v.as_table())
            .ok_or_else(|| anyhow!("Server {id} not found in snippet"))?;

        let command = server
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("command missing"))?
            .to_string();
        let args = server
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let enabled = server
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let env = server
            .get("env")
            .and_then(|v| v.as_table())
            .map(|t| {
                t.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string())))
                    .collect::<std::collections::BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        let env_vars = server
            .get("env_vars")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        return Ok(Upstream {
            id,
            enabled,
            command,
            args,
            env,
            env_vars,
        });
    }

    // 3) Claude Code list line: `name: cmd args - ✓ Connected`
    if let Some((name, rest)) = snippet.split_once(':') {
        let name = name.trim();
        let rest = rest.trim();
        if !name.is_empty() && !rest.is_empty() {
            let cmd_part = rest.split(" - ").next().unwrap_or(rest).trim();
            let parts = split_command_line(cmd_part);
            if !parts.is_empty() {
                return Ok(Upstream {
                    id: default_id.unwrap_or(name).to_string(),
                    enabled: true,
                    command: parts[0].clone(),
                    args: parts[1..].to_vec(),
                    env: Default::default(),
                    env_vars: vec![],
                });
            }
        }
    }

    Err(anyhow!("Unsupported snippet format. Paste Codex TOML, Claude Desktop JSON, or a `claude mcp list` line."))
}

fn find_bundled_gateway(app: &tauri::AppHandle) -> Result<Option<PathBuf>> {
    let resource_dir = app
        .path()
        .resource_dir()
        .context("resolve app resource_dir")?;
    if !resource_dir.exists() {
        return Ok(None);
    }

    let mut stack = vec![resource_dir];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_dir() {
                stack.push(p);
                continue;
            }
            if let Some(name) = p.file_name().and_then(|s| s.to_str()) {
                if name == "mcpmanager-gateway" || name.starts_with("mcpmanager-gateway-") {
                    return Ok(Some(p));
                }
            }
        }
    }

    Ok(None)
}

fn ensure_gateway_installed(app: Option<&tauri::AppHandle>) -> Result<PathBuf> {
    let dest = gateway_install_path()?;
    if dest.exists() {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create dir {parent:?}"))?;
    }

    // Packaged installer: copy bundled sidecar if available.
    if let Some(app) = app {
        if let Some(bundled) = find_bundled_gateway(app)? {
            fs::copy(&bundled, &dest).with_context(|| format!("copy {:?} -> {:?}", bundled, dest))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mut perms = fs::metadata(&dest)?.permissions();
                perms.set_mode(0o755);
                fs::set_permissions(&dest, perms)?;
            }
            return Ok(dest);
        }
    }

    // Dev-mode installer: build from the local repo if sources exist.
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // apps/desktop/src-tauri
    let repo_root = manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| anyhow!("Could not resolve repo root from CARGO_MANIFEST_DIR"))?;
    let gateway_dir = repo_root.join("apps").join("gateway");
    let gateway_src = gateway_dir.join("src").join("cli.ts");
    if !gateway_src.exists() {
        return Err(anyhow!(
            "Gateway source not found at {:?}. In a packaged build, mcpManager will ship a prebuilt gateway binary; for now, run from the repo or provide a prebuilt installer.",
            gateway_src
        ));
    }

    let status = Command::new("bun")
        .current_dir(&gateway_dir)
        .args(["run", "build:exe"])
        .status()
        .context("failed to run bun to build gateway")?;
    if !status.success() {
        return Err(anyhow!("Gateway build failed (bun run build:exe)"));
    }

    let built = gateway_dir.join("dist").join("mcpmanager-gateway");
    if !built.exists() {
        return Err(anyhow!(
            "Gateway build completed but binary not found at {:?}",
            built
        ));
    }

    fs::copy(&built, &dest).with_context(|| format!("copy {:?} -> {:?}", built, dest))?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dest, perms)?;
    }

    Ok(dest)
}

fn read_codex_doc() -> Result<(PathBuf, DocumentMut)> {
    let path = codex_config_path()?;
    let doc = if path.exists() {
        fs::read_to_string(&path)
            .with_context(|| format!("read {:?}", path))?
            .parse::<DocumentMut>()
            .with_context(|| format!("parse TOML {:?}", path))?
    } else {
        DocumentMut::new()
    };
    Ok((path, doc))
}

fn codex_has_gateway(doc: &DocumentMut) -> bool {
    doc.get("mcp_servers")
        .and_then(|v| v.as_table())
        .and_then(|t| t.get("mcpmanager"))
        .is_some()
}

fn install_codex_gateway(gateway_path: &Path) -> Result<ClientInstallStatus> {
    let (path, mut doc) = read_codex_doc()?;

    if !doc.as_table().contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    }

    let server_table = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| anyhow!("mcp_servers is not a table"))?;

    let mut entry = Table::new();
    entry["command"] = value(gateway_path.to_string_lossy().to_string());
    entry["args"] = value(Array::new());
    entry["enabled"] = value(true);

    let mut env_vars = Array::new();
    for v in [
        "DAYTONA_API_KEY",
        "DAYTONA_API_URL",
        "DAYTONA_SERVER_URL",
        "DAYTONA_TARGET",
        "TAILSCALE_API_KEY",
        "TAILSCALE_TAILNET",
        "MCPMANAGER_REGISTRY_PATH",
        "MCPMANAGER_POLICY_MODE",
        "MCPMANAGER_TAILSCALE_ALLOW_KEYS",
        "MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS",
        "MCPMANAGER_TAILSCALE_ALLOW_REUSABLE",
        "MCPMANAGER_TAILSCALE_TAILNET_LOCK",
        "MCPMANAGER_TAILSCALE_TAGS_ALLOW",
        "MCPMANAGER_PLAYWRIGHT_POOL",
    ] {
        env_vars.push(v);
    }
    entry["env_vars"] = value(env_vars);

    server_table["mcpmanager"] = Item::Table(entry);

    write_with_backup(&path, doc.to_string().as_bytes())?;
    Ok(ClientInstallStatus {
        detected: true,
        installed: true,
        details: Some(format!("Updated {}", path.to_string_lossy())),
    })
}

fn read_claude_desktop_config(path: &Path) -> Result<ClaudeDesktopConfig> {
    if !path.exists() {
        return Ok(ClaudeDesktopConfig {
            mcpServers: serde_json::Map::new(),
            other: serde_json::Map::new(),
        });
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {:?}", path))?;
    serde_json::from_str(&text).with_context(|| format!("parse JSON {:?}", path))
}

fn install_claude_desktop_gateway(gateway_path: &Path) -> Result<ClientInstallStatus> {
    let path = claude_desktop_config_path()?;
    let mut cfg = read_claude_desktop_config(&path)?;

    let server = serde_json::json!({
      "command": gateway_path.to_string_lossy(),
      "args": [],
      "env": {
        "DAYTONA_API_KEY": "${DAYTONA_API_KEY}",
        "DAYTONA_API_URL": "${DAYTONA_API_URL}",
        "DAYTONA_SERVER_URL": "${DAYTONA_SERVER_URL}",
        "DAYTONA_TARGET": "${DAYTONA_TARGET}",
        "TAILSCALE_API_KEY": "${TAILSCALE_API_KEY}",
        "TAILSCALE_TAILNET": "${TAILSCALE_TAILNET}",
        "MCPMANAGER_REGISTRY_PATH": "${MCPMANAGER_REGISTRY_PATH}",
        "MCPMANAGER_POLICY_MODE": "${MCPMANAGER_POLICY_MODE}",
        "MCPMANAGER_TAILSCALE_ALLOW_KEYS": "${MCPMANAGER_TAILSCALE_ALLOW_KEYS}",
        "MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS": "${MCPMANAGER_TAILSCALE_MAX_EXPIRY_SECONDS}",
        "MCPMANAGER_TAILSCALE_ALLOW_REUSABLE": "${MCPMANAGER_TAILSCALE_ALLOW_REUSABLE}",
        "MCPMANAGER_TAILSCALE_TAILNET_LOCK": "${MCPMANAGER_TAILSCALE_TAILNET_LOCK}",
        "MCPMANAGER_TAILSCALE_TAGS_ALLOW": "${MCPMANAGER_TAILSCALE_TAGS_ALLOW}",
        "MCPMANAGER_PLAYWRIGHT_POOL": "${MCPMANAGER_PLAYWRIGHT_POOL}"
      }
    });
    cfg.mcpServers.insert("mcpmanager".to_string(), server);

    let mut out = serde_json::Map::new();
    out.insert(
        "mcpServers".to_string(),
        serde_json::Value::Object(cfg.mcpServers),
    );
    for (k, v) in cfg.other {
        out.insert(k, v);
    }

    let text = serde_json::to_string_pretty(&serde_json::Value::Object(out))?;
    write_with_backup(&path, text.as_bytes())?;

    Ok(ClientInstallStatus {
        detected: true,
        installed: true,
        details: Some(format!("Updated {}", path.to_string_lossy())),
    })
}

fn detect_claude_cli() -> bool {
    Command::new("claude")
        .arg("--version")
        .output()
        .is_ok()
}

fn install_claude_code_gateway(gateway_path: &Path) -> Result<ClientInstallStatus> {
    if !detect_claude_cli() {
        return Ok(ClientInstallStatus {
            detected: false,
            installed: false,
            details: Some("Claude CLI not found in PATH; skipped".to_string()),
        });
    }

    let config = serde_json::json!({
      "command": gateway_path.to_string_lossy(),
      "args": []
    })
    .to_string();

    let output = Command::new("claude")
        .args(["mcp", "add-json", "mcpmanager", "--scope", "user", &config])
        .output()
        .context("failed to run `claude mcp add-json`")?;

    if !output.status.success() {
        return Ok(ClientInstallStatus {
            detected: true,
            installed: false,
            details: Some(format!(
                "Claude CLI failed: {}",
                String::from_utf8_lossy(&output.stderr)
            )),
        });
    }

    Ok(ClientInstallStatus {
        detected: true,
        installed: true,
        details: Some(String::from_utf8_lossy(&output.stdout).to_string()),
    })
}

fn upsert_codex_server(doc: &mut DocumentMut, upstream: &Upstream) -> Result<()> {
    if !doc.as_table().contains_key("mcp_servers") {
        doc["mcp_servers"] = Item::Table(Table::new());
    }
    let server_table = doc["mcp_servers"]
        .as_table_mut()
        .ok_or_else(|| anyhow!("mcp_servers is not a table"))?;

    let mut entry = Table::new();
    entry["command"] = value(upstream.command.clone());
    let mut args = Array::new();
    for a in upstream.args.iter() {
        args.push(a.as_str());
    }
    entry["args"] = value(args);
    entry["enabled"] = value(upstream.enabled);

    if !upstream.env.is_empty() {
        let mut env = Table::new();
        for (k, v) in upstream.env.iter() {
            env[k] = value(v.clone());
        }
        entry["env"] = Item::Table(env);
    }

    if !upstream.env_vars.is_empty() {
        let mut env_vars = Array::new();
        for v in upstream.env_vars.iter() {
            env_vars.push(v.as_str());
        }
        entry["env_vars"] = value(env_vars);
    }

    server_table[&upstream.id] = Item::Table(entry);
    Ok(())
}

fn apply_registry_to_codex(reg: &Registry) -> Result<ClientInstallStatus> {
    let (path, mut doc) = read_codex_doc()?;
    for u in reg.upstreams.iter() {
        if u.id == "mcpmanager" {
            continue;
        }
        upsert_codex_server(&mut doc, u)?;
    }
    write_with_backup(&path, doc.to_string().as_bytes())?;
    Ok(ClientInstallStatus {
        detected: true,
        installed: true,
        details: Some(format!("Updated {}", path.to_string_lossy())),
    })
}

fn apply_registry_to_claude_desktop(reg: &Registry) -> Result<ClientInstallStatus> {
    let path = claude_desktop_config_path()?;
    let mut cfg = read_claude_desktop_config(&path)?;

    // Pull through any extra top-level keys by round-tripping through cfg.other later.
    let mut mcp_servers_disabled: serde_json::Map<String, serde_json::Value> = serde_json::Map::new();
    if let Ok(text) = fs::read_to_string(&path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(map) = v.get("mcpServersDisabled").and_then(|v| v.as_object()) {
                for (k, v) in map.iter() {
                    mcp_servers_disabled.insert(k.clone(), v.clone());
                }
            }
        }
    }

    for u in reg.upstreams.iter() {
        if u.id == "mcpmanager" {
            continue;
        }
        if u.enabled {
            let mut env = serde_json::Map::new();
            for (k, v) in u.env.iter() {
                env.insert(k.clone(), serde_json::Value::String(v.clone()));
            }
            for k in u.env_vars.iter() {
                env.insert(k.clone(), serde_json::Value::String(format!("${{{}}}", k)));
            }
            let server = serde_json::json!({
              "command": u.command,
              "args": u.args,
              "env": env
            });
            cfg.mcpServers.insert(u.id.clone(), server);
            mcp_servers_disabled.remove(&u.id);
        } else {
            if let Some(v) = cfg.mcpServers.remove(&u.id) {
                mcp_servers_disabled.insert(u.id.clone(), v);
            }
        }
    }

    let mut out = serde_json::Map::new();
    out.insert(
        "mcpServers".to_string(),
        serde_json::Value::Object(cfg.mcpServers),
    );
    if !mcp_servers_disabled.is_empty() {
        out.insert(
            "mcpServersDisabled".to_string(),
            serde_json::Value::Object(mcp_servers_disabled),
        );
    }
    for (k, v) in cfg.other {
        out.insert(k, v);
    }

    let text = serde_json::to_string_pretty(&serde_json::Value::Object(out))?;
    write_with_backup(&path, text.as_bytes())?;

    Ok(ClientInstallStatus {
        detected: true,
        installed: true,
        details: Some(format!("Updated {}", path.to_string_lossy())),
    })
}

fn apply_registry_to_claude_code(reg: &Registry) -> Result<ClientInstallStatus> {
    if !detect_claude_cli() {
        return Ok(ClientInstallStatus {
            detected: false,
            installed: false,
            details: Some("Claude CLI not found in PATH; skipped".to_string()),
        });
    }
    let mut ok = true;
    let mut details = Vec::new();
    for u in reg.upstreams.iter() {
        if u.id == "mcpmanager" {
            continue;
        }
        if u.enabled {
            let mut env = serde_json::Map::new();
            for (k, v) in u.env.iter() {
                env.insert(k.clone(), serde_json::Value::String(v.clone()));
            }
            for k in u.env_vars.iter() {
                env.insert(k.clone(), serde_json::Value::String(format!("${{{}}}", k)));
            }
            let cfg = serde_json::json!({
              "command": u.command,
              "args": u.args,
              "env": env
            })
            .to_string();
            let output = Command::new("claude")
                .args(["mcp", "add-json", &u.id, "--scope", "user", &cfg])
                .output()
                .context("failed to run `claude mcp add-json`")?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if !stderr.to_lowercase().contains("already exists") {
                    ok = false;
                    details.push(format!("{}: {}", u.id, stderr.trim()));
                }
            }
        } else {
            let output = Command::new("claude")
                .args(["mcp", "remove", "--scope", "user", &u.id])
                .output()
                .context("failed to run `claude mcp remove`")?;
            if !output.status.success() {
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                if !stderr.to_lowercase().contains("not found") && !stderr.to_lowercase().contains("does not exist")
                {
                    ok = false;
                    details.push(format!("{}: {}", u.id, stderr.trim()));
                }
            }
        }
    }
    Ok(ClientInstallStatus {
        detected: true,
        installed: ok,
        details: if details.is_empty() {
            Some("Applied via Claude CLI".to_string())
        } else {
            Some(details.join("\n"))
        },
    })
}

#[tauri::command]
fn get_status(_app: tauri::AppHandle) -> Result<StatusResult, String> {
    (|| -> Result<StatusResult> {
        let gateway_path = gateway_install_path()?;
        let gateway = BinaryStatus {
            path: gateway_path.to_string_lossy().to_string(),
            exists: gateway_path.exists(),
        };

        let codex = {
            let (path, doc) = read_codex_doc()?;
            ClientInstallStatus {
                detected: true,
                installed: codex_has_gateway(&doc),
                details: Some(path.to_string_lossy().to_string()),
            }
        };

        let claude_desktop = {
            let path = claude_desktop_config_path()?;
            let installed = if path.exists() {
                let cfg = read_claude_desktop_config(&path)?;
                cfg.mcpServers.contains_key("mcpmanager")
            } else {
                false
            };
            ClientInstallStatus {
                detected: true,
                installed,
                details: Some(path.to_string_lossy().to_string()),
            }
        };

        let claude_code = ClientInstallStatus {
            detected: detect_claude_cli(),
            installed: false,
            details: None,
        };

        Ok(StatusResult {
            gateway,
            codex,
            claude_desktop,
            claude_code,
        })
    })()
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn install_gateway_everywhere(app: tauri::AppHandle) -> Result<InstallResult, String> {
    (|| -> Result<InstallResult> {
        let gateway_path = ensure_gateway_installed(Some(&app))?;
        let codex = install_codex_gateway(&gateway_path).unwrap_or(ClientInstallStatus {
            detected: true,
            installed: false,
            details: Some("Failed to update Codex config".to_string()),
        });
        let claude_desktop =
            install_claude_desktop_gateway(&gateway_path).unwrap_or(ClientInstallStatus {
                detected: true,
                installed: false,
                details: Some("Failed to update Claude Desktop config".to_string()),
            });
        let claude_code =
            install_claude_code_gateway(&gateway_path).unwrap_or(ClientInstallStatus {
                detected: detect_claude_cli(),
                installed: false,
                details: Some("Failed to update Claude Code config".to_string()),
            });

        Ok(InstallResult {
            gateway_path: gateway_path.to_string_lossy().to_string(),
            codex,
            claude_desktop,
            claude_code,
        })
    })()
    .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct AddServerArgs {
    id: Option<String>,
    snippet: String,
}

#[tauri::command]
fn registry_get() -> Result<Registry, String> {
    read_registry().map_err(|e| e.to_string())
}

#[tauri::command]
fn registry_add_from_snippet(args: AddServerArgs) -> Result<Upstream, String> {
    (|| -> Result<Upstream> {
        let mut reg = read_registry()?;
        let upstream = parse_upstream_from_snippet(&args.snippet, args.id.as_deref())?;
        let mut found = false;
        for u in reg.upstreams.iter_mut() {
            if u.id == upstream.id {
                *u = upstream.clone();
                found = true;
                break;
            }
        }
        if !found {
            reg.upstreams.push(upstream.clone());
        }
        reg.version = 1;
        write_registry(&reg)?;
        Ok(upstream)
    })()
    .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct ToggleArgs {
    id: String,
    enabled: bool,
}

#[tauri::command]
fn registry_set_enabled(args: ToggleArgs) -> Result<Registry, String> {
    (|| -> Result<Registry> {
        let mut reg = read_registry()?;
        for u in reg.upstreams.iter_mut() {
            if u.id == args.id {
                u.enabled = args.enabled;
            }
        }
        write_registry(&reg)?;
        Ok(reg)
    })()
    .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct RemoveArgs {
    id: String,
}

#[tauri::command]
fn registry_remove(args: RemoveArgs) -> Result<Registry, String> {
    (|| -> Result<Registry> {
        let mut reg = read_registry()?;
        reg.upstreams.retain(|u| u.id != args.id);
        write_registry(&reg)?;
        Ok(reg)
    })()
    .map_err(|e| e.to_string())
}

#[derive(Debug, Deserialize)]
struct ApplyArgs {
    codex: bool,
    claude_desktop: bool,
    claude_code: bool,
}

#[derive(Debug, Serialize)]
struct ApplyResult {
    codex: Option<ClientInstallStatus>,
    claude_desktop: Option<ClientInstallStatus>,
    claude_code: Option<ClientInstallStatus>,
    registry_path: String,
}

#[tauri::command]
fn registry_apply(args: ApplyArgs) -> Result<ApplyResult, String> {
    (|| -> Result<ApplyResult> {
        let reg = read_registry()?;
        let codex = if args.codex {
            Some(apply_registry_to_codex(&reg)?)
        } else {
            None
        };
        let claude_desktop = if args.claude_desktop {
            Some(apply_registry_to_claude_desktop(&reg)?)
        } else {
            None
        };
        let claude_code = if args.claude_code {
            Some(apply_registry_to_claude_code(&reg)?)
        } else {
            None
        };
        Ok(ApplyResult {
            codex,
            claude_desktop,
            claude_code,
            registry_path: registry_path()?.to_string_lossy().to_string(),
        })
    })()
    .map_err(|e| e.to_string())
}

fn import_registry_from_codex(existing: &mut Registry) -> Result<usize> {
    let (path, doc) = read_codex_doc()?;
    if !path.exists() {
        return Ok(0);
    }
    let servers = doc
        .get("mcp_servers")
        .and_then(|v| v.as_table())
        .ok_or_else(|| anyhow!("mcp_servers is not a table"))?;

    let mut count = 0usize;
    for (id, item) in servers.iter() {
        if id == "mcpmanager" {
            continue;
        }
        let tbl = match item.as_table() {
            Some(t) => t,
            None => continue,
        };
        let command = match tbl.get("command").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        let args = tbl
            .get("args")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let enabled = tbl
            .get("enabled")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let env = tbl
            .get("env")
            .and_then(|v| v.as_table())
            .map(|t| {
                t.iter()
                    .filter_map(|(k, v)| v.as_str().map(|s| (k.to_string(), s.to_string())))
                    .collect::<std::collections::BTreeMap<_, _>>()
            })
            .unwrap_or_default();
        let env_vars = tbl
            .get("env_vars")
            .and_then(|v| v.as_array())
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();

        let upstream = Upstream {
            id: id.to_string(),
            enabled,
            command,
            args,
            env,
            env_vars,
        };

        let mut replaced = false;
        for u in existing.upstreams.iter_mut() {
            if u.id == upstream.id {
                *u = upstream.clone();
                replaced = true;
                break;
            }
        }
        if !replaced {
            existing.upstreams.push(upstream);
        }
        count += 1;
    }
    Ok(count)
}

fn import_registry_from_claude_desktop(existing: &mut Registry) -> Result<usize> {
    let path = claude_desktop_config_path()?;
    if !path.exists() {
        return Ok(0);
    }
    let text = fs::read_to_string(&path).with_context(|| format!("read {:?}", path))?;
    let v: serde_json::Value = serde_json::from_str(&text).with_context(|| format!("parse JSON {:?}", path))?;
    let enabled_map = v
        .get("mcpServers")
        .and_then(|x| x.as_object())
        .cloned()
        .unwrap_or_default();
    let disabled_map = v
        .get("mcpServersDisabled")
        .and_then(|x| x.as_object())
        .cloned()
        .unwrap_or_default();

    let mut count = 0usize;
    for (id, enabled) in [(true, enabled_map), (false, disabled_map)] {
        for (server_id, server_val) in enabled.iter() {
            if server_id == "mcpmanager" {
                continue;
            }
            let server = match server_val.as_object() {
                Some(o) => o,
                None => continue,
            };
            let command = match server.get("command").and_then(|v| v.as_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            let args = server
                .get("args")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let env_obj = server.get("env").and_then(|v| v.as_object()).cloned();
            let mut env = std::collections::BTreeMap::new();
            let mut env_vars = Vec::new();
            if let Some(map) = env_obj {
                for (k, v) in map.iter() {
                    if let Some(s) = v.as_str() {
                        if s == format!("${{{}}}", k) {
                            env_vars.push(k.clone());
                        } else {
                            env.insert(k.clone(), s.to_string());
                        }
                    }
                }
            }

            let upstream = Upstream {
                id: server_id.clone(),
                enabled: id,
                command,
                args,
                env,
                env_vars,
            };

            let mut replaced = false;
            for u in existing.upstreams.iter_mut() {
                if u.id == upstream.id {
                    *u = upstream.clone();
                    replaced = true;
                    break;
                }
            }
            if !replaced {
                existing.upstreams.push(upstream);
            }
            count += 1;
        }
    }

    Ok(count)
}

#[derive(Debug, Deserialize)]
struct ImportArgs {
    codex: bool,
    claude_desktop: bool,
}

#[derive(Debug, Serialize)]
struct ImportResult {
    imported_codex: usize,
    imported_claude_desktop: usize,
    registry: Registry,
    registry_path: String,
}

#[tauri::command]
fn registry_import_from_clients(args: ImportArgs) -> Result<ImportResult, String> {
    (|| -> Result<ImportResult> {
        let mut reg = read_registry()?;
        reg.version = 1;
        let mut imported_codex = 0usize;
        let mut imported_claude_desktop = 0usize;
        if args.codex {
            imported_codex = import_registry_from_codex(&mut reg)?;
        }
        if args.claude_desktop {
            imported_claude_desktop = import_registry_from_claude_desktop(&mut reg)?;
        }
        reg.upstreams.sort_by(|a, b| a.id.cmp(&b.id));
        write_registry(&reg)?;
        Ok(ImportResult {
            imported_codex,
            imported_claude_desktop,
            registry: reg,
            registry_path: registry_path()?.to_string_lossy().to_string(),
        })
    })()
    .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            install_gateway_everywhere,
            registry_get,
            registry_add_from_snippet,
            registry_set_enabled,
            registry_remove,
            registry_import_from_clients,
            registry_apply
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serial_test::serial;
    use std::env;

    fn with_temp_home<T>(f: impl FnOnce(PathBuf) -> T) -> T {
        let tmp = env::temp_dir().join(format!(
            "mcpmanager-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&tmp).unwrap();
        let prev_home = env::var("HOME").ok();
        env::set_var("HOME", &tmp);
        let res = f(tmp.clone());
        match prev_home {
            Some(v) => env::set_var("HOME", v),
            None => env::remove_var("HOME"),
        }
        res
    }

    #[test]
    #[serial]
    fn installs_codex_gateway_table() {
        with_temp_home(|home| {
            let gw = home.join(".mcpmanager/bin/mcpmanager-gateway");
            fs::create_dir_all(gw.parent().unwrap()).unwrap();
            fs::write(&gw, b"#!/bin/sh\necho hi\n").unwrap();

            let status = install_codex_gateway(&gw).unwrap();
            assert!(status.installed);

            let cfg_path = home.join(".codex/config.toml");
            let cfg = fs::read_to_string(cfg_path).unwrap();
            let doc = cfg.parse::<DocumentMut>().unwrap();
            assert!(codex_has_gateway(&doc));

            let table = doc["mcp_servers"]["mcpmanager"].as_table().unwrap();
            assert_eq!(table["command"].as_str().unwrap(), gw.to_string_lossy());
            assert_eq!(table["enabled"].as_bool().unwrap(), true);
            let env_vars = table["env_vars"].as_array().unwrap();
            assert!(env_vars.iter().any(|i| i.as_str() == Some("TAILSCALE_API_KEY")));
            assert!(env_vars.iter().any(|i| i.as_str() == Some("DAYTONA_SERVER_URL")));
        });
    }

    #[test]
    #[serial]
    fn installs_claude_desktop_mcpservers_entry() {
        with_temp_home(|home| {
            let gw = home.join(".mcpmanager/bin/mcpmanager-gateway");
            fs::create_dir_all(gw.parent().unwrap()).unwrap();
            fs::write(&gw, b"bin").unwrap();

            let status = install_claude_desktop_gateway(&gw).unwrap();
            assert!(status.installed);

            let cfg_path = home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json");
            let json = fs::read_to_string(cfg_path).unwrap();
            let v: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(v.get("mcpServers").is_some());
            let servers = v.get("mcpServers").unwrap().as_object().unwrap();
            let entry = servers.get("mcpmanager").unwrap().as_object().unwrap();
            assert_eq!(entry.get("command").unwrap().as_str().unwrap(), gw.to_string_lossy());
        });
    }

    #[test]
    #[serial]
    fn ensure_gateway_installed_noop_when_present() {
        with_temp_home(|home| {
            let dest = home.join(".mcpmanager/bin/mcpmanager-gateway");
            fs::create_dir_all(dest.parent().unwrap()).unwrap();
            fs::write(&dest, b"bin").unwrap();
            let got = ensure_gateway_installed(None).unwrap();
            assert_eq!(got, dest);
        });
    }

    #[test]
    #[serial]
    fn parses_codex_toml_snippet() {
        let snippet = r#"
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest"]
enabled = false
env_vars = ["PLAYWRIGHT_BROWSERS_PATH"]
"#;
        let u = parse_upstream_from_snippet(snippet, None).unwrap();
        assert_eq!(u.id, "playwright");
        assert_eq!(u.command, "npx");
        assert_eq!(u.args[0], "-y");
        assert_eq!(u.enabled, false);
        assert!(u.env_vars.iter().any(|v| v == "PLAYWRIGHT_BROWSERS_PATH"));
    }

    #[test]
    #[serial]
    fn parses_claude_list_line() {
        let snippet = "exa: npx -y exa-mcp-server@latest --tools=get_code_context_exa - ✓ Connected";
        let u = parse_upstream_from_snippet(snippet, None).unwrap();
        assert_eq!(u.id, "exa");
        assert_eq!(u.command, "npx");
        assert!(u.args.iter().any(|a| a.contains("exa-mcp-server")));
    }

    #[test]
    #[serial]
    fn registry_apply_writes_codex_and_claude_desktop() {
        with_temp_home(|home| {
            let reg = Registry {
                version: 1,
                upstreams: vec![Upstream {
                    id: "test-server".to_string(),
                    enabled: true,
                    command: "npx".to_string(),
                    args: vec!["-y".to_string(), "example@latest".to_string()],
                    env: [("API_KEY".to_string(), "secret".to_string())]
                        .into_iter()
                        .collect(),
                    env_vars: vec!["SOME_VAR".to_string()],
                }],
            };
            write_registry(&reg).unwrap();

            let codex_status = apply_registry_to_codex(&reg).unwrap();
            assert!(codex_status.installed);
            let codex_path = home.join(".codex/config.toml");
            let text = fs::read_to_string(&codex_path).unwrap();
            assert!(text.contains("[mcp_servers.test-server]"));
            assert!(text.contains("enabled = true"));

            let desktop_status = apply_registry_to_claude_desktop(&reg).unwrap();
            assert!(desktop_status.installed);
            let desktop_path = home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json");
            let json = fs::read_to_string(desktop_path).unwrap();
            let v: serde_json::Value = serde_json::from_str(&json).unwrap();
            assert!(v["mcpServers"]["test-server"].is_object());
        });
    }

    #[test]
    #[serial]
    fn imports_from_codex_config() {
        with_temp_home(|home| {
            let codex = home.join(".codex/config.toml");
            fs::create_dir_all(codex.parent().unwrap()).unwrap();
            fs::write(
                &codex,
                r#"
[mcp_servers.foo]
command = "npx"
args = ["-y","foo@latest"]
enabled = false

[mcp_servers.bar]
command = "node"
args = ["bar.js"]
enabled = true
"#,
            )
            .unwrap();

            let mut reg = read_registry().unwrap();
            let n = import_registry_from_codex(&mut reg).unwrap();
            assert_eq!(n, 2);
            assert!(reg.upstreams.iter().any(|u| u.id == "foo" && !u.enabled));
            assert!(reg.upstreams.iter().any(|u| u.id == "bar" && u.enabled));
        });
    }

    #[test]
    #[serial]
    fn imports_from_claude_desktop_config() {
        with_temp_home(|home| {
            let cfg_path = home
                .join("Library")
                .join("Application Support")
                .join("Claude")
                .join("claude_desktop_config.json");
            fs::create_dir_all(cfg_path.parent().unwrap()).unwrap();
            fs::write(
                &cfg_path,
                r#"
{
  "mcpServers": {
    "aaa": { "command": "npx", "args": ["-y","aaa"], "env": { "A": "${A}" } }
  },
  "mcpServersDisabled": {
    "bbb": { "command": "node", "args": ["bbb.js"], "env": {} }
  }
}
"#,
            )
            .unwrap();

            let mut reg = read_registry().unwrap();
            let n = import_registry_from_claude_desktop(&mut reg).unwrap();
            assert_eq!(n, 2);
            assert!(reg.upstreams.iter().any(|u| u.id == "aaa" && u.enabled));
            assert!(reg.upstreams.iter().any(|u| u.id == "bbb" && !u.enabled));
            let aaa = reg.upstreams.iter().find(|u| u.id == "aaa").unwrap();
            assert!(aaa.env_vars.iter().any(|v| v == "A"));
        });
    }
}
