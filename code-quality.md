# code quality

1. correctness - code that does what we want
2. maintainability - it's easy to add new features and easier to fix defects (bugs)

The purpose of code quality is to achieve correctness and maintainability. Code review supports code quality. A review is constructive.  A review is composed of comments and suggestions.

# concepts

code is a liability
less is more
simple is best
correct by design

## worst

complexity - the greatest enemy!
coupling - source of complexity!
wrong abstraction - expensive forever!

## bad

relying on side effects
global state
unnecessary layers of abstraction
side effects
mutable objects
code must be kept in sync

## good

strong typing catches issues at compile time
unit tests prevent regressions and toil
directory structure matches layers and components
proper layering
minimal code
separation of concerns
encapsulation over inheritance
leverage runtime behavior - polymorphism branches
leverage language features - reduces code
classes have one purpose (SRP)
functional procedures
enforced valid classes
only one way to do one thing
descriptive data
data driven behavior
descriptive, self-documenting names
immutable objects
consistent naming

## comments

Make the code say what it can through names, types, and structure. Use
comments only for what the code cannot say.

keep (do not flag):
- why this approach, not the obvious alternative
- invariants/contracts the type system can't express
- units, ranges, sentinels (ms; 0 = no timeout)
- non-local constraints ("consumed by mobile v3; don't reorder fields")
- workarounds with a link and a removal condition
- public API contract: inputs, side effects, errors, idempotency

flag (delete or rewrite):
- restates the code, or narrates it line by line
- explains what a name means -> rename instead
- commented-out (dead) code -> delete; VCS remembers
- vague TODO with no owner/issue/removal condition
- stale comment that disagrees with the code -> worse than none; treat as a bug

# improving codebases

Ask these questions before adding a feature:
Can we get 90% of the requirement with 10% of the code?
Should we refactor before adding behavior to ensure correctness?

Ask these questions after fixing a bug:
What was the **code quality** issue or issues that allowed this bug in the first place?

# implicit coupling

A real contract that lives in one place, is invisible at the call site that violates it, and fails silently. Two reasonable-looking pieces produce wrong behavior together.

## smells

at the violation site:
- function returns the "no-data" sentinel (0, null, empty) on contract violation, indistinguishable from real "no-data"
- a measurement, query, or computation with no error path

at the contract owner:
- comments with "must", "always", "never", "be sure to"
- workarounds named `ensure_`, `fix_`, `patch_`, `normalize_`
- helpers that exist only to call other helpers in the right order
- magic values shared across files

at the seam:
- bugs that require reading 3+ files
- test setup longer than the test
- fixes that "match what the other code expects" rather than "do the right thing"

## detection questions

ask of any non-trivial code:
- what is the smallest change to a DIFFERENT file that would silently break this?
- if this returns null/0/empty, can the caller distinguish "correct empty" from "contract violation"?
- could I call these in the other order? what happens?

## fixes, ranked by leverage

1. make the wrong thing unrepresentable (types, schema constraints, builder patterns)
2. encapsulate the contract (one function owns it; all callers route through)
3. assert at the boundary (throw, log loudly, fail tests early)
4. test the seam, not the units (most implicit-coupling bugs only show across boundaries)
5. last resort: comment at every call site (cheap, high-decay)