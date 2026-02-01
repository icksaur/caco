# things to do

See what docs we have in chatview-design.md.  This was a lot of work to simplify the streaming into clear chat log divs.  There is an annoying problems: Our current design streams into the first activity div with a pretty clean and well-designed inserter strategy.  The first div in an activity div is USUALLY a short intent string.  However, when activity is interleaved with chat responses, it may be a grep tool.  This produces a huge block of text.  Our collapse strategy collapses to a single child div (it was simple).  This works well for single-string intent.  It doesn't do much at all for a grep with all output.  We stream a huge grep output clogging the chatview, and then it can't get any smaller, because the first div with the grep string is huge.  So our design is not sufficient for anything but intent activity divs.
I don't know what to do.  Probably use the functionality in #event-inserter.ts to make all innerInserter content collapsible to a single line.  This will take some investigation to see what properties are best on the first line of the inner activity divs. There is a record map data driving the behavior for when to make an activity class div. We probably need to teach the event inserter to put a one-line div for each known type that goes into activity (these are documented in chatview-design.md) and collapse that too.  It should all be collapsed.  Would be nice if reasoning streams and collapses later.  Needs a clean data-driven solution though.
The end result is two layers of collapses: chatView children collapse to first child div.  Each of those children also collapse to first child div.  Then keep it all collapsed.
This streams new content into the divs without any code changes, and they do not take a huge amount of space.
Look into this and if it's clear, fix.  Otherwise propose solutions.  You'll have to trace the code.  Do not add much complexity, state, or special cases to the front-end.  Keep it simple.  Front-end regressions are awful.
Document anything in #chatview-design.md

investigate how git front-ends work.  Make case study for git status applet.  Consider streaming to applet changes or what applet functionality is required.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.