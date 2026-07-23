# The Host owns DevTools state; the Relay transports bytes

The Host is the only layer with both iframe Pairings and CDP Client context,
so it owns Targets, Sessions, browser/Target commands, domain-enable state,
and event routing. The Frame Agent owns only document-facing behavior.

The Relay assigns Client ids, forwards raw CDP messages, and caches Target
summaries for discovery. Keeping CDP semantics out of the Relay prevents
split ownership and lets local `host.attach()` Sessions use the same path as
remote Sessions without a server round trip.
