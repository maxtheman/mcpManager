use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
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

fn ensure_gateway_installed() -> Result<PathBuf> {
    let dest = gateway_install_path()?;
    if dest.exists() {
        return Ok(dest);
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("create dir {parent:?}"))?;
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
        "MCPMANAGER_TAILSCALE_TAGS_ALLOW": "${MCPMANAGER_TAILSCALE_TAGS_ALLOW}"
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

#[tauri::command]
fn get_status() -> Result<StatusResult, String> {
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
fn install_gateway_everywhere() -> Result<InstallResult, String> {
    (|| -> Result<InstallResult> {
        let gateway_path = ensure_gateway_installed()?;
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![get_status, install_gateway_everywhere])
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
            let got = ensure_gateway_installed().unwrap();
            assert_eq!(got, dest);
        });
    }
}
