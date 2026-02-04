# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**

Spec how to improve Caco applet introspection and ability to use in doc/applet-usability.md
consider moving applets into caco/applets and symlink this directory from ~/.caco/applets, putting all in this repo
Suggestions: system prompt generated from brief applet meta.json URL parameter documentation.  Current parameter docs are user-oriented, not agent-oriented and not obvious that params means url query params.  System prompt is not sufficient for Copilot-CLI originated sessions, so must be discoverable in a new tool as well, like caco_applet_usage
Examples : "to show file to user, include markdown url to ?applet=text-editor&path=path/to/file.txt"
when making changes to files, link to ?applet=git-diff&path=path/to/file.txt"
big change complete -> git-status applet (etc)
Review introspection tools and custom tools for clarity in name and purpose:
applet_howto -> caco_applet_howto: is tool description clear?
caco_applet_usage -> Lists all Applet meta.json?something to show all applet interfaces defined by applets that are accessed via
include get_applet_state and set_applet_state json schemas for applets
Improve applet_howto text for property meta.json format and documentation
Ensure suggestions adhere to [code quality](code-quality.md)

Markdown render user.message.

Debounced rendering for assistant.delta_message for incremental markdown.

Review vision.md.  Create doodle applet with button to send sketch to prompt using image paste UI and code.  Ensure caco agents can read doodle image data.  See applet.md for considerations to the communication method.

Do we have too many internal tools?  Do the tool descriptions clog context for weaker models?

eventually want to combine schedule and session-list.  Currently jobs applet is schedule UI.  User needs to use it more.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass