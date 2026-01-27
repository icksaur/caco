Okay, next up let's think about storage.  applet.md requirements will eventually include storage, but we already have some need for storage:

render_file_contents, run_and_display, display_image, and embed_media all prepend content to the response, but those are lost when the session is loaded again.

# goals
per-session storage with embeds and specialized tool inserts
applet storage

# considerations

file structure
storage root discovery - where do we start? cwd of this project?
expect conversation history from session load, and append embeds+tool output, or keep entire history in self storage (duplicate and desync risk) do messages have Ids for finding correlating embed data lookup?

# implementation
storage layer?
pass-through for existing custom tools (listed above)
generic CRUD API for applets?