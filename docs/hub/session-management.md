# Archives, trash, and permanent deletion

English | [中文](session-management.zh.md)

Open **Settings → Session management**. The page combines online nodes that support this feature, or lets you select a node/Runtime and search by title, project path, or Session id. Every row names its owner; operations execute on that node.

| Action | Result | Undo |
| --- | --- | --- |
| Archive | Hides the Session from normal navigation while retaining history | Select Unarchive under Archived |
| Delete | Moves it to the owning node's trash and removes it from normal lists and Hub discovery | Select Restore under Trash |
| Delete permanently | Erases its source log and historical format generations and removes Workspace membership | Irreversible; requires separate confirmation |

These operations manage Session records. Project directories, user files, and other Sessions remain. Trash never expires automatically and survives node restarts. Restore preserves the state before deletion: an active Session returns to the active list, while a previously archived Session returns to Archived.

## Everyday use

1. Find the Session under Active and choose Archive or Delete. Stop running work first; the node also refuses deletion while background or scheduled work remains active.
2. Use Archived to find previously hidden Sessions and select Unarchive to show them again.
3. Restore mistakes from Trash. When the history is no longer needed, select Delete permanently, check the title and owning node, check the confirmation box, and submit.

After moving to trash, the node rejects old Hub conversation URLs and message requests. Restore makes them available again. The page refreshes its list and the sidebar. An offline node cannot mutate source records; unavailable or outdated nodes are listed explicitly, and failed reads are never presented as an empty inventory.

## When a log is still open

DSH currently has no public per-Session unload operation. A Runtime can retain a Session's write lock after its task finishes. Moving to trash therefore works immediately, while permanent deletion requires a Session that is not attached to the Runtime and an exclusive log lock.

If Trash reports an open log, finish the node's work and restart that Runtime, then return to delete permanently. Closing a browser tab does not guarantee release of the write lock. Hub does not automatically interrupt other tasks on a node to delete one Session.

Permanent deletion removes every log generation of the target Session in that Runtime's persistence directory. The node holds the write lock throughout cleanup and keeps the empty lock file so concurrent writers continue to contend on the same inode. An interrupted purge resumes from a durable journal; a purge that has begun can no longer be restored.

Exported copies and independent backups are outside this deletion scope and must be managed separately.

## Supported deployments

The independent `dsh.session-lifecycle` capability requires an updated Hub, Node Agent, and Connector and the verified DSH `0.1.7-rc.2` JSONL backend. Older nodes retain their existing operations but are shown as needing an upgrade. Historical-format logs must first be opened in DSH to migrate them before archival and deletion.

Trash metadata is stored locally on each node, isolated by Runtime, in an owner-only file. Hub retains minimal discovery and operation audit records and does not take over source Session storage. [Clearing an offline node's Hub cache](console.md) is a separate action from deleting a Session.
