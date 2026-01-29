# things to do

usage report:
SDK has a usage API
look into the output, it's probably a percentage used or remaining
make a index.html change to put simple text div at the top of the session list above new chat button
make a new websocket message type that reads usage when agent becomes idle (throttle to 60 seconds) and pushes websocket packet to all clients maybe 'usage' packet type
update text to something super clear (100% of budget remaining) or (0% of budget used)

agent-to-agent recursion or loop defense
server-side, like failure for  agent-to-agent MCP tools or POST endpoint protection

MPC wrapper for apps
Once an agent figures out how to solve a problem, it can write an applet that solves the same problem using the same MCP tools.