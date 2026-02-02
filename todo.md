# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**

#code-quality.md brutal code review for back-end

remove run_and_display, render_file_contents, display_image.  Applets and embed_media can handle.

change embed_media to respond that the media embedding happens in front-end and success is not available at tool layer

investigate how git front-ends work.  Make case study for git status applet.  Consider streaming to applet changes or what applet functionality is required.

API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.

API consolidation - read API.md and find redundant or simplification when things can either be generalized.  We have many HTTP routes and perhaps some of them can be combined to provide the same behavior surface area.

