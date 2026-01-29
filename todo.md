# things to do

create doc/applet-os.md
applet input segregation - only visible app gets mouse, keyboard, gamepad, camera, whatever input.  Naieve implementations of applets send keyboard to chat and applet.
May require iframe.  Other options?  Search online or github.
Needs:
applet-os.md reqs list:
input segregation
current state analysis
what breaks? applet websockets? applets with href like applet-browser?
study for how to implement cleanly, concerning NavigationAPI etc.
decide if it's not worth it - applets global JS state may be powerful but a bit fiddly
make suggestion to user

app-to-session vision flow:
apps can send image data to agent when making requests

agent-to-agent recursion or loop defense
server-side, like failure for  agent-to-agent MCP tools or POST endpoint protection

generic MPC wrapper
J