import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withCursorAuthSession } from '../src/cursor-auth-session.js';

const isPosix = process.platform !== 'win32';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function fixture(prefix = 'cursor-auth-session-') {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  const authRoot = path.join(root, 'auth');
  await mkdir(workspace);
  await mkdir(path.join(authRoot, 'cursor'), { recursive: true });
  return {
    root,
    workspace,
    authRoot,
    cursorDirectory: path.join(authRoot, 'cursor')
  };
}

async function removeFixture(value) {
  await rm(value.root, { recursive: true, force: true });
}

async function createSymlinkOrSkip(t, target, linkPath, type) {
  try {
    await symlink(target, linkPath, type);
    return true;
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`host denied symbolic-link creation (${error.code})`);
      return false;
    }
    throw error;
  }
}

test('snapshots allowlisted credentials, returns the callback result, and safely writes back', async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.cursorDirectory, 'auth.json'), '{"token":"old"}');
    await writeFile(path.join(value.cursorDirectory, 'cli-config.json'), '{"theme":"dark"}');
    await writeFile(path.join(value.cursorDirectory, 'discard-me'), 'junk');
    let calls = 0;

    const result = await withCursorAuthSession(value.workspace, {
      CURSOR_AUTH_CONFIG_HOME: value.authRoot
    }, async (xdgHome) => {
      calls += 1;
      assert.equal(path.relative(value.workspace, xdgHome).startsWith('..'), false);
      assert.deepEqual(
        JSON.parse(await readFile(path.join(xdgHome, 'cursor', 'auth.json'), 'utf8')),
        { token: 'old' }
      );
      await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"new"}');
      await mkdir(path.join(xdgHome, 'cursor', 'chats'));
      await writeFile(path.join(xdgHome, 'cursor', 'store.db'), 'temporary');
      return 'done';
    });

    assert.equal(result, 'done');
    assert.equal(calls, 1);
    assert.deepEqual(
      (await readdir(value.cursorDirectory)).sort(),
      ['auth.json', 'cli-config.json']
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(value.cursorDirectory, 'auth.json'), 'utf8')),
      { token: 'new' }
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(value.cursorDirectory, 'cli-config.json'), 'utf8')),
      { theme: 'dark' }
    );
    assert.equal(
      (await readdir(value.workspace)).some((entry) => entry.startsWith('.cursor-xdg-')),
      false
    );

    if (isPosix) {
      assert.equal((await stat(value.authRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(value.cursorDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(value.cursorDirectory, 'auth.json'))).mode & 0o777,
        0o600
      );
      assert.equal(
        (await stat(path.join(value.cursorDirectory, 'cli-config.json'))).mode & 0o777,
        0o600
      );
    }
  } finally {
    await removeFixture(value);
  }
});

test('creates missing persistent boundaries with private modes', async () => {
  const value = await fixture();
  try {
    await rm(value.authRoot, { recursive: true });

    await withCursorAuthSession(value.workspace, {
      CURSOR_AUTH_CONFIG_HOME: value.authRoot
    }, async (xdgHome) => {
      await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"created"}');
    });

    assert.deepEqual(
      JSON.parse(await readFile(path.join(value.cursorDirectory, 'auth.json'), 'utf8')),
      { token: 'created' }
    );
    if (isPosix) {
      assert.equal((await stat(value.authRoot)).mode & 0o777, 0o700);
      assert.equal((await stat(value.cursorDirectory)).mode & 0o777, 0o700);
      assert.equal(
        (await stat(path.join(value.cursorDirectory, 'auth.json'))).mode & 0o777,
        0o600
      );
    }
  } finally {
    await removeFixture(value);
  }
});

test('keeps a persistent allowlisted file when the temporary copy is removed', async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"old"}');

    await withCursorAuthSession(value.workspace, {
      CURSOR_AUTH_CONFIG_HOME: value.authRoot
    }, async (xdgHome) => {
      await rm(path.join(xdgHome, 'cursor', 'auth.json'));
    });

    assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'old' });
  } finally {
    await removeFixture(value);
  }
});

test('rejects a non-absolute credential root before calling the callback', async () => {
  const value = await fixture();
  try {
    let called = false;
    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: 'relative/auth'
      }, async () => {
        called = true;
      }),
      /CURSOR_AUTH_CONFIG_HOME must be an absolute path/
    );
    assert.equal(called, false);
  } finally {
    await removeFixture(value);
  }
});

test('rejects malformed persistent JSON before calling the callback', async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.cursorDirectory, 'auth.json'), '{bad json');
    let called = false;
    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {
        called = true;
      }),
      /valid JSON object/
    );
    assert.equal(called, false);
  } finally {
    await removeFixture(value);
  }
});

test('rejects persistent JSON arrays', async () => {
  const value = await fixture();
  try {
    await writeFile(path.join(value.cursorDirectory, 'auth.json'), '[]');
    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {}),
      /valid JSON object/
    );
  } finally {
    await removeFixture(value);
  }
});

test('rejects an allowlisted persistent path that is a directory', async () => {
  const value = await fixture();
  try {
    await mkdir(path.join(value.cursorDirectory, 'auth.json'));
    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {}),
      /regular file/
    );
  } finally {
    await removeFixture(value);
  }
});

test('rejects an allowlisted persistent symbolic link', async (t) => {
  const value = await fixture();
  try {
    const target = path.join(value.root, 'outside.json');
    await writeFile(target, '{"token":"outside"}');
    if (!await createSymlinkOrSkip(
      t,
      target,
      path.join(value.cursorDirectory, 'auth.json'),
      'file'
    )) return;

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {}),
      /symbolic link/
    );
  } finally {
    await removeFixture(value);
  }
});

test('rejects a symbolic-link credential root', async (t) => {
  const value = await fixture();
  try {
    const realRoot = path.join(value.root, 'real-auth');
    const linkedRoot = path.join(value.root, 'linked-auth');
    await mkdir(path.join(realRoot, 'cursor'), { recursive: true });
    if (!await createSymlinkOrSkip(t, realRoot, linkedRoot, 'dir')) return;

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: linkedRoot
      }, async () => {}),
      /symbolic link/
    );
  } finally {
    await removeFixture(value);
  }
});

test('rejects a symbolic-link cursor child', async (t) => {
  const value = await fixture();
  try {
    const realCursor = path.join(value.root, 'real-cursor');
    await mkdir(realCursor);
    await rm(value.cursorDirectory, { recursive: true });
    if (!await createSymlinkOrSkip(t, realCursor, value.cursorDirectory, 'dir')) return;

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {}),
      /symbolic link/
    );
  } finally {
    await removeFixture(value);
  }
});

test('rejects an allowlisted file larger than 1 MiB', async () => {
  const value = await fixture();
  try {
    await writeFile(
      path.join(value.cursorDirectory, 'auth.json'),
      Buffer.alloc(1_048_577, 0x20)
    );
    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async () => {}),
      /1_048_576 bytes/
    );
  } finally {
    await removeFixture(value);
  }
});

test('does not replace valid persistence with a malformed temporary file', async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"valid"}');

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{broken');
      }),
      /valid JSON object/
    );

    assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'valid' });
  } finally {
    await removeFixture(value);
  }
});

test('does not replace valid persistence with a temporary symbolic link', async (t) => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    const outside = path.join(value.root, 'outside.json');
    await writeFile(persistentAuth, '{"token":"valid"}');
    await writeFile(outside, '{"token":"outside"}');
    let symlinkCreated = false;

    let completionError;
    try {
      await withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        const temporaryAuth = path.join(xdgHome, 'cursor', 'auth.json');
        await rm(temporaryAuth);
        symlinkCreated = await createSymlinkOrSkip(t, outside, temporaryAuth, 'file');
      });
    } catch (error) {
      completionError = error;
    }

    if (symlinkCreated) {
      assert.match(completionError?.message, /symbolic link/);
      assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'valid' });
    } else {
      assert.equal(completionError, undefined);
    }
  } finally {
    await removeFixture(value);
  }
});

test('rejects a replacement temporary cursor directory object', async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"valid"}');

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        const temporaryCursor = path.join(xdgHome, 'cursor');
        await rename(temporaryCursor, path.join(xdgHome, 'original-cursor'));
        await mkdir(temporaryCursor);
        await writeFile(path.join(temporaryCursor, 'auth.json'), '{"token":"replacement"}');
      }),
      /temporary cursor directory changed/
    );

    assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'valid' });
  } finally {
    await removeFixture(value);
  }
});

test('rejects a temporary cursor parent symlink without reading or chmodding outside JSON', async (t) => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    const outsideCursor = path.join(value.root, 'outside-cursor');
    const outsideAuth = path.join(outsideCursor, 'auth.json');
    await writeFile(persistentAuth, '{"token":"valid"}');
    await mkdir(outsideCursor);
    await writeFile(outsideAuth, '{"token":"outside"}');
    const outsideMode = (await stat(outsideAuth)).mode & 0o777;
    let symlinkCreated = false;
    let completionError;

    try {
      await withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        const temporaryCursor = path.join(xdgHome, 'cursor');
        await rename(temporaryCursor, path.join(xdgHome, 'original-cursor'));
        symlinkCreated = await createSymlinkOrSkip(
          t,
          outsideCursor,
          temporaryCursor,
          'dir'
        );
        if (!symlinkCreated) {
          await rename(path.join(xdgHome, 'original-cursor'), temporaryCursor);
        }
      });
    } catch (error) {
      completionError = error;
    }

    if (symlinkCreated) {
      assert.match(completionError?.message, /temporary cursor directory.*symbolic link/);
      assert.deepEqual(JSON.parse(await readFile(outsideAuth, 'utf8')), { token: 'outside' });
      if (isPosix) assert.equal((await stat(outsideAuth)).mode & 0o777, outsideMode);
      assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'valid' });
    } else {
      assert.equal(completionError, undefined);
    }
  } finally {
    await removeFixture(value);
  }
});

test('rejects a replacement persistent cursor directory object', async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    const originalCursor = path.join(value.authRoot, 'original-cursor');
    await writeFile(persistentAuth, '{"token":"valid"}');

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"updated"}');
        await rename(value.cursorDirectory, originalCursor);
        await mkdir(value.cursorDirectory);
        await writeFile(path.join(value.cursorDirectory, 'auth.json'), '{"token":"replacement"}');
      }),
      /persistent cursor directory changed/
    );

    assert.deepEqual(
      JSON.parse(await readFile(path.join(originalCursor, 'auth.json'), 'utf8')),
      { token: 'valid' }
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(value.cursorDirectory, 'auth.json'), 'utf8')),
      { token: 'replacement' }
    );
  } finally {
    await removeFixture(value);
  }
});

test('preserves runtime and writeback failures together', async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"valid"}');
    const runtimeError = new Error('runtime failed');

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{broken');
        throw runtimeError;
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 2);
        assert.equal(error.errors[0], runtimeError);
        assert.match(error.errors[1].message, /valid JSON object/);
        return true;
      }
    );
    assert.deepEqual(JSON.parse(await readFile(persistentAuth, 'utf8')), { token: 'valid' });
  } finally {
    await removeFixture(value);
  }
});

test('serializes calls for one root and snapshots the preceding refreshed token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-auth-lock-'));
  const workspaceOne = path.join(root, 'workspace-one');
  const workspaceTwo = path.join(root, 'workspace-two');
  const authRoot = path.join(root, 'auth');
  await mkdir(workspaceOne);
  await mkdir(workspaceTwo);
  await mkdir(path.join(authRoot, 'cursor'), { recursive: true });
  await writeFile(path.join(authRoot, 'cursor', 'auth.json'), '{"token":"old"}');
  const firstEntered = deferred();
  const releaseFirst = deferred();
  const seen = [];

  try {
    const env = { CURSOR_AUTH_CONFIG_HOME: authRoot };
    const first = withCursorAuthSession(workspaceOne, env, async (xdgHome) => {
      firstEntered.resolve();
      await releaseFirst.promise;
      await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"fresh"}');
    });
    await firstEntered.promise;
    const second = withCursorAuthSession(workspaceTwo, env, async (xdgHome) => {
      seen.push(
        JSON.parse(await readFile(path.join(xdgHome, 'cursor', 'auth.json'), 'utf8')).token
      );
    });
    assert.deepEqual(seen, []);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(seen, ['fresh']);
  } finally {
    releaseFirst.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('allows calls for different credential roots to enter concurrently', async () => {
  const first = await fixture('cursor-auth-first-');
  const second = await fixture('cursor-auth-second-');
  const firstEntered = deferred();
  const secondEntered = deferred();
  const release = deferred();

  try {
    const firstCall = withCursorAuthSession(first.workspace, {
      CURSOR_AUTH_CONFIG_HOME: first.authRoot
    }, async () => {
      firstEntered.resolve();
      await secondEntered.promise;
      await release.promise;
    });
    await firstEntered.promise;
    const secondCall = withCursorAuthSession(second.workspace, {
      CURSOR_AUTH_CONFIG_HOME: second.authRoot
    }, async () => {
      secondEntered.resolve();
      await release.promise;
    });
    await secondEntered.promise;
    release.resolve();
    await Promise.all([firstCall, secondCall]);
  } finally {
    release.resolve();
    await Promise.all([removeFixture(first), removeFixture(second)]);
  }
});

test('an aborted queued call rejects and releases its queue position', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cursor-auth-abort-'));
  const workspaceOne = path.join(root, 'workspace-one');
  const workspaceTwo = path.join(root, 'workspace-two');
  const workspaceThree = path.join(root, 'workspace-three');
  const authRoot = path.join(root, 'auth');
  await Promise.all([workspaceOne, workspaceTwo, workspaceThree].map((entry) => mkdir(entry)));
  await mkdir(path.join(authRoot, 'cursor'), { recursive: true });
  const firstEntered = deferred();
  const releaseFirst = deferred();
  let secondEntered = false;
  let thirdEntered = false;

  try {
    const env = { CURSOR_AUTH_CONFIG_HOME: authRoot };
    const first = withCursorAuthSession(workspaceOne, env, async () => {
      firstEntered.resolve();
      await releaseFirst.promise;
    });
    await firstEntered.promise;

    const controller = new AbortController();
    const second = withCursorAuthSession(workspaceTwo, env, async () => {
      secondEntered = true;
    }, { signal: controller.signal });
    const third = withCursorAuthSession(workspaceThree, env, async () => {
      thirdEntered = true;
    });
    controller.abort();

    await assert.rejects(second, (error) => error?.name === 'AbortError');
    assert.equal(secondEntered, false);
    assert.equal(thirdEntered, false);
    releaseFirst.resolve();
    await Promise.all([first, third]);
    assert.equal(thirdEntered, true);
  } finally {
    releaseFirst.resolve();
    await rm(root, { recursive: true, force: true });
  }
});

test('normalizes existing persistent directory and file modes on POSIX', {
  skip: !isPosix && 'POSIX mode assertions'
}, async () => {
  const value = await fixture();
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"old"}');
    await chmod(value.authRoot, 0o777);
    await chmod(value.cursorDirectory, 0o777);
    await chmod(persistentAuth, 0o666);

    await withCursorAuthSession(value.workspace, {
      CURSOR_AUTH_CONFIG_HOME: value.authRoot
    }, async () => {});

    assert.equal((await lstat(value.authRoot)).mode & 0o777, 0o700);
    assert.equal((await lstat(value.cursorDirectory)).mode & 0o777, 0o700);
    assert.equal((await lstat(persistentAuth)).mode & 0o777, 0o600);
  } finally {
    await removeFixture(value);
  }
});

test('writes replacement files with exact private modes under a restrictive umask', {
  skip: !isPosix && 'POSIX mode assertions'
}, async () => {
  const value = await fixture();
  const originalUmask = process.umask(0o177);
  try {
    const persistentAuth = path.join(value.cursorDirectory, 'auth.json');
    await writeFile(persistentAuth, '{"token":"old"}');

    await withCursorAuthSession(value.workspace, {
      CURSOR_AUTH_CONFIG_HOME: value.authRoot
    }, async (xdgHome) => {
      await writeFile(path.join(xdgHome, 'cursor', 'auth.json'), '{"token":"new"}');
    });

    assert.equal((await stat(persistentAuth)).mode & 0o777, 0o600);
  } finally {
    process.umask(originalUmask);
    await removeFixture(value);
  }
});

test('preserves runtime, writeback, and cleanup errors while scrubbing pinned credentials', {
  skip: process.platform !== 'linux' && 'Linux directory-handle cleanup assertion'
}, async () => {
  const value = await fixture();
  const runtimeError = new Error('runtime failed before cleanup');
  let movedXdg;
  try {
    await writeFile(path.join(value.cursorDirectory, 'auth.json'), '{"token":"secret"}');

    await assert.rejects(
      withCursorAuthSession(value.workspace, {
        CURSOR_AUTH_CONFIG_HOME: value.authRoot
      }, async (xdgHome) => {
        movedXdg = `${xdgHome}-moved`;
        await rename(xdgHome, movedXdg);
        await chmod(movedXdg, 0o000);
        throw runtimeError;
      }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.ok(error.errors.includes(runtimeError));
        assert.ok(error.errors.some((entry) => /temporary XDG directory changed/.test(entry.message)));
        assert.ok(error.errors.some((entry) => ['EACCES', 'EPERM'].includes(entry.code)));
        return true;
      }
    );

    await assert.rejects(
      readFile(path.join(movedXdg, 'cursor', 'auth.json')),
      (error) => error?.code === 'ENOENT'
    );
  } finally {
    if (movedXdg) {
      await chmod(movedXdg, 0o700).catch(() => {});
      await rm(movedXdg, { recursive: true, force: true });
    }
    await removeFixture(value);
  }
});
