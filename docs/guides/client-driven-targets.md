---
description: "Implement Target.createTarget and Target.closeTarget with Host lifecycle hooks."
---

# Let Clients open and close Targets

The Host recognizes `Target.createTarget` and `Target.closeTarget`, but fails
them unless it was given the corresponding lifecycle hook. The Relay is not
involved beyond carrying the raw CDP message.

```ts
import { IcdpHost } from "@olimsaidov/icdp/host";

const frames = new Map<string, HTMLIFrameElement>();

const host = new IcdpHost({
  onCreateTarget: ({ url }) => {
    const next = new URL(url ?? "/app", "https://app.example.com");
    if (next.origin !== "https://app.example.com") {
      throw new Error("Target URL is not allowed");
    }

    const iframe = document.createElement("iframe");
    iframe.src = next.href;
    document.body.append(iframe);

    const targetId = crypto.randomUUID();
    frames.set(targetId, iframe);
    host.pair(iframe, {
      targetId,
      origins: ["https://app.example.com"],
    });
    return targetId;
  },

  onCloseTarget: (targetId) => {
    frames.get(targetId)?.remove();
    frames.delete(targetId);
  },
});
```

The created page must load the Frame Agent and allowlist the shell's origin.
After `onCloseTarget` succeeds, the Host queues `{ success: true }` before it
unpairs the Target. This matches Chromium's response-before-destroy ordering,
including on a direct `/devtools/page/<targetId>` WebSocket. The hook should
release the underlying resource; it does not need to call `host.unpair()`.

## Create completion

The Host does not return `{ targetId }` until the new Frame Agent completes
its handshake. The default wait is ten seconds. If the Pairing is destroyed
or never connects, the Host unpairs the incomplete Target and returns a CDP
server error.

This prevents a Client from receiving a Target id before its first attach and
command can succeed.

## Validate Client URLs

`onCreateTarget` receives untrusted Client parameters. Restrict the URL,
scheme, and origin before creating an iframe. Pair with an explicit origin
allowlist; do not turn `"*"` into an authorization policy.

With the hooks installed, standard Target commands map to Host lifecycle:

```json
{"id":1,"method":"Target.getTargets","params":{}}
{"id":2,"method":"Target.createTarget","params":{"url":"https://app.example.com/other"}}
{"id":3,"method":"Target.closeTarget","params":{"targetId":"<target-id>"}}
```

See [Target lifecycle](/explanation/target-lifecycle) for identity and reload
behavior.
