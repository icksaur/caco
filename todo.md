# things to do

More query strings and NavigationAPI support.  Analyze complexity of adding these query parameters:
?view=sessions
?view=chat
?view=newchat
?applet=applet-slug (exists but needs to co-exist)

Browser tab title is Caco, nice, but need to differentiate more.  Find a clean place to get the info for these, and a straightforward way to change it.  view-controller.ts could be leveraged to catch most changes.  May need to do some in Navi
hostname
hostname: cwd
hostname: applet name

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.