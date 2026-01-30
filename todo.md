# things to do

Scheduler.  Make a success criteria, considerations, and tasklist doc in doc/schedule.md.
Data in .caco/ that server loads.  Maybe {slug, prompt, time-of-day, cadence, [last-run], [last-session-id], [state]} not sure if it should cache and reuse a session, or make and clean up own sessions.  Scheduled items should persist sessionId in .caco cache and try to reuse them, else make a new one.  schedule-manager.ts checks every 30 minutes and if something is at due date, run it.  Once it's idle it will look for next one or delay. Do not allow parallel scheduled sessions to avoid issues.  Immediately run things overdue at load time, but enforce one at a time.
API something like:
read all .caco/schedule/slug-here/definition.json,last-run.json
GET /api/schedule/ list of schedule stuff json{[{slug, time, cadence, last, state}]}
PUT /api/schedule/ json{slug, prompt, time, cadence, run-now} (puts file and adds to in-memory schedule)
I think this is enough to let us do anything.

Cleanup.  Any cached data in .caco we leave around? Any orphaned or old sessions?  Does SDK to this?

UI: All scrollbars are big (and ugly in Edge).  Stick scrollbar on far right of UI, make it thin with styles?

UI: on iOS the applet hamburger button is not visible.  Maybe we have a min chat div size pushing it off.

Multi-client support.  How far are from allowing multiple browsers?  Websocket might not be ready, or will spit everything to every client (they could filter to their own clientId?)  HTTP APIs are mostly stateless.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized or 