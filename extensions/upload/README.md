# Local file uploads

`upload_local_file` is a local Pi tool. It orchestrates the host's existing
`ts_oht.upload_file` and `ts_oht.get_file_url` MCP tools, then streams raw bytes
directly to the returned S3 targets. No new MCP server/client, S3 SDK, runtime
dependency, MCP key storage or S3 credentials are introduced.

## Requirements and authorization

- Pi with `ctx.executeTool` (tested with 1.1.0). The package's older provider
  compatibility floor is not a promise of upload support on older hosts.
- The plugin registers `ts_oht` with the default public endpoint; optional
  `tsgw.mcpUrl` overrides it. A same-name global/project MCP file entry wins,
  including a disabled entry. Pi manages the connection and OAuth; the upload
  tool still requires its upload/URL tools to be connected and callable. Hidden,
  disabled, blocked or not-yet-connected tools produce an error; the tool does
  not activate them, create its own connection, or read/modify MCP configuration.
- The current service's `mode` / `uploads[]` contract is required. The old
  `uploadUrl`-only contract is not supported.
- The tool uses the Pi process's OS file permissions, not a sandbox or the
  built-in `read` tool's path approvals. Authorize **file exfiltration**, not just
  reading. Gate `upload_local_file` in your permission extension where needed;
  both the outer tool and nested MCP calls pass through host permission hooks.
- Paths belong to the plugin machine/container, not necessarily your browser's
  computer. Relative paths use the session cwd; `~/` expands to the host home.
  Symlinks resolve to their canonical regular file; directories/devices/FIFOs
  are rejected. There is no implicit cwd-only allowlist.
- The server advertises a 300-second planning/completion limit. Configure the
  host MCP timeout to at least 330 seconds if needed. The plugin cannot override
  that per call and never edits the user's settings. The host default may end a
  call earlier. The local 330-second MCP deadline bounds waiting, not remote work.

## Tool interface

```ts
upload_local_file({
  path: string,
  contentType?: string,
  expiresIn?: number,                 // integer 1–604800; default 86400
  disposition?: "inline" | "attachment", // default inline
  resume?: string                    // unchanged receipt from a failed call
})
```

`contentType` must not contain charset/other parameters. The default is a
best-effort extension mapping, falling back to `application/octet-stream`;
this is not content sniffing. The program reads the real size and timestamps,
never taking these from model-supplied arguments. File names must satisfy the
service's UTF-8 name restrictions.

- 1 byte through 32 MiB: read a bounded snapshot and send one raw PUT.
- Above 32 MiB through the service's current 5 TiB safety ceiling: stream the
  returned part ranges with at most **3 workers**, without buffering the whole
  file or a whole large part. The backend may impose lower limits; the extreme
  size is a protocol bound, not a claim of endpoint acceptance/performance.
- Validate mode, key/uid, part geometry, unique part numbers, sizes, HTTP method,
  headers and expiration. A one-part remaining plan is still multipart.
- Follow no redirects and perform no automatic PUT retries. Targets must use
  public HTTPS on port 443. DNS addresses are checked and pinned for each PUT;
  private/local targets, credential/hop-by-hop headers and non-PUT methods are
  refused. Download and upload targets must share an origin.
- After all multipart PUTs finish, call `upload_file` **once** with the same
  metadata to reconcile and complete. Only the service's `uploaded:true` counts
  as a completed multipart object. No automatic completion loop is used.
- Default requests reuse the service's 24-hour inline URL if still valid.
  Attachment/custom lifetime (or an expired default link) is signed only after
  upload success using `get_file_url`.

The pre-signed PUT deadline is bounded by its signature expiry and a
size-dependent total timeout. User cancellation stops local PUTs and waits for
all workers to settle before releasing the file/lock. MCP cancellation does
**not** guarantee cancellation of service-side work. The plugin does not retry
MCP calls; the host's transport can independently reconnect/re-authenticate.

## Failures and explicit recovery

Results carry `uploaded` (`true`, `false`, or `null` when unknown),
`uploadStatus`, `phase`, `linkStatus`, and safe errors. Never interpret merely
receiving a key or a signed URL as a completed upload.

| Situation | Result / recovery |
| --- | --- |
| Invalid input, missing file or unavailable MCP | Error; no automatic connection, alternate authentication or retry |
| Part failure, timeout or cancellation | Stop the batch; preserve `key`, `uid` and `resume` when known; do not auto-resign or retry |
| Completion response lost | Unknown, not failed; explicit recovery checks the previous key first |
| Upload succeeded but link signing failed | `uploaded:true`, `linkStatus:failed`; preserve key and resume; a still-valid default link is labelled `fallback`, not the requested link |
| Single PUT outcome unknown | Recovery checks the old key only; never repeats the PUT or requests a new object |

To recover, call the same tool with the returned `resume` receipt, the original
path, and desired link options. The receipt contains metadata/identity and the
object key, **not URLs, credentials or file contents**. It is an opaque recovery
record, not an authentication token. Do not edit it or discard it and blindly
start a fresh upload.

Recovery first calls `get_file_url` for the old key. If the object exists, it
returns the link without reading/re-uploading the file (also works when the
local file has since been removed). Only an explicit remote `not-found` allows
an unfinished multipart upload to proceed. Other errors leave the outcome
unknown. A completed upload whose object was deleted is not recreated.

For multipart recovery the file's canonical path, device/inode, size, mtime,
ctime and content type must still match. The service re-plans by the original
metadata and returns only missing parts. The client requires the **same key and
uid** before sending bytes. If the service no longer has the old task, it may
create a different plan during this lookup; that plan is refused without
uploading bytes, and the server's existing cleanup handles it. There is no
service-side resume-by-uid endpoint to avoid this planning side effect.

The tool checks file identity and timestamps before/after streamed ranges and
before completion. This detects normal changes, not malicious timestamp
spoofing; it is not a content hash or snapshot guarantee for mutable large
files. Do not edit an in-progress file. A source change stops completion; the
client never deletes or aborts objects/tasks itself. Service-side cleanup may
still reconcile uploaded parts independently.

A process-local metadata lock prevents overlapping calls through this module,
including while a timed-out host call is still settling. It is **not** a
cross-process/client lock. Stop other clients and wait for outstanding PUTs
before resuming. The server shares bucket access among all authorized clients;
there is no per-user object isolation.

## Links, storage and verification

Download URLs are temporary bearer credentials. Anyone holding one can access
the object. Tool results intentionally include the requested link, but the
plugin never logs signed URLs, headers, raw MCP results or network errors and
never persists recovery state on disk. Host transcripts and trusted tool hooks
can see tool results; handle/export them accordingly. `inline` can execute
active content such as HTML on the storage domain; use `attachment` as needed.

The private temporary bucket is cleaned after approximately seven days.
Re-signing a URL does not extend object retention; deletion/credential expiry
may invalidate a link earlier than its stated expiry.

Automated tests use synthetic files and isolated host/MCP fixtures; they never
use personal configuration or the production gateway. Real endpoint verification
must be explicitly authorized and reported separately from mocked host tests.

After authorization, `TSGW_UPLOAD_LIVE=1 npm run test:upload:live` runs the real Pi
SDK with the host's existing `ts_oht` configuration/authentication and a local
fixture model (no inference request). It creates two small files and one 33 MiB
multipart object, verifies downloaded SHA-256, inline/attachment and custom
lifetimes, interrupts a part batch, and simulates losing the completion response
before explicit recovery. It does not modify client/server configuration or
remove remote objects; existing server retention cleans them. Local fixtures
and in-memory session state are discarded. No signed links are printed.
