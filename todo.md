# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**
**after making changes do not commit, review code-quality.md and review the changes for quality issues**
**after making changes do not commit until the user tests**

Schedule improvements:
use session-plan.md and clean that file up with just the status of session UI.
GOAL: Easy to quickly review busy or complete-but-unobserved sessions.
Use case: user running multiple sessions with work, and wants to quickly find to completed sessions.  
Ideas: Put unobserved idle session count on session list badge.  Change session list order to MRU, needs cwd per session line.  Session-list click removes unobserved state from session and decrements badge count.  Must persist on disk.  Perhaps fire event for multi-client to update list.
Built-in schedule and job UI into session list (not sure how to show this, maybe longer scroll is sufficient).  We have untested applet but seems like this should be built-in to default UI.
Remove jobs applet?
Schedule reply: message can be scheduled for some time in the future.  Adds a one-time scheduled job.  Schedule system currently does not support. Needs a method to signify user message was scheduled in history, perhaps a colored tag on user message.  Use case: external system is not ready for an hour, so schedule to check in an hour.

out-of-band agent input:
Is there anything in the SDK or design that would allow us to inject content into a busy agent session?  Something that causes it to change course without interrupting the "premium request"

Applet-to-agent efficiency:
review docs for applet-to-agent two-way communication, and ensure they are up-to date
gain complete understanding of current communication method
analyze alternative communication patterns for reliability, simplicity, or speed

Review vision.md.  Create doodle applet with button to send sketch to prompt using image paste UI and code.  Ensure caco agents can read doodle image data.  See applet.md for considerations to the communication method.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass