# things to do

config to choose port.  Why 3000? Is that a go-to default?

Do we need all these npm dependencies?  Are any dead?  Are any so trivially used we can implement it in a single JS line and remove the dep?

Multi-client support.  How far are from allowing multiple browsers?  Websocket might not be ready, or will spit everything to every client (they could filter to their own clientId?)  HTTP APIs are mostly stateless.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized or 