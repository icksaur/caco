# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**

Enhanced meta-context UI.  When setting session meta-context, agents would need to be prompted to respond with relevant file and applet links.  This relies on agent to remember to send links, and bloats responses and all further context.  We could automate this by handling meta-context tool calls by emitting syntetic caco events which put links below the chat input in footer.  Limit to filenames and applets only with URLs opening text-editor for files, or other applet if relevant.  Need to keep the interface small for iOS usage.
Suggest other UX, or collapsability (how to show again?)
Populate meta-context links on session history load and meta-context WS events

fix debounced rendering bouncing up and down: when deltas come in we append to bottom, scrolling chat.  When delta comes, we show it in new div changing content height.  When delta is enough to add to some markdown, it disappears, changing chat height moving content back down.  This repeats making blocks of markdown shake up and down as chat changes vertical length.
Ideas: keep the enough delta div to store one line of delta, so that when clearing it so there's a place for buffering to prevent jitter.  When idle or delta is complete, remove the line.
Other ideas?

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass