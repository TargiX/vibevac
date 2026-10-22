//! Which running processes are using a workspace.
//!
//! The working-directory snapshot is read natively: `libproc` on macOS and
//! `/proc` on Linux. `lsof` is only a fallback for when the native call fails
//! entirely. Open-file detection is a second, narrower signal used only while
//! planning a whole-worktree removal, never during a scan.

use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const LSOF_TIMEOUT: Duration = Duration::from_secs(5);
const OPEN_FILES_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ProcessCheckMethod {
    // Each native method is constructed only on its own platform.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Libproc,
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    Procfs,
    Lsof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum ProcessCheckCoverage {
    AllUsers,
    CurrentUser,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ActiveProcessSnapshot {
    pub(crate) available: bool,
    pub(crate) working_directories: BTreeMap<PathBuf, u64>,
    pub(crate) error: Option<String>,
    pub(crate) method: Option<ProcessCheckMethod>,
    pub(crate) coverage: Option<ProcessCheckCoverage>,
}

/// Raw result of a native working-directory walk.
struct NativeWalk {
    working_directories: BTreeMap<PathBuf, u64>,
    permission_denied: bool,
}

pub(crate) fn inspect_active_processes() -> ActiveProcessSnapshot {
    match native_working_directories() {
        Ok((method, walk)) => ActiveProcessSnapshot {
            available: true,
            working_directories: walk.working_directories,
            error: None,
            method: Some(method),
            coverage: Some(if walk.permission_denied {
                ProcessCheckCoverage::CurrentUser
            } else {
                ProcessCheckCoverage::AllUsers
            }),
        },
        Err(native_error) => match lsof_working_directories() {
            Ok(working_directories) => ActiveProcessSnapshot {
                available: true,
                working_directories,
                error: None,
                method: Some(ProcessCheckMethod::Lsof),
                coverage: Some(if running_as_root() {
                    ProcessCheckCoverage::AllUsers
                } else {
                    ProcessCheckCoverage::CurrentUser
                }),
            },
            Err(lsof_error) => ActiveProcessSnapshot {
                available: false,
                working_directories: BTreeMap::new(),
                error: Some(format!("{native_error}; {lsof_error}")),
                method: None,
                coverage: None,
            },
        },
    }
}

pub(crate) fn count_processes_within(
    snapshot: &ActiveProcessSnapshot,
    workspace_path: &Path,
) -> Option<u64> {
    snapshot.available.then(|| {
        snapshot
            .working_directories
            .iter()
            .filter(|(working_directory, _)| working_directory.starts_with(workspace_path))
            .map(|(_, count)| count)
            .sum()
    })
}

/// Counts open file descriptors, across every process this user can inspect,
/// whose path lies inside `workspace_path`. Bounded to two seconds of wall
/// time; running out of time is an error, never a zero.
///
/// Processes running VibeVac's own executable are skipped: its directory
/// walks are inspection, and a child it has forked but not yet exec'd
/// briefly shares those handles.
pub(crate) fn open_files_within(workspace_path: &Path) -> Result<u64, String> {
    let deadline = Instant::now() + OPEN_FILES_TIMEOUT;
    let own_image = std::env::current_exe().ok();
    native_open_files_within(workspace_path, own_image.as_deref(), deadline)
}

fn record(directories: &mut BTreeMap<PathBuf, u64>, path: PathBuf) {
    *directories.entry(path).or_insert(0) += 1;
}

fn timed_out(deadline: Instant) -> Result<(), String> {
    if Instant::now() > deadline {
        Err(format!(
            "Open-file check did not finish within {} s",
            OPEN_FILES_TIMEOUT.as_secs()
        ))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn running_as_root() -> bool {
    // SAFETY: geteuid has no preconditions and cannot fail.
    unsafe { libc::geteuid() == 0 }
}

#[cfg(not(unix))]
fn running_as_root() -> bool {
    false
}

#[cfg(target_os = "macos")]
mod darwin {
    use libproc::bsd_info::BSDInfo;
    use libproc::file_info::{pidfdinfo, ListFDs, PIDFDInfo, PIDFDInfoFlavor, ProcFDType};
    use libproc::proc_pid::{listpidinfo, pidinfo, pidpath, PIDInfo, PidInfoFlavor};
    use libproc::processes::{pids_by_type, ProcFilter};
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::path::PathBuf;

    const MAXPATHLEN: usize = 1024;

    // `struct vnode_info_path` from <sys/proc_info.h>. Only the path is read;
    // the 152-byte `vnode_info` header is kept opaque.
    #[repr(C)]
    pub(super) struct VnodeInfoPath {
        vip_vi: [u64; 19],
        vip_path: [u8; MAXPATHLEN],
    }

    impl VnodeInfoPath {
        pub(super) fn path(&self) -> Option<PathBuf> {
            let path = CStr::from_bytes_until_nul(&self.vip_path).ok()?;
            let bytes = path.to_bytes();
            (!bytes.is_empty()).then(|| PathBuf::from(OsStr::from_bytes(bytes)))
        }
    }

    // `struct proc_vnodepathinfo`, returned by PROC_PIDVNODEPATHINFO.
    #[repr(C)]
    pub(super) struct VnodePathInfo {
        pub(super) pvi_cdir: VnodeInfoPath,
        pvi_rdir: VnodeInfoPath,
    }

    // `struct vnode_fdinfowithpath`, returned by PROC_PIDFDVNODEPATHINFO.
    #[repr(C)]
    pub(super) struct VnodeFdInfoWithPath {
        pfi: [u64; 3],
        pub(super) pvip: VnodeInfoPath,
    }

    const _: () = assert!(std::mem::size_of::<VnodeInfoPath>() == 1176);
    const _: () = assert!(std::mem::size_of::<VnodePathInfo>() == 2352);
    const _: () = assert!(std::mem::size_of::<VnodeFdInfoWithPath>() == 1200);

    impl PIDInfo for VnodePathInfo {
        fn flavor() -> PidInfoFlavor {
            PidInfoFlavor::VNodePathInfo
        }
    }

    impl Default for VnodeFdInfoWithPath {
        fn default() -> Self {
            Self {
                pfi: [0; 3],
                pvip: VnodeInfoPath {
                    vip_vi: [0; 19],
                    vip_path: [0; MAXPATHLEN],
                },
            }
        }
    }

    impl PIDFDInfo for VnodeFdInfoWithPath {
        fn flavor() -> PIDFDInfoFlavor {
            PIDFDInfoFlavor::VNodePathInfo
        }
    }

    /// libproc reports failures as text that embeds `errno = N`.
    pub(super) fn errno_of(message: &str) -> Option<i32> {
        let rest = &message[message.find("errno = ")? + "errno = ".len()..];
        let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
        digits.parse().ok()
    }

    pub(super) fn is_permission_error(message: &str) -> bool {
        matches!(errno_of(message), Some(libc::EPERM | libc::EACCES))
    }

    pub(super) fn all_pids() -> Result<Vec<i32>, String> {
        let pids = pids_by_type(ProcFilter::All)
            .map_err(|error| format!("proc_listpids failed: {error}"))?;
        Ok(pids
            .into_iter()
            .filter_map(|pid| i32::try_from(pid).ok())
            .filter(|pid| *pid > 0)
            .collect())
    }

    pub(super) fn image(pid: i32) -> Option<PathBuf> {
        pidpath(pid).ok().map(PathBuf::from)
    }

    pub(super) fn cwd(pid: i32) -> Result<Option<PathBuf>, String> {
        pidinfo::<VnodePathInfo>(pid, 0).map(|info| info.pvi_cdir.path())
    }

    /// Paths of every vnode file descriptor `pid` holds open.
    pub(super) fn open_vnode_paths(pid: i32) -> Result<Vec<PathBuf>, String> {
        let nfiles = pidinfo::<BSDInfo>(pid, 0)?.pbi_nfiles as usize;
        let descriptors = listpidinfo::<ListFDs>(pid, nfiles.max(1))?;
        Ok(descriptors
            .iter()
            .filter(|fd| matches!(ProcFDType::from(fd.proc_fdtype), ProcFDType::VNode))
            .filter_map(|fd| pidfdinfo::<VnodeFdInfoWithPath>(pid, fd.proc_fd).ok())
            .filter_map(|info| info.pvip.path())
            .collect())
    }
}

#[cfg(target_os = "macos")]
fn native_working_directories() -> Result<(ProcessCheckMethod, NativeWalk), String> {
    let pids = darwin::all_pids()?;
    let mut walk = NativeWalk {
        working_directories: BTreeMap::new(),
        permission_denied: false,
    };
    let mut readable = 0usize;
    for pid in pids {
        match darwin::cwd(pid) {
            Ok(path) => {
                readable += 1;
                if let Some(path) = path {
                    record(&mut walk.working_directories, path);
                }
            }
            Err(error) if darwin::is_permission_error(&error) => walk.permission_denied = true,
            // The process exited between listing and inspection, or is a zombie.
            Err(_) => {}
        }
    }
    if readable == 0 {
        return Err("libproc could not read the working directory of any process".to_owned());
    }
    Ok((ProcessCheckMethod::Libproc, walk))
}

#[cfg(target_os = "macos")]
fn native_open_files_within(
    workspace_path: &Path,
    own_image: Option<&Path>,
    deadline: Instant,
) -> Result<u64, String> {
    let mut count = 0;
    for pid in darwin::all_pids()? {
        timed_out(deadline)?;
        if own_image.is_some() && darwin::image(pid).as_deref() == own_image {
            continue;
        }
        if let Ok(paths) = darwin::open_vnode_paths(pid) {
            count += paths
                .iter()
                .filter(|path| path.starts_with(workspace_path))
                .count() as u64;
        }
    }
    Ok(count)
}

#[cfg(target_os = "linux")]
fn proc_pids() -> Result<Vec<u32>, String> {
    let entries =
        std::fs::read_dir("/proc").map_err(|error| format!("Could not read /proc: {error}"))?;
    Ok(entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
        .collect())
}

#[cfg(target_os = "linux")]
fn native_working_directories() -> Result<(ProcessCheckMethod, NativeWalk), String> {
    use std::io::ErrorKind;

    let mut walk = NativeWalk {
        working_directories: BTreeMap::new(),
        permission_denied: false,
    };
    let mut readable = 0usize;
    for pid in proc_pids()? {
        match std::fs::read_link(format!("/proc/{pid}/cwd")) {
            Ok(path) => {
                readable += 1;
                record(&mut walk.working_directories, path);
            }
            Err(error) if error.kind() == ErrorKind::PermissionDenied => {
                walk.permission_denied = true
            }
            Err(_) => {}
        }
    }
    if readable == 0 {
        return Err("/proc did not expose the working directory of any process".to_owned());
    }
    Ok((ProcessCheckMethod::Procfs, walk))
}

#[cfg(target_os = "linux")]
fn native_open_files_within(
    workspace_path: &Path,
    own_image: Option<&Path>,
    deadline: Instant,
) -> Result<u64, String> {
    let mut count = 0;
    for pid in proc_pids()? {
        timed_out(deadline)?;
        if own_image.is_some()
            && std::fs::read_link(format!("/proc/{pid}/exe"))
                .ok()
                .as_deref()
                == own_image
        {
            continue;
        }
        let Ok(descriptors) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue;
        };
        count += descriptors
            .filter_map(Result::ok)
            .filter_map(|entry| std::fs::read_link(entry.path()).ok())
            .filter(|path| path.starts_with(workspace_path))
            .count() as u64;
    }
    Ok(count)
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn native_working_directories() -> Result<(ProcessCheckMethod, NativeWalk), String> {
    Err("No native process inspection on this platform".to_owned())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn native_open_files_within(
    _workspace_path: &Path,
    _own_image: Option<&Path>,
    _deadline: Instant,
) -> Result<u64, String> {
    Err("Open-file inspection is not supported on this platform".to_owned())
}

fn lsof_working_directories() -> Result<BTreeMap<PathBuf, u64>, String> {
    let mut child = Command::new("lsof")
        .args(["-a", "-d", "cwd", "-Fpn"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not run lsof: {error}"))?;
    let mut stdout = child.stdout.take().expect("lsof stdout is piped");
    let mut stderr = child.stderr.take().expect("lsof stderr is piped");
    let stdout_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        stdout.read_to_end(&mut buffer).map(|_| buffer)
    });
    let stderr_reader = thread::spawn(move || {
        let mut buffer = Vec::new();
        let _ = stderr.read_to_end(&mut buffer);
        buffer
    });

    let deadline = Instant::now() + LSOF_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "lsof did not finish within {} s",
                    LSOF_TIMEOUT.as_secs()
                ));
            }
            Err(error) => return Err(format!("Could not wait for lsof: {error}")),
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "lsof output reader panicked".to_owned())?
        .map_err(|error| format!("Could not read lsof output: {error}"))?;
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_owned();
        return Err(if detail.is_empty() {
            format!("lsof failed with {status}")
        } else {
            format!("lsof failed: {detail}")
        });
    }

    let mut working_directories = BTreeMap::new();
    for line in String::from_utf8_lossy(&stdout).lines() {
        if let Some(path) = line.strip_prefix('n').filter(|value| !value.is_empty()) {
            record(&mut working_directories, PathBuf::from(path));
        }
    }
    Ok(working_directories)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};

    fn wait_until<F: FnMut() -> bool>(mut condition: F) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if condition() {
                return true;
            }
            thread::sleep(Duration::from_millis(25));
        }
        false
    }

    #[test]
    fn native_snapshot_finds_a_child_working_inside_a_directory() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = fs::canonicalize(temp.path()).unwrap();
        let nested = workspace.join("nested");
        fs::create_dir(&nested).unwrap();
        let mut child = Command::new("sleep")
            .arg("30")
            .current_dir(&nested)
            .spawn()
            .unwrap();

        let mut last = None;
        let found = wait_until(|| {
            let snapshot = inspect_active_processes();
            let count = count_processes_within(&snapshot, &workspace);
            last = Some(snapshot);
            count.is_some_and(|count| count >= 1)
        });
        child.kill().unwrap();
        child.wait().unwrap();

        let snapshot = last.unwrap();
        assert!(found, "child not found: {:?}", snapshot.error);
        let expected = if cfg!(target_os = "macos") {
            ProcessCheckMethod::Libproc
        } else {
            ProcessCheckMethod::Procfs
        };
        assert_eq!(snapshot.method, Some(expected));
        assert!(snapshot.coverage.is_some());
        if !running_as_root() {
            assert_eq!(snapshot.coverage, Some(ProcessCheckCoverage::CurrentUser));
        }
        let other = tempfile::tempdir().unwrap();
        assert_eq!(
            count_processes_within(&snapshot, &fs::canonicalize(other.path()).unwrap()),
            Some(0)
        );
    }

    #[test]
    fn open_files_within_counts_a_handle_held_by_another_process() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = fs::canonicalize(temp.path()).unwrap();
        let file = workspace.join("tail.log");
        fs::write(&file, "x").unwrap();
        assert_eq!(open_files_within(&workspace).unwrap(), 0);

        // VibeVac's own handles are inspection, not use.
        let own = File::open(&file).unwrap();
        assert_eq!(open_files_within(&workspace).unwrap(), 0);
        drop(own);

        let mut child = Command::new("tail")
            .args(["-f"])
            .arg(&file)
            .current_dir("/")
            .stdout(Stdio::null())
            .spawn()
            .unwrap();
        let found = wait_until(|| open_files_within(&workspace).is_ok_and(|count| count >= 1));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(found);
        assert!(wait_until(|| open_files_within(&workspace).unwrap() == 0));
    }

    #[test]
    fn serializes_method_and_coverage_as_wire_names() {
        let snapshot = ActiveProcessSnapshot {
            available: true,
            working_directories: BTreeMap::new(),
            error: None,
            method: Some(ProcessCheckMethod::Libproc),
            coverage: Some(ProcessCheckCoverage::CurrentUser),
        };
        let value = serde_json::to_value(&snapshot).unwrap();
        assert_eq!(value["method"], "libproc");
        assert_eq!(value["coverage"], "current-user");
        assert_eq!(value["workingDirectories"], serde_json::json!({}));
        assert_eq!(
            serde_json::to_value(ProcessCheckCoverage::AllUsers).unwrap(),
            "all-users"
        );
        assert_eq!(
            serde_json::to_value(ProcessCheckMethod::Procfs).unwrap(),
            "procfs"
        );
    }

    #[test]
    fn lsof_fallback_still_parses_working_directories() {
        // lsof is optional on the machine; only check parsing when it runs.
        if let Ok(directories) = lsof_working_directories() {
            assert!(directories.keys().all(|path| path.is_absolute()));
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn libproc_permission_errors_are_recognised() {
        assert_eq!(
            darwin::errno_of("return code = -1, errno = 1, message = 'x'"),
            Some(1)
        );
        assert!(darwin::is_permission_error(
            "return code = 0, errno = 1, message = ''"
        ));
        assert!(!darwin::is_permission_error(
            "return code = 0, errno = 3, message = ''"
        ));
        if !running_as_root() {
            // launchd (pid 1) belongs to root; reading its cwd must be refused.
            let error = darwin::cwd(1).unwrap_err();
            assert!(darwin::is_permission_error(&error), "{error}");
        }
    }
}
