# TODO

**when working with this doc re-read it after doing compaction/summary and after significant changes**

create and use branch api_revamp
API review.  Find all routes and compare to API.md and update API.md.  Document all HTTP API JSON payload formats.  Document all applet javascript APIs (we have special ones to avoid bugs).  Document custom tool APIs.
API consolidation - read API.md and find opportunities for consolidation.  We have many HTTP routes and perhaps some of them can be combined to simplify our API surface area and thus code.  Do a #code-quality.md review from an API perspective.  Ask hard questions.  Suggest a plan in API.md.  Implement changes to consolidate and simplify to avoid regressions and classes of failure.
build and test
DO NOT COMMIT
Run a final code quality check #code-quality.md on the git diff.
Re-read todo.md (this doc) at end to ensure completion.
Tell the user to test.

---

investigate how git front-ends work.  Make case study for git status applet.  Consider streaming to applet changes or what applet functionality is required.

---

# every so often

Code quality pass with clean Opus agent using code-quality.md

Dead code pass (knip is not perfect)

useless unit test pass