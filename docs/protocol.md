# XPSync protocol v1

## Transport and authentication

Native WebSocket at `/ws`, one connection per mapped project. No API key or JWT in the URL. JSON messages, incoming limit 256 KiB, 100 messages/second/connection. Unauthenticated connections close after 10 seconds. Server pings every 30 seconds; slow consumers and stale connections are disconnected. Deploy through HTTPS/WSS outside a trusted LAN.

```json
{
  "type": "join",
  "projectApiKey": "xps_prj_<64 hex characters>",
  "username": "Alice",
  "originId": "device-uuid",
  "clientVersion": "1.0.0"
}
```

Server binds the socket to the verified project. Mutation payloads cannot pick another project. The same origin ID does not suppress other sockets; only the sender socket is excluded from the broadcast. This avoids silent data loss if two sessions accidentally share an origin ID.

`snapshot` includes `{project, tasks, serverTime}`. Tasks include tombstones. `presence` includes `{users: string[]}`, deduplicated by display name within that project. The client can request another snapshot with `{"type":"task:full_sync"}`. Disappearing from a snapshot does not mean deletion; only a tombstone does.

## Mutations

```json
{
  "type": "task:push_mutation",
  "mutationId": "uuid-stable-across-retries",
  "taskId": "canonical-task-id",
  "operation": "upsert",
  "timestamp": 1790442000000,
  "changes": { "title": "Design database", "isDone": true }
}
```

Allowed changes: `title`, `isDone`, `notes`, `timeSpent`, `timeEstimate`, `parentId`. Unknown fields are rejected. New tasks require a nonempty title; existing tasks accept partial patches. A delete has `operation: "delete"` and `changes: {}`.

Task state:

```ts
interface SyncTask {
  id: string;
  projectId: string;
  data: {
    title: string;
    isDone: boolean;
    notes: string;
    timeSpent: number;
    timeEstimate: number;
    parentId: string | null;
  };
  versions: Record<string, [timestamp: number, mutationId: string]>;
  deleted: boolean;
  updatedAt: number;
  lastUpdatedBy: string;
}
```

Versions compare timestamps, then mutation IDs lexicographically. Only winning fields are changed. Old delete requests are rejected if any field has a newer version. Once accepted, deletion is terminal and includes descendants, even if a descendant has a concurrent edit. Creating again requires a new ID. Parent references must exist in the same project; cycles are rejected transactionally.

All changes, activity and mutation receipt are committed in one SQLite transaction. Retry of the same mutation ID produces `changed: false`, no duplicate activity and no broadcast. Receipts are scoped by project; clients must use unique mutation IDs for different operations.

- Sender: `task:ack` with `{mutationId, changed, task, tasks}`. `task` is the primary task; `tasks` includes any cascaded tombstones. ACK returns authoritative state even when a stale patch loses.
- Peers: `task:remote_mutation` with `{task, tasks, originId}`.
- Error: `error` with `{error, mutationId?, fatal?}`. The plugin retains failed mutations and shows an error; manual full sync retries. Key rejection/revocation closes with code `4003` and requires saved configuration to restart.

## Client reconciliation

1. Snapshot current local data and compare to the last observed baseline before applying remote messages.
2. Queue only changed fields. Store the queue durably before sending.
3. Merge server tasks with queued local patches; pending values remain visible until ACK adjudicates conflicts.
4. Apply parents before children, resolve canonical IDs to locally generated IDs, and delete children before parents.
5. Update baseline to expected values and mark remote application for two seconds. Serialized hook scans plus baseline comparisons suppress delayed echoes without ignoring subsequent real edits.
6. Send one outstanding mutation per connection. On disconnect keep it; reconnect obtains a snapshot and retries the same mutation ID. Terminal server tombstones cancel pending mutations for those IDs.

## Admin REST

| Method       | Path                               | Access                                   |
| ------------ | ---------------------------------- | ---------------------------------------- |
| GET          | `/health`                          | Public                                   |
| GET          | `/api/auth/status`                 | Public, setup-required boolean only      |
| POST         | `/api/auth/setup`                  | First admin only, requires setupToken    |
| POST         | `/api/auth/login`                  | Username/password → 8-hour JWT           |
| POST         | `/api/client/verify`               | Project API key → project id/name        |
| GET/POST     | `/api/projects`                    | Admin Bearer JWT                         |
| PATCH/DELETE | `/api/projects/:id`                | Admin Bearer JWT                         |
| POST         | `/api/projects/:id/regenerate-key` | Admin; revokes connected project clients |
| GET          | `/api/projects/:id/tasks`          | Admin; live tasks only                   |
| GET          | `/api/projects/:id/logs`           | Admin; latest 100 entries                |

Admin sockets join with `{"type":"admin:join","token":"<JWT>"}` and receive `admin:ready` and `admin:changed` invalidations. Dashboard reloads protected REST resources after invalidation. Token expiration is checked by heartbeat; REST always verifies expiry.

## Changes from the initial plan

- `ws` implements the plan's native WebSocket alternative, avoiding a Socket.IO client bundle in SP.
- Use better-sqlite3 directly with prepared statements; Drizzle is unnecessary for this small schema. `tasks.data` and `tasks.versions` store scoped values and field clocks as JSON.
- API keys are hashed and revealed only at creation/rotation. Passwords use salted scrypt, admin bootstrap requires a token, and JWT lives in dashboard sessionStorage.
- Remote/local task IDs are mapped because `addTask()` does not accept an ID. Parent links use the current batch API.
- Persistent outbox, field versions, receipts and terminal tombstones replace a timestamp-only record and a TTL-only suppression approach.
- No default admin credentials. First-run setup is explicit and cannot be rerun once an admin exists.
