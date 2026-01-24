# Skills System

## Default Behavior
The Copilot CLI **automatically loads skills from `~/.copilot/skills`** by default.

You don't need to configure anything - skills in this directory are available automatically.

## Custom Configuration
To use skills from additional directories, explicitly provide the `skillDirectories` array:

```javascript
const session = await client.createSession({
    skillDirectories: ['/path/to/custom/skills', '/another/skills/directory']
});
```

Note: When you specify `skillDirectories`, you **override** the default - so include `~/.copilot/skills` in the array if you want both default and custom skills.

## Structure
Skills are expected in subdirectories within the specified directory, where each skill folder contains a `SKILL.md` file with frontmatter:

```
.test_skills/
  my-skill/
    SKILL.md
```

The SKILL.md format:
```markdown
---
name: my-skill
description: Description of what the skill does
---

# Skill Instructions
...
```

## Disabling Skills
Use the `disabledSkills` array to exclude specific skills by name:

```javascript
const session = await client.createSession({
    skillDirectories: ['/path/to/skills'],
    disabledSkills: ['skill-name-to-disable']
});
```
