# things to do

Browser tab title is Caco, nice, but need to differentiate more.  Find a clean place to get the info for these, and a straightforward way to change it.  view-controller.ts could be leveraged to catch most changes.  May need to do some in Navi
hostname
hostname: cwd (applet name)

dynamic favicon and chat send "hash"
When using multiple computers, make it noticable at a glance to user it's a different host.  Hash hostname to four-byte integer.  Each of byte maps to 1/256 hues.  4 colors are 4 corners on favicon and send button.  CSS blend on hash button.  dither from corners to mix in favicon, or other simple implementation.
Put favicon building in class.  Research favicon browser features.  I have seen small games in favicons so must be an API.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.