# things to do


[doc](doc/applet-os.md) needs to be cleaned up.  Remove code examples used for original implementation.

[doc](doc/applet-os.md) SPA (single-page-app) DOM changes via URL (query parameters or fragment identifier).  Do research and include in doc so that we can redirect via URL without reloading page, and only causing DOM modifiers.

?applet=name-here should show applet.  Crrently it flicks back to chat if from chat.

agent-to-agent:
Agents can POST to other sessions or create a new session with a prompt via MCP tool.  Basic prevention of post-to-self via HTTP
make agent-to-agent.md, plan it out, iterate with user

fix POST /api/files/write to make the URL path the file path instead of JSON+Content payload.
ex: POST /api/files/path/to/file.json
update all

rebrand this project to "Caco" (lowercase caco for slugs and folders).  Change all display text to "Caco"  Change ".vscode-web" to ".caco".  Update all applet code and docs.

app-to-session vision flow:
apps can send image data to agent when making requests

agent-to-agent recursion or loop defense
server-side, like failure for  agent-to-agent MCP tools or POST endpoint protection