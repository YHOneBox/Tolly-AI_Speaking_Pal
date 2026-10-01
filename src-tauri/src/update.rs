//! Check GitHub releases and replace the portable build the user is running.

use serde::Serialize;
use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Runtime};

use crate::error::ApiError;
use crate::paths;

const REPO: &str = "YHOneBox/Tolly-AI_Speaking_Pal";
const RELEASES_URL: &str = "https://api.github.com/repos/YHOneBox/Tolly-AI_Speaking_Pal/releases/latest";
const MAX_DOWNLOAD_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateOffer {
    pub current: String,
    pub latest: String,
    pub available: bool,
    pub notes: String,
}

struct ReleaseAsset {
    name: String,
    url: String,
}

struct Release {
    tag_name: String,
    body: Option<String>,
    assets: Vec<ReleaseAsset>,
}

enum InstallPlan {
    #[cfg_attr(target_os = "macos", allow(dead_code))]
    ReplaceFile { target: PathBuf },
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    ReplaceMacApp { bundle: PathBuf },
}

pub async fn check(http: &reqwest::Client) -> Result<UpdateOffer, ApiError> {
    let release = latest_release(http).await?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    let notes = release
        .body
        .unwrap_or_default()
        .chars()
        .take(500)
        .collect::<String>();
    let available = is_newer(&release.tag_name, &current) && release_asset(&release.assets).is_some();
    Ok(UpdateOffer {
        current,
        latest: release.tag_name.trim_start_matches('v').to_string(),
        available,
        notes,
    })
}

pub async fn install<R: Runtime>(app: &AppHandle<R>, http: &reqwest::Client) -> Result<(), ApiError> {
    let release = latest_release(http).await?;
    let current = env!("CARGO_PKG_VERSION");
    if !is_newer(&release.tag_name, current) {
        return Err(ApiError::bad("Tolly is already on the latest release."));
    }
    let asset = release_asset(&release.assets).ok_or_else(|| {
        ApiError::bad("The latest GitHub release does not include a build for this computer.")
    })?;
    if !trusted_download(&asset.url) {
        return Err(ApiError::bad("The release file is not hosted on GitHub."));
    }

    let plan = install_plan()?;
    let download_path = paths::data_dir()?.join(download_name());
    download(app, http, &asset.url, &download_path).await?;
    spawn_replacer(&plan, &download_path, release.tag_name.trim_start_matches('v'))?;
    app.exit(0);
    Ok(())
}

async fn latest_release(http: &reqwest::Client) -> Result<Release, ApiError> {
    let response = http
        .get(RELEASES_URL)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let status = response.status();
    if !status.is_success() {
        return Err(ApiError::upstream(
            status.as_u16(),
            "Tolly couldn't read the GitHub releases.",
        ));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let tag_name = payload
        .get("tag_name")
        .and_then(|value| value.as_str())
        .unwrap_or("")
        .to_string();
    if parse_version(&tag_name).is_none() {
        return Err(ApiError::bad("The latest GitHub release has no version number."));
    }
    let body = payload
        .get("body")
        .and_then(|value| value.as_str())
        .map(ToString::to_string);
    let assets = payload
        .get("assets")
        .and_then(|value| value.as_array())
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let name = item.get("name")?.as_str()?.to_string();
            let url = item.get("browser_download_url")?.as_str()?.to_string();
            Some(ReleaseAsset { name, url })
        })
        .collect();
    Ok(Release {
        tag_name,
        body,
        assets,
    })
}

fn release_asset(assets: &[ReleaseAsset]) -> Option<&ReleaseAsset> {
    let marker = format!("-{}", platform_suffix());
    assets.iter().find(|asset| asset.name.ends_with(&marker))
}

fn platform_suffix() -> &'static str {
    #[cfg(windows)]
    {
        "windows-x64.exe"
    }
    #[cfg(target_os = "macos")]
    {
        "macos.app.zip"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "linux-x64.AppImage"
    }
}

fn download_name() -> &'static str {
    #[cfg(windows)]
    {
        "Tolly.next.exe"
    }
    #[cfg(target_os = "macos")]
    {
        "Tolly.next.zip"
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "Tolly.next.AppImage"
    }
}

fn trusted_download(url: &str) -> bool {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return false;
    };
    parsed.scheme() == "https"
        && parsed.host_str() == Some("github.com")
        && parsed.path().starts_with(&format!("/{REPO}/releases/download/"))
}

