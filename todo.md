# things to do

rebrand this project to "Caco" (lowercase caco for slugs, filenames variables).  Change all display text to "Caco"  Change ".vscode-web" to ".caco".  Update all applet code and docs.  Move ./.caco/ to be found in ~/.caco/.  This workspace directory name is fine for now.

applet input segregation - only visible app gets mouse, keyboard, gamepad, camera, whatever input.  May require frames or iframe?  Needs:
applet-os.md reqs list
input segregation
current state analysis
study for how to implement cleanly, concerning NavigationAPI etc.
make decision
simplify all applet input code

app-to-session vision flow:
apps can send image data to agent when making requests

agent-to-agent recursion or loop defense
server-side, like failure for  agent-to-agent MCP tools or POST endpoint protection

generic MPC wrapper
J