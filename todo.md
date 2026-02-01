# things to do

We are still working on addressing streaming in tool output like built-ins such as grep and glob.  The issue is that they produce very large amounts of text that bloats the responses.  The current status is that tool output is debounced rendering the tool output, but it shows all of tool output during stream (which is only rarely useful).  It would be better if tool output is pre-collapsed to a single first div.  What IS useful is seeing the reasoning stream.  Perhaps we can:
ensure a smallish descriptive first child is added (tool name, reasoning text, etc).  This can be be done in event-inserter.  Either collapse immediately, or add all assistant-activity divs with collapsed CSS from the beginning.  We can re-add delta streaming for reasoning later after handling the primary case of keeping the output legible.  The current state also is expandable and that works just fine.  But it also shows all tool output.  The individual tools calls do not collapse, unfortunately.  I think it would be ideal if each inner tool call (innerInserter) were collapsed.  The outerInserter div would NOT collapse.  The ideal result is:

(begin grey assitant div) (never collapses!)
reasoning text stream div (post-collapsed click to expand)
"bash" tool div (pre-collapsed w/ click to expand)
"grep" tool div (pre-collapsed w/ cclick to expand)
reasoning text or anything else
(end grey assitant div)

We vastly prefer simple CSS solutions, but a line of JS goes a long way.  It's less risky to have "leaf" JS which is entirely used in one file for rendering nice HTMLElements. State is trouble, and coupling is trouble.

---
for later:

investigate how git front-ends work.  Make case study for git status applet.  Consider streaming to applet changes or what applet functionality is required.

Dead CSS analysis.  Any tools we can use?

Front-end javascript dead code search.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.