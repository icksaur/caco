# code quality

1. correctness - code that does what we want
2. maintainability - it's easy to add new features and easier to fix defects (bugs)

The purpose of code quality is to achieve these two.  The purpose of code review is code quality. This list is not exhaustive, but a good set to think about.

## worst

complexity - the greatest enemy!
coupling - source of complexity!
wrong abstraction - expensive forever!

## bad

global state
unnecessary abstraction
side effects
mutable objects
huge comments - variables and class names should explain why

## good

layers
minimal code
separation of concerns
encapsulation over inheritance
leverage runtime behavior - polymorphism branches
leverage language features - 
classes have one purpose
functional procedures
enforced valid classes
only one way to do one thing
descriptive data
data driven behavior
descriptive, self-documenting names
immutable objects
consistent naming
