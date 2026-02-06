# Documentation Guidelines

Documents exist to develop and maintain shared understanding of projects over long periods.

## Audience

Documents serve both human users and LLM agents. Optimize for:
- Clarity over style
- Density over formatting
- Scanability over decoration

## Lifecycle

**Working docs**: May grow rapidly as scratch pads during development.
**Stable docs**: Must be compacted and cleaned when implementation is complete.

## Token Efficiency

Documents must minimize token consumption while preserving meaning.

**Prohibited:**
- ASCII art
- Decorative separators (horizontal rules for visual breaks)
- Redundant headings

**Limit:**
- Tables (use only when comparing 3+ items across 3+ dimensions)
- Nested lists beyond 2 levels
- Code blocks for non-code content

**Prefer:**
- Inline descriptions: `- [file](file) - description`
- Parenthetical notes: `## Section (context note)`
- Direct statements over bulleted lists when possible

## Structure

**Good:**
```markdown
## API
- GET /sessions - List all sessions
- POST /sessions - Create session
```

**Wasteful:**
```markdown
## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /sessions | List all sessions |
| POST | /sessions | Create session |
```

## Maintenance

- Remove completed implementation details
- Archive superseded designs
- Update index.md when adding/removing docs
