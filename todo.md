# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**

doc/session-meta-context.md
Document a session metadata system to preserve session's understanding of:
relevant files (usually a couple of markdown files)
relevant applet (if last used by a session)
spec a way for session resume to be reminded of a small list of relevant documents and applet state
resuming a state could re-open specific applet by navigating to ?applet=slug-here&param=some-params
goals: associate sessions with scratch or design documents they are working on
use case: support ticket-like files where sessions resume reminded of files relevant to their notes about the issue being supported, saving user trouble of re-associating file-based context artifacts when re-selecting sessions

out-of-band agent input:
Inject content into a busy agent session.  Something that causes it to change course without interrupting the "premium request" due to outside influence, similar to stop or permission requests, but automated via arbitrary external factors.

Applet-to-agent efficiency:
review docs for applet-to-agent two-way communication, and ensure they are up-to date
gain complete understanding of current communication method
analyze alternative communication patterns for reliability, simplicity, or speed

Review vision.md.  Create doodle applet with button to send sketch to prompt using image paste UI and code.  Ensure caco agents can read doodle image data.  See applet.md for considerations to the communication method.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass