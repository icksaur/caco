# TODO

Fix debounced rendering bouncing up and down:
Use chat-ux.md for scratch space detailing problem, analysis and solution.
when deltas come in we append to bottom, scrolling chat.  When delta comes, we show it in new div changing content height.  When delta is enough to add to some markdown, it disappears, changing chat height moving content back down.  This repeats making blocks of markdown shake up and down as chat changes vertical length.
Ideas: keep the enough delta div to store one line of delta, so that when clearing it so there's a place for buffering to prevent jitter.  When idle or delta is complete, remove the line.
Other ideas?

We have a few .min.js from the net.  Should these come from packages?  We could be at risk or miss out on improvements.  Or the license is not ok for putting in my repo and publishing, etc.  Please ananlyze the risks.

Remove all emoji from backend and frontend.  Leave in applets.  Prompt change that user prefers no emoji, markdown elements are ok, and basic unicode glyphs.

Applet button can overlap applet content.  Applets are agnostic of the rest of the UI for the most part, by design.  But applets can be generated with buttons or text that is hidden by these elements.  When expanded, the session button has the same thing.  We should either: document in applet_howto to avoid the top left and top right by putting any content high in the view centered (to avoid corners).  Or there can be some kind of header format standard to all applets, but seems like a waste of space.  Not sure if there is any other scheme to avoid the corners that applets can all inherit.  Simple solution needed.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

review unit tests for low-value or brittle tests