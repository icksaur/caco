---
name: overkill-review
description: How to review a plan or code change for complexity or "overkill" issues, where the change is more complex than it needs to be to achieve the goal.
---

1. Identify the goal of the change or plan. What is it trying to achieve?
2. Review the change or plan and identify areas of complexity. Complexity is the greatest enemy.
3. For each area of complexity, ask if it is necessary to achieve the goal. If not, it may be overkill.
4. Ask if we can get 90% of the way with 10% of the complexity.

Example:
We need to automatically handle an uncommon edge case which is one-time configuration.  We can:
1. Add a complex new subsystem to handle this edge case and future edge cases (overkill)
2. Tell the user to restart the program (simple, 90% solution)