async fn download<R: Runtime>(
    app: &AppHandle<R>,
    http: &reqwest::Client,
    url: &str,
    destination: &Path,
) -> Result<(), ApiError> {
    let response = http
        .get(url)
        .timeout(std::time::Duration::from_secs(600))
        .send()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?;
    let response = crate::error::ensure_success(response).await?;
    let total = response.content_length().unwrap_or(0);
    if total > MAX_DOWNLOAD_BYTES {
        return Err(ApiError::bad("That release file is larger than Tolly will download."));
    }

    let mut received = 0u64;
    let mut file = std::fs::File::create(destination).map_err(|err| ApiError::storage(err.to_string()))?;
    let mut reported = 0u64;
    let mut stream = response;
    while let Some(chunk) = stream
        .chunk()
        .await
        .map_err(|err| ApiError::upstream(0, err.to_string()))?
    {
        received = received.saturating_add(chunk.len() as u64);
        if received > MAX_DOWNLOAD_BYTES {
            drop(file);
            let _ = std::fs::remove_file(destination);
            return Err(ApiError::bad("That release file is larger than Tolly will download."));
        }
        file.write_all(&chunk).map_err(|err| ApiError::storage(err.to_string()))?;
        if received.saturating_sub(reported) >= 256 * 1024 {
            reported = received;
            let _ = app.emit(
                "update-progress",
                serde_json::json!({ "received": received, "total": total }),
            );
        }
    }
    file.sync_all().map_err(|err| ApiError::storage(err.to_string()))?;
    let _ = app.emit(
        "update-progress",
        serde_json::json!({ "received": received, "total": if total == 0 { received } else { total } }),
    );
    Ok(())
}

fn install_plan() -> Result<InstallPlan, ApiError> {
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().map_err(|err| ApiError::storage(err.to_string()))?;
        let bundle = executable
            .parent()
            .and_then(|path| path.parent())
            .and_then(|path| path.parent())
            .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("app"))
            .ok_or_else(|| ApiError::bad("Open the Tolly app to install an update."))?
            .to_path_buf();
        if is_dev_build(&bundle) {
            return Err(ApiError::bad("Open the portable app to install an update."));
        }
        return Ok(InstallPlan::ReplaceMacApp { bundle });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let target = current_binary()?;
        if is_dev_build(&target) {
            return Err(ApiError::bad("Open the portable app to install an update."));
        }
        Ok(InstallPlan::ReplaceFile { target })
    }
}

fn current_binary() -> Result<PathBuf, ApiError> {
    #[cfg(all(unix, not(target_os = "macos")))]
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if !appimage.is_empty() {
            return Ok(PathBuf::from(appimage));
        }
    }
    std::env::current_exe().map_err(|err| ApiError::storage(err.to_string()))
}

fn is_dev_build(path: &Path) -> bool {
    let text = path.to_string_lossy().replace('\\', "/").to_ascii_lowercase();
    text.contains("target/debug")
}

fn spawn_replacer(plan: &InstallPlan, download: &Path, version: &str) -> Result<(), ApiError> {
    match plan {
        InstallPlan::ReplaceFile { target } => spawn_file_replace(download, target, version),
        InstallPlan::ReplaceMacApp { bundle } => spawn_mac_replace(download, bundle, version),
    }
}

