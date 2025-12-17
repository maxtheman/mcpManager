use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn repo_root_from_manifest_dir(manifest_dir: &Path) -> Option<PathBuf> {
    // apps/desktop/src-tauri -> apps/desktop -> apps -> repo root
    manifest_dir
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .map(|p| p.to_path_buf())
}

fn main() {
    // Allow skipping sidecar build (e.g. in constrained CI environments).
    if env::var("MCPMANAGER_SKIP_SIDECAR_BUILD")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        tauri_build::build();
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let repo_root = repo_root_from_manifest_dir(&manifest_dir).expect("repo root");
    let gateway_dir = repo_root.join("apps").join("gateway");

    println!("cargo:rerun-if-changed={}", gateway_dir.join("src").join("cli.ts").display());
    println!("cargo:rerun-if-changed={}", gateway_dir.join("src").join("daytona").display());
    println!("cargo:rerun-if-changed={}", gateway_dir.join("src").join("tailscale").display());
    println!("cargo:rerun-if-changed={}", gateway_dir.join("src").join("policy").display());
    println!("cargo:rerun-if-changed={}", gateway_dir.join("src").join("registry").display());
    println!("cargo:rerun-if-env-changed=MCPMANAGER_SKIP_SIDECAR_BUILD");

    let status = Command::new("bun")
        .current_dir(&gateway_dir)
        .args(["run", "build:exe"])
        .status()
        .expect("failed to run bun to build gateway sidecar");
    if !status.success() {
        panic!("gateway sidecar build failed (bun run build:exe)");
    }

    let target = env::var("TARGET").unwrap_or_else(|_| "unknown-target".to_string());
    let is_windows = target.contains("windows");
    let built = if is_windows {
        let exe = gateway_dir.join("dist").join("mcpmanager-gateway.exe");
        if exe.exists() {
            exe
        } else {
            gateway_dir.join("dist").join("mcpmanager-gateway")
        }
    } else {
        gateway_dir.join("dist").join("mcpmanager-gateway")
    };
    if !built.exists() {
        panic!("gateway binary missing after build at {}", built.display());
    }

    let bin_dir = manifest_dir.join("bin");
    fs::create_dir_all(&bin_dir).expect("create src-tauri/bin");

    let dest_name = if is_windows {
        format!("mcpmanager-gateway-{}.exe", target)
    } else {
        format!("mcpmanager-gateway-{}", target)
    };
    let dest = bin_dir.join(dest_name);
    fs::copy(&built, &dest).expect("copy gateway sidecar into src-tauri/bin");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&dest).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&dest, perms).unwrap();
    }

    tauri_build::build();
}
