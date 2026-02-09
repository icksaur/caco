# TODO

Applet button can overlap applet content.  Applets are agnostic of the rest of the UI for the most part, by design.  But applets can be generated with buttons or text that is hidden by these elements.  When expanded, the session button has the same problem.  We should either: document in applet_howto to avoid the top left and top right by putting any content high in the view centered (to avoid corners).  Or there can be some kind of header format standard to all applets, but seems like a waste of space.  Not sure if there is any other scheme to avoid the corners that applets can all inherit.  Simple solution needed.

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

review unit tests for low-value or brittle tests