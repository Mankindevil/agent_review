# Cursor Authentication Session Isolation Design

**Date:** 2026-07-24

## Goal

Keep only Cursor account material in `CURSOR_AUTH_CONFIG_HOME` while allowing both
`cursor-agent status` and real non-interactive calls to refresh their credentials.
Chats, SQLite stores, telemetry caches, and all other CLI state must remain inside
the disposable per-call workspace.

## Persistent boundary

The only persistent paths are:

- `cursor/auth.json`
- `cursor/cli-config.json`

`cli-config.json` is retained for compatibility with the installed Cursor CLI and
its file-backed credential-store configuration. Both files must be regular,
non-symbolic-link JSON files no larger than 1 MiB and mode `0600`.

The configured authentication root and its direct `cursor` child must be real
directories, never symbolic links, and mode `0700`. Before any recursive cleanup,
the implementation resolves both paths and verifies that the resolved `cursor`
directory is the direct child of the resolved authentication root.

Every non-allowlisted entry below the verified persistent `cursor` directory is
removed. Cleanup never targets the authentication root itself or any path outside
its verified `cursor` child.

## Session lifecycle

Both a real Cursor call and the authentication status probe use the same session
wrapper:

1. Acquire a process-local mutex keyed by the normalized authentication root.
2. Validate and normalize the persistent directory boundary.
3. Remove non-allowlisted persistent state left by older deployments.
4. Create a fresh XDG configuration root inside the already-disposable runtime
   workspace.
5. Safely read and copy only the two allowlisted JSON files into
   `<temporary-xdg>/cursor/`.
6. Run Cursor with `XDG_CONFIG_HOME` set to that temporary root. HOME, cache, data,
   state, and TMP remain disposable as before.
7. Safely read any updated allowlisted files from the temporary root.
8. Write each accepted update to a unique same-directory temporary file with mode
   `0600`, then atomically rename it over the persistent target.
9. Remove any remaining non-allowlisted persistent state, then release the mutex.
10. The outer workspace cleanup removes all chats, stores, caches, and other
    temporary CLI state.

An allowlisted file that disappears from the temporary session does not delete the
persistent copy. Normal platform operations never perform logout, and preserving
the last valid file avoids destructive credential loss on partial CLI failure.

## Concurrency

The mutex covers the full snapshot, Cursor process, and writeback lifecycle.
Serializing only the copy/write phases is insufficient because two concurrent
processes can rotate the same refresh token and produce mutually incompatible
credential files.

The application is a single systemd Node process, so a process-local keyed mutex is
the required concurrency boundary. Separate authentication roots use independent
locks. A future multi-process deployment must add an OS-level lock or external
credential broker before sharing the same authentication root.

## Failure behavior

- A missing allowlisted file is tolerated; Cursor reports unauthenticated if
  account material is unavailable.
- A symbolic link, non-regular file, oversized file, malformed JSON, unsafe
  directory boundary, copy failure, or atomic writeback failure fails the
  operation closed.
- Temporary-session state is always removed by the existing workspace cleanup.
- The persistent file is never modified until a complete validated replacement is
  ready in the same directory.
- No credential values are logged or returned by runtime status.

## Test contract

Automated tests must prove:

- Cursor child environments never point `XDG_CONFIG_HOME` at the persistent root.
- A session copies only the allowlist and removes existing chats, databases, and
  telemetry caches from the persistent `cursor` directory.
- Updated allowlisted files are atomically written back and normalized to `0600`;
  both persistent directories are `0700` on POSIX.
- Missing temporary files do not delete persistent credentials.
- Invalid JSON, non-regular files, and symbolic links fail closed without replacing
  a valid persistent credential.
- Two concurrent sessions for one root execute in order, and the second snapshots
  the first session's refreshed credential rather than an older copy.
- Authentication status and real execution use the same temporary XDG session
  wrapper.

