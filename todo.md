# things to do

agent-to-agent HTTP API:
Agents can POST to other sessions or create a new session with a prompt via MCP tool.  Basic prevention of post-to-self via HTTP route handler blocking same cwd.
make agent-to-agent.md, plan it out, iterate with user

agent-to-agent MCP custom tool:
wrap above in MCP custom tool for agents to call.

session state HTTP API:
ensure we have a GET request that gets a session state, so we can see if an agent session is idle and what the last message is, or if it's busy

fix POST /api/files/write to make the URL path the file path instead of JSON+Content payload.
ex: POST /api/files/path/to/file.json
update all

rebrand this project to "Caco" (lowercase caco for slugs and folders).  Change all display text to "Caco"  Change ".vscode-web" to ".caco".  Update all applet code and docs.

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