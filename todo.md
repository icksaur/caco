# things to do

Do we need all these npm dependencies?  Are any dead?  Are any so trivially used we can implement it in a single JS line and remove the dep?

We have SO MANY INTERFACES.  Can some be combined or consolidated?  If they are logically groupable, perhaps this is ok.  Conceptual example: sessionMetadata sessionState sessionDetails sessionWhatever, combine?

Multi-client support.  How far are from allowing multiple browsers?  Websocket might not be ready, or will spit everything to every client (they could filter to their own clientId?)  HTTP APIs are mostly stateless.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.