fn versioned_stem(version: &str) -> Result<String, ApiError> {
    let version = version.trim().trim_start_matches('v');
    if parse_version(version).is_none() {
        return Err(ApiError::bad("The latest GitHub release has no version number."));
    }
    Ok(format!("Tolly-v{version}"))
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn versioned_file(current: &Path, version: &str) -> Result<PathBuf, ApiError> {
    let parent = current
        .parent()
        .ok_or_else(|| ApiError::storage("The app folder could not be found."))?;
    let extension = if cfg!(windows) { "exe" } else { "AppImage" };
    Ok(parent.join(format!("{}.{}", versioned_stem(version)?, extension)))
}

#[cfg(windows)]
fn spawn_file_replace(download: &Path, target: &Path, version: &str) -> Result<(), ApiError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    let renamed = versioned_file(target, version)?;
    let script_path = paths::data_dir()?.join("apply-update.cmd");
    let remove_old = if !same_path(target, &renamed) {
        format!(
            "set /a tries=0\r\n:drop\r\ndel /F /Q \"{}\"\r\nif not exist \"{}\" goto launch\r\nset /a tries+=1\r\nif %tries% lss 15 goto waitdrop\r\ngoto launch\r\n:waitdrop\r\nping 127.0.0.1 -n 2 > nul\r\ngoto drop\r\n",
            target.display(),
            target.display()
        )
    } else {
        String::new()
    };
    let script = format!(
        "@echo off\r\nset /a tries=0\r\n:retry\r\nping 127.0.0.1 -n 2 > nul\r\nmove /Y \"{}\" \"{}\"\r\nif errorlevel 1 (\r\n  set /a tries+=1\r\n  if %tries% lss 20 goto retry\r\n  exit /b 1\r\n)\r\n{}:launch\r\nstart \"\" \"{}\"\r\n",
        download.display(),
        renamed.display(),
        remove_old,
        renamed.display()
    );
    std::fs::write(&script_path, script).map_err(|err| ApiError::storage(err.to_string()))?;
    std::process::Command::new("cmd")
        .args(["/C", &script_path.display().to_string()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS)
        .spawn()
        .map_err(|err| ApiError::storage(err.to_string()))?;
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn spawn_file_replace(download: &Path, target: &Path, version: &str) -> Result<(), ApiError> {
    let renamed = versioned_file(target, version)?;
    let script_path = paths::data_dir()?.join("apply-update.sh");
    let remove_old = if same_path(target, &renamed) {
        String::new()
    } else {
        format!("rm -f {}\n", shell_quote(target))
    };
    let script = format!(
        "#!/bin/sh\ntries=0\nwhile [ \"$tries\" -lt 20 ]; do\n  sleep 1\n  if mv -f {} {}; then\n    chmod +x {}\n    {}\n    nohup {} >/dev/null 2>&1 &\n    exit 0\n  fi\n  tries=$((tries + 1))\ndone\nexit 1\n",
        shell_quote(download),
        shell_quote(&renamed),
        shell_quote(&renamed),
        remove_old,
        shell_quote(&renamed)
    );
    std::fs::write(&script_path, script).map_err(|err| ApiError::storage(err.to_string()))?;
    let _ = std::process::Command::new("chmod").arg("+x").arg(&script_path).status();
    std::process::Command::new("sh")
        .arg(&script_path)
        .spawn()
        .map_err(|err| ApiError::storage(err.to_string()))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn spawn_file_replace(_download: &Path, _target: &Path, _version: &str) -> Result<(), ApiError> {
    Err(ApiError::bad("This Mac build updates the app bundle."))
}

#[cfg(target_os = "macos")]
fn spawn_mac_replace(download: &Path, bundle: &Path, version: &str) -> Result<(), ApiError> {
    let parent = bundle
        .parent()
        .ok_or_else(|| ApiError::storage("The app folder could not be found."))?;
    let renamed = parent.join(format!("{}.app", versioned_stem(version)?));
    let script_path = paths::data_dir()?.join("apply-update.sh");
    let script = format!(
        "#!/bin/sh\nsleep 2\nrm -rf {}\nditto -x -k {} {}\nmv -f {} {}\nopen {}\n",
        shell_quote(bundle),
        shell_quote(download),
        shell_quote(parent),
        shell_quote(&parent.join("Tolly.app")),
        shell_quote(&renamed),
        shell_quote(&renamed)
    );
    std::fs::write(&script_path, script).map_err(|err| ApiError::storage(err.to_string()))?;
    let _ = std::process::Command::new("chmod").arg("+x").arg(&script_path).status();
    std::process::Command::new("sh")
        .arg(&script_path)
        .spawn()
        .map_err(|err| ApiError::storage(err.to_string()))?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn spawn_mac_replace(_download: &Path, _bundle: &Path, _version: &str) -> Result<(), ApiError> {
    Err(ApiError::bad("This computer updates the app file directly."))
}

#[cfg(unix)]
fn shell_quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', "'\\''"))
}

#[cfg_attr(target_os = "macos", allow(dead_code))]
fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy().eq_ignore_ascii_case(&right.to_string_lossy())
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_version(latest), parse_version(current)) {
        (Some(next), Some(now)) => next > now,
        _ => false,
    }
}

fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let raw = raw.trim().trim_start_matches('v');
    let mut parts = raw.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    Some((major, minor, patch))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_higher_tag_is_newer() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.2.1", "v0.2.0"));
        assert!(!is_newer("v0.2.0", "0.2.0"));
        assert!(!is_newer("v0.1.9", "0.2.0"));
    }

    #[test]
    fn an_update_file_uses_the_new_version_name() {
        assert_eq!(versioned_stem("v1.2.0").unwrap(), "Tolly-v1.2.0");
        assert_eq!(versioned_stem("1.2.0").unwrap(), "Tolly-v1.2.0");
        assert!(versioned_stem("not-a-version").is_err());
    }

    #[test]
    fn only_github_release_urls_are_trusted() {
        assert!(trusted_download(
            "https://github.com/YHOneBox/Tolly-AI_Speaking_Pal/releases/download/v0.3.0/Tolly-v0.3.0-windows-x64.exe"
        ));
        assert!(!trusted_download("https://example.com/Tolly.exe"));
        assert!(!trusted_download(
            "http://github.com/YHOneBox/Tolly-AI_Speaking_Pal/releases/download/v0.3.0/Tolly.exe"
        ));
    }
}
