# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**

Address eslint - I think we usually run with a quiet parameter.  Need to ensure all warnings are actually benign.

Enhanced meta-context UI.  When setting session meta-context, agents would need to be prompted to respond with relevant file and applet links.  This relies o We could automate this by handling meta-context tool events by emitting syntetic caco events which put links below the chat input in footer.  Limit to filenames only with URLs opening text-editor.  Applet can also get a link.  Need to keep the interface small for iOS usage.
Suggest other UX, or collapsability (how to show again?)
Populate meta-context links on session history load and meta-context WS events

Implement thinking-feedback.md - show "💭 Thinking..." on `assistant.turn_start` until content arrives.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass