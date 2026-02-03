# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**


Suggest a design to allow Caco agents to discover and use applet functionality to do useful things without LLM round-trip.
open applet with query to relevant directory, image, text, diff, repo.  Agent can respond with markdown URLs for most useful functionality.

Markdown render user.message.

Debounced rendering for assistant.delta_message for incremental markdown.

Review vision.md.  Create doodle applet with button to send sketch to prompt using image paste UI and code.  Ensure caco agents can read doodle image data.  See applet.md for considerations to the communication method.

Do we have too many internal tools?  Do the tool descriptions clog context for weaker models?

eventually want to combine schedule and session-list.  Currently jobs applet is schedule UI.  User needs to use it more.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass