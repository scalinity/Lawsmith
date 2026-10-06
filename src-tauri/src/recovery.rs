//! Application-local recovery files (SPEC §15.3): the current snapshot and one previous one, written
//! through the same reliable replacement as scenes. The frontend supplies an envelope already
//! validated and stamped with its document generation and revision; this store orders those writes,
//! rejects stale ones and retires eligibility. It never reads scene semantics.

use std::{
    collections::BTreeMap,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;

use crate::document_io::{IoFailure, SCENE_LIMIT, read_bounded_utf8, replace_file};

/// A snapshot is a scene plus a small envelope.
pub const RECOVERY_LIMIT: u64 = SCENE_LIMIT + 64 * 1024;

const CURRENT: &str = "current.lawsmith-recovery.json";
const PREVIOUS: &str = "previous.lawsmith-recovery.json";
const INCOMING: &str = "incoming.lawsmith-recovery.json";

/// What this session knows about a snapshot file. Files present at launch belong to an earlier
/// session: once this session saves or discards, they are no longer unsaved work.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Stamp {
    Foreign,
    Session { generation: u64, revision: u64 },
}

#[derive(Default)]
struct State {
    current: Option<Stamp>,
    previous: Option<Stamp>,
    last_write: Option<(u64, u64)>,
    /// Per generation, the revision through which recovery is retired.
    retired: BTreeMap<u64, u64>,
}

pub struct RecoveryStore {
    dir: PathBuf,
    state: Mutex<State>,
}

/// One slot as read at launch: absent, unreadable, or its text for the frontend to validate.
#[derive(Debug, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "lowercase")]
pub enum Slot {
    Absent,
    Unreadable { reason: String },
    Present { text: String },
}

#[derive(Debug, Serialize)]
pub struct Slots {
    pub current: Slot,
    pub previous: Slot,
}

impl RecoveryStore {
    pub fn new(dir: PathBuf) -> Self {
        let state = State {
            current: dir.join(CURRENT).exists().then_some(Stamp::Foreign),
            previous: dir.join(PREVIOUS).exists().then_some(Stamp::Foreign),
            ..State::default()
        };
        // A temporary left by an interrupted write is never a snapshot.
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.ends_with(".lawsmith-tmp") || name == INCOMING {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
        Self { dir, state: Mutex::new(state) }
    }

    fn slot(&self, name: &str) -> Slot {
        match read_bounded_utf8(&self.dir.join(name), RECOVERY_LIMIT) {
            Ok(text) => Slot::Present { text },
            Err(failure) if failure.kind == "not-found" => Slot::Absent,
            Err(failure) => Slot::Unreadable { reason: format!("{} ({})", failure.message, failure.kind) },
        }
    }

    /// Both snapshots as stored, for the frontend to validate like an imported scene.
    pub fn load(&self) -> Slots {
        let _state = self.state.lock().unwrap();
        Slots { current: self.slot(CURRENT), previous: self.slot(PREVIOUS) }
    }

    /// Writes the snapshot for `(generation, revision)`. The new bytes are complete and synchronized
    /// before the old current moves to previous, so a failure never leaves no valid snapshot.
    pub fn write(&self, generation: u64, revision: u64, text: &str) -> Result<(), IoFailure> {
        let mut state = self.state.lock().unwrap();
        if text.len() as u64 > RECOVERY_LIMIT {
            return Err(IoFailure::new("too-large", "recovery", "the recovery snapshot exceeds its limit"));
        }
        if let Some((g, r)) = state.last_write {
            if generation < g || (generation == g && revision <= r) {
                return Err(IoFailure::new("stale", "recovery", format!("revision {generation}.{revision} is not newer than the stored {g}.{r}")));
            }
        }
        if state.retired.get(&generation).is_some_and(|&through| revision <= through) {
            return Err(IoFailure::new("stale", "recovery", format!("revision {generation}.{revision} is already saved or discarded")));
        }
        fs::create_dir_all(&self.dir).map_err(|e| IoFailure::io("recovery-directory", e))?;
        let current = self.dir.join(CURRENT);
        let incoming = self.dir.join(INCOMING);
        replace_file(&incoming, |f| f.write_all(text.as_bytes()))?;
        if state.current.is_some() {
            if let Err(e) = fs::rename(&current, self.dir.join(PREVIOUS)) {
                let _ = fs::remove_file(&incoming);
                return Err(IoFailure::io("recovery-rotate", e));
            }
            state.previous = state.current.take();
        }
        fs::rename(&incoming, &current).map_err(|e| IoFailure::io("recovery-commit", e))?;
        state.current = Some(Stamp::Session { generation, revision });
        state.last_write = Some((generation, revision));
        Ok(())
    }

    /// Retires recovery for `generation` through `through` (SPEC §15.3): snapshots at or before it,
    /// older generations' and earlier sessions' are deleted, and later queued writes in that range
    /// are refused. A later revision of the same generation stays eligible.
    pub fn retire(&self, generation: u64, through: u64) -> Result<(), IoFailure> {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        let covered = |stamp: Stamp| match stamp {
            Stamp::Foreign => true,
            Stamp::Session { generation: g, revision: r } => g < generation || (g == generation && r <= through),
        };
        for (name, slot) in [(CURRENT, &mut state.current), (PREVIOUS, &mut state.previous)] {
            if slot.is_some_and(covered) {
                remove(&self.dir.join(name))?;
                *slot = None;
            }
        }
        // Recorded only once the snapshots are gone: a failed retirement leaves recovery working
        // for a document that stays open.
        let entry = state.retired.entry(generation).or_insert(0);
        *entry = (*entry).max(through);
        Ok(())
    }

    /// Deletes the snapshots an earlier session left, as when the work offered at launch is
    /// discarded. Snapshots this session wrote are never touched.
    pub fn discard_earlier(&self) -> Result<(), IoFailure> {
        let mut guard = self.state.lock().unwrap();
        let state = &mut *guard;
        for (name, slot) in [(CURRENT, &mut state.current), (PREVIOUS, &mut state.previous)] {
            if *slot == Some(Stamp::Foreign) {
                remove(&self.dir.join(name))?;
                *slot = None;
            }
        }
        Ok(())
    }
}

fn remove(path: &Path) -> Result<(), IoFailure> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(IoFailure::io("recovery-retire", e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_io::tests::scratch;
    use std::os::unix::fs::PermissionsExt;

    fn text(slot: &Slot) -> &str {
        match slot {
            Slot::Present { text } => text,
            other => panic!("expected a snapshot, found {other:?}"),
        }
    }

    #[test]
    fn keeps_current_and_one_previous() {
        let store = RecoveryStore::new(scratch("recovery-rotate"));
        store.write(1, 1, "r1").unwrap();
        store.write(1, 2, "r2").unwrap();
        store.write(1, 3, "r3").unwrap();
        let slots = store.load();
        assert_eq!((text(&slots.current), text(&slots.previous)), ("r3", "r2"));
    }

    #[test]
    fn rejects_stale_revisions_and_generations() {
        let store = RecoveryStore::new(scratch("recovery-stale"));
        store.write(2, 5, "g2r5").unwrap();
        assert_eq!(store.write(2, 5, "again").unwrap_err().kind, "stale");
        assert_eq!(store.write(2, 4, "older").unwrap_err().kind, "stale");
        assert_eq!(store.write(1, 9, "old generation").unwrap_err().kind, "stale");
        assert_eq!(text(&store.load().current), "g2r5");
    }

    #[test]
    fn save_retires_only_through_its_revision() {
        let store = RecoveryStore::new(scratch("recovery-save"));
        store.write(1, 3, "r3").unwrap();
        store.write(1, 7, "r7").unwrap();
        // A save captured revision 5: r3 is retired, the later dirty r7 stays eligible.
        store.retire(1, 5).unwrap();
        let slots = store.load();
        assert_eq!(text(&slots.current), "r7");
        assert_eq!(slots.previous, Slot::Absent);
        // A queued write of a revision the save already covers is refused.
        assert_eq!(store.write(1, 4, "late").unwrap_err().kind, "stale");
    }

    #[test]
    fn discard_retires_written_and_queued_snapshots_of_its_generation() {
        let store = RecoveryStore::new(scratch("recovery-discard"));
        store.write(4, 1, "a").unwrap();
        store.write(4, 2, "b").unwrap();
        store.retire(4, u64::MAX).unwrap();
        assert_eq!(store.write(4, 3, "queued before discard").unwrap_err().kind, "stale");
        let slots = store.load();
        assert_eq!((slots.current, slots.previous), (Slot::Absent, Slot::Absent));
        // The next document generation writes normally.
        store.write(5, 1, "next").unwrap();
    }

    #[test]
    fn a_failed_discard_keeps_recovery_working() {
        let dir = scratch("recovery-failed-discard");
        let store = RecoveryStore::new(dir.clone());
        store.write(3, 1, "r1").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let failure = store.retire(3, u64::MAX).unwrap_err();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(failure.kind, "permission");
        // The document stays open, so its next revision is still written.
        store.write(3, 2, "r2").unwrap();
        assert_eq!(text(&store.load().current), "r2");
    }

    #[test]
    fn earlier_session_files_are_retired_by_this_session() {
        let dir = scratch("recovery-foreign");
        fs::write(dir.join(CURRENT), "from a crash").unwrap();
        let store = RecoveryStore::new(dir.clone());
        assert_eq!(text(&store.load().current), "from a crash");
        store.retire(1, 0).unwrap();
        assert_eq!(store.load().current, Slot::Absent);
    }

    #[test]
    fn discarding_earlier_work_keeps_this_sessions_snapshots() {
        let dir = scratch("recovery-discard-earlier");
        fs::write(dir.join(PREVIOUS), "from a crash").unwrap();
        let store = RecoveryStore::new(dir);
        store.write(1, 1, "this session").unwrap();
        store.discard_earlier().unwrap();
        let slots = store.load();
        assert_eq!(text(&slots.current), "this session");
        assert_eq!(slots.previous, Slot::Absent);
    }

    #[test]
    fn a_failed_write_keeps_the_valid_snapshot() {
        let dir = scratch("recovery-denied");
        let store = RecoveryStore::new(dir.clone());
        store.write(1, 1, "valid").unwrap();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o555)).unwrap();
        let failure = store.write(1, 2, "lost").unwrap_err();
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(failure.kind, "permission");
        assert_eq!(text(&store.load().current), "valid");
        // Not recorded as written: the same revision can be retried.
        store.write(1, 2, "retried").unwrap();
    }

    #[test]
    fn unreadable_snapshots_are_reported_not_hidden() {
        let dir = scratch("recovery-corrupt");
        fs::write(dir.join(CURRENT), [0xff, 0xfe, 0x00]).unwrap();
        fs::write(dir.join(PREVIOUS), "older valid").unwrap();
        let slots = RecoveryStore::new(dir).load();
        assert!(matches!(slots.current, Slot::Unreadable { .. }));
        assert_eq!(text(&slots.previous), "older valid");
    }

    #[test]
    fn interrupted_temporaries_are_cleared_at_launch() {
        let dir = scratch("recovery-tmp");
        fs::write(dir.join(".incoming.lawsmith-recovery.json.1-1.lawsmith-tmp"), "partial").unwrap();
        let store = RecoveryStore::new(dir.clone());
        assert_eq!(store.load().current, Slot::Absent);
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0);
    }
}
