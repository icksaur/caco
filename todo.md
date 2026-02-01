# things to do

remove absolute path from test "copilot-web" should not exist in sources. 

Activity divs need a header child div. Our current design streams into the first activity div with a pretty clean and well-designed inserter strategy.  The first div in an activity div is typically a short intent string.  However it may be a grep tool.  This produces a huge block of text.  Our collapse strategy collapses to a single child div (it was simple).  This works well for single-string intent.  It doesn't do much at all for a grep with all output.  We stream a huge grep output clogging the chatview, and then it can't get any smaller, because the first div is huge anyhow.
I don't know what to do.  Probably use the functionality in #event-inserter.ts to make all innerInserter content collapsible to a single line.  This will take some investigation to see what properties are best on the first line of the inner activity divs.  Then keep them that way by default.
So we end up with two collapses: chatView children collapse to first child div.  Each of those children also collapse to first child div.  Then keep it all collapsed.
This streams new content into the divs without any code changes, but they do not take a huge amount of space.
Look into this and if it's clear, fix.  Otherwise propose solutions.  You'll have to trace the code.  Do not add complexity to the front-end.  Keep it simple.

investigate how git front-ends work.  Make case study for git status applet.  Consider streaming to applet changes or what applet functionality is required.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.