# XML and plain-text save regression

The previous loader used `mergeAttrs: true` and passed that flattened object to
the default xml2js builder. A load/save converted `UUID="..."` into a `<UUID>`
child element. The result could be well-formed XML while losing the native
Scrivener representation. The same conversion affected project identity,
timestamps, section types, and unknown metadata attributes.

The loader now preserves xml2js's `$` maps. Non-enumerable accessors retain the
direct field access used by document services and update the underlying
attribute values. Serialization retains attributes on loaded nodes and encodes
the known attributes of newly created binder items. JSON export/import retains
the maps and restores accessors on import. An attribute and child with the same
name remain separate. This preserves the parsed XML structure; byte-identical
formatting, comments, and processing instructions are not promised.

A separate RTF writer bug discarded `plainText` when a content object had an
empty `formattedText` array, the representation used by DocumentManager. The
writer now uses `plainText` in that case and retains formatted segments when
present.

## Verification

Before the fixes, all five new regression tests failed, including an unchanged
load/save and a Korean body that read back as empty. After the fixes, the five
new tests plus ten neighboring tests passed. They cover repeated saves, unknown
metadata, same-name attributes/children, title updates, new binder items,
JSON import/export, Unicode, formatting, and empty content.

Run the focused checks:

```sh
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/unit/services/project-loader-roundtrip.test.ts tests/unit/services/parsers/rtf-handler-plaintext.test.ts tests/unit/services/project-loader-paths.test.ts tests/unit/services/parsers/rtf-handler-unicode.test.ts tests/unit/services/document-manager-recursion.test.ts
```

For an actual stdio MCP write/read check, build first and run:

```sh
npm run build
node scripts/check-save-roundtrip.mjs
```

The script copies the sample project into a fresh temporary directory. An
optional `.scriv` directory argument selects a different source to copy. It
checks an unchanged save, creates a Korean document through MCP, reads it
immediately without polling, and compares all pre-existing XML nodes. It also
creates nested folders and documents, updates their Korean content, closes the
project, renames the database directory to check Windows handle release, and
reopens the project to verify both content and native folder placement. It leaves the copy and a `verification.json` report for inspection in
Scrivener. It does not modify the source project. `save_project` is not an
exposed MCP tool; unchanged saves are checked through ProjectLoader, and the
MCP `create_document` call exercises the public save path.

## Folder creation, write durability, and shutdown follow-up

The creation utility treated native `Children.BinderItem` containers as arrays,
rejected `DraftFolder` and `ResearchFolder`, and wrote content before validating
the destination. Single and batch creation now share native-container handling;
invalid destinations are rejected before content is written. Existing singleton
children are retained, and newly created folders can receive nested documents.

Explicit document writes now persist before returning. Concurrent writes to the
same document are serialized instead of deduplicated, including raw RTF writes.
Project shutdown waits for outstanding document operations.

Several independent connections contributed to Windows file locks:

- DatabaseService did not await asynchronous SQLite shutdown.
- JobQueueService did not close its own project database.
- Replacing the global async queue abandoned its predecessor.
- The MCP open handler created an extra database for MemoryManager and never
  closed it. MemoryManager now shares the project's database, and its final save
  runs before that database closes.
- Failed Redis discovery probes could leave sockets open; all probes now
  disconnect on both success and failure, with bounded command timeouts.

The regression tests cover nested creation, invalid destinations, immediate
read-back, concurrent writes, and queue database cleanup. The real MCP harness
also verifies close/reopen and Windows database-directory rename while the
server remains running.

## Windows verification

On Node 24.18.0, all 56 Jest suites passed: 626 passed, 10 skipped, zero failures
(`--runInBand --forceExit`). The twelve prior path-separator assertions now use
native path normalization; their substantive path expectations are retained.
Both integration cleanup failures are resolved. Type checking, lint, formatting,
build, and the 57-tool registry check passed. A fresh stdio MCP smoke run verified
immediate writes, nested placement, close/reopen, and database unlock; its first
close completed in 36 ms on the verification machine.

The same MCP flow also passed against a disposable copy of the user's tutorial
backup, with a 41 ms close. The output-conformance harness completed with
17 passes, zero failures, and one skip for a sample document without an RTF
file; Windows cleanup succeeded. A final focused 28-test run exited normally
without `--forceExit`.

The full Jest command still explicitly uses `--forceExit`; passing assertions
alone is not evidence that every test suite releases all background handles.
The smoke test exercises project/document operations, not every AI, export, or
analysis tool. Its child process does not receive provider credentials.
