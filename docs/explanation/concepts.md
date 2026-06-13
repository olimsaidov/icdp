---
description: "The canonical vocabulary of icdp — Frame Agent, Host, Relay, Client, Target, Pairing, and Session."
---

# Concepts

icdp threads the [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) across four runtimes and three transports. Each runtime borrows words from CDP's own model — *target*, *session*, *attach* — but means something narrower than a real browser does. A loose word here costs you twice: once when you misread the docs, and again when you misread a stack trace. So icdp fixes a small vocabulary and uses it the same way everywhere — in the reference, in the source, and in error messages.

This page is that vocabulary. It is the single source of truth for the seven terms below; every other page links here on first use and capitalizes them exactly. For how the pieces fit together, see the [architecture](/explanation/architecture).

Each entry also lists names to **avoid** — words that the prior art uses, or that read plausibly, but that blur a distinction icdp depends on.

## Frame Agent

The script running inside the iframe'd app that emulates CDP domains against the real DOM. It is the party that ultimately executes commands: a `DOM.querySelector` resolves against that document's actual nodes, a `Runtime.evaluate` runs there via indirect eval.

The Frame Agent is **always included cooperatively by the embedded app** — the Host never injects it. On boot it announces itself to the parent window and then stays dormant: it will not adopt a command channel unless the parent's origin is on its `allowedParents` allowlist. An app that does not ship `startFrameAgent` is invisible to icdp, which is exactly why pointing a [Client](#client) at a non-app origin produces nothing to drive.

::: warning
`allowedParents: "*"` hands DOM read, write, and eval to *any* embedder. Use it only for pages that are themselves sandboxed or throwaway.
:::

::: info Avoid
**driver**, **bridge** — the prior art's names for this script. icdp reserves "bridge" for the Host↔Relay wire protocol, so it cannot also name the agent.
:::

See the [Frame Agent reference](/reference/frame) and [Embed the Frame Agent](/guides/embed-the-frame-agent).

## Host

The hub of the system: code in the parent window that pairs with Frame Agents and fans CDP sessions out to consumers. A consumer is anything that drives a [Target](#target) — the [Relay](#relay) uplink is structurally just *one* consumer, and parent-window code (for example a console panel) can [attach](/reference/host) to Targets locally with no server in the path at all.

The Host owns the shared semantics that make many consumers coexist on one Target: events broadcast to all attached [sessions](#session), and domain enables are ref-counted per Target — so the Relay's `enable` and a local panel's `enable` stack, and a `disable` reaches the frame only when the last holder releases. The Host is also the only party that can destroy a Target; see [Pairing](#pairing).

::: info Avoid
**shell**, **parent connector** — both undersell it. The Host is the authority, not a passthrough; the [Relay is not](#relay), and [the architecture](/explanation/architecture) explains why the hub lives here.
:::

See the [Host reference](/reference/host).

## Relay

The server component exposing a Chrome-compatible CDP endpoint that external Clients attach to over WebSocket. It serves **exactly one Host at a time**; a newly connecting Host takes over from a stale one (*new-wins*), and the Relay emits target destroy/create events to attached Clients across the handover.

The Relay answers registry and housekeeping methods itself (`Target.getTargets`, `Target.attachToTarget`, `Browser.getVersion`, and the rest) because those read the Relay's own session and target state; everything else it forwards to the Host. It does not interpret the protocol beyond that routing.

::: info Avoid
**server**, **facade**, **proxy** — too generic, and "proxy" in particular implies it merely relays bytes. It maintains its own registry of sessions and targets and answers from it, which is more than a proxy does.
:::

See the [Relay reference](/reference/relay) and the [flat-session protocol](/explanation/flat-session-protocol).

## Client

An external CDP-speaking tool — agent-browser, Playwright, chrome-remote-interface — that connects to the Relay over WebSocket. A Client is the consumer at the far end of the chain; it speaks standard CDP and is unaware that the "browser" on the other side is a Relay fronting iframes.

See [Drive with agent-browser](/guides/drive-with-agent-browser).

## Target

One iframe Pairing as seen by Clients. A Target is addressed **exclusively via the flat-session protocol** — `Target.attachToTarget` plus `sessionId` routing on the single browser-level endpoint. There are **no per-target WebSocket URLs**: a Client never connects to a Target, it attaches to one over the connection it already holds. Why this and not nested sessions or per-target sockets is the subject of the [flat-session protocol](/explanation/flat-session-protocol) page.

## Pairing

The Host-side slot an iframe occupies. The distinction that matters: **Target identity belongs to the Pairing, not the iframe element or its document.** Reloads, remounts, and cross-app navigations keep the same `targetId` (surfaced to Clients as `Page.frameNavigated`). The document can die and be replaced and the Target lives on; only the Host destroying the Pairing destroys the Target.

Commands in flight when a document dies **fail fast** with a CDP error and are never replayed. The full story — and why this boundary is drawn here — is in [Target lifecycle](/explanation/target-lifecycle).

## Session

A Client's attachment to one Target, identified by `sessionId`. One Client may hold sessions to many Targets over one connection — that is the point of the flat-session model. Each frame event fans out to every Session attached to that Target, and a Session is the unit a Client detaches independently of the others it holds.
