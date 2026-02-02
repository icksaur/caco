# code quality

1. correctness - code that does what we want
2. maintainability - it's easy to add new features and easier to fix defects (bugs)

The purpose of code quality is to achieve correctness and maintainability. Code review supports code quality. A review is constructive.  A review is composed of comments and suggestions.

# concepts

code is a liability
less is more
simple is best

## worst

complexity - the greatest enemy!
coupling - source of complexity!
wrong abstraction - expensive forever!

## bad

global state
unnecessary layers of abstraction
side effects
mutable objects
huge comments - variables and class names should explain why

## good

obvious directory structure
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
