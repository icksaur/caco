/**
 * Browser A11y Snapshot Formatter
 *
 * Converts puppeteer-core's accessibility snapshot (`page.accessibility.snapshot()`)
 * into a compact text outline the agent can reason about. Each interactive element
 * gets a stable bracketed id the agent can pass back via caco_browser_action.
 *
 * Pure function: no puppeteer-core dependency. Tested with recorded fixtures.
 */

export interface AxNode {
  role?: string;
  name?: string;
  value?: string | number;
  description?: string;
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  modal?: boolean;
  multiline?: boolean;
  multiselectable?: boolean;
  readonly?: boolean;
  required?: boolean;
  selected?: boolean;
  pressed?: boolean | 'mixed';
  level?: number;
  valuemax?: number;
  valuemin?: number;
  autocomplete?: string;
  haspopup?: string;
  invalid?: string;
  orientation?: string;
  children?: AxNode[];
}

export interface SnapshotOptions {
  maxNodes?: number;
  /** Interactive-role filter. Non-interactive roles are still walked for structure but skipped from numbering unless headings/landmarks. */
  includeStructural?: boolean;
}

export interface SnapshotResult {
  outline: string;
  nodeCount: number;
  truncated: boolean;
}

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'switch', 'tab',
  'slider', 'spinbutton', 'listbox', 'tree', 'treeitem', 'gridcell', 'row',
]);

const STRUCTURAL_ROLES = new Set([
  'heading', 'iframe', 'dialog', 'alertdialog', 'navigation', 'main',
  'region', 'banner', 'contentinfo', 'form', 'search',
]);

const SKIP_ROLES = new Set([
  'StaticText', 'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak',
]);

export function formatSnapshot(root: AxNode | null, opts: SnapshotOptions = {}): SnapshotResult {
  const maxNodes = Math.min(opts.maxNodes ?? 200, 1000);
  const includeStructural = opts.includeStructural ?? true;

  if (!root) {
    return { outline: '(no accessibility tree)', nodeCount: 0, truncated: false };
  }

  const lines: string[] = [];
  let counter = 0;
  let truncated = false;

  const walk = (node: AxNode, depth: number): void => {
    if (counter >= maxNodes) {
      truncated = true;
      return;
    }
    const role = node.role || '';
    const skip = SKIP_ROLES.has(role);
    const interactive = INTERACTIVE_ROLES.has(role);
    const structural = STRUCTURAL_ROLES.has(role);
    const include = interactive || (includeStructural && structural);

    if (!skip && include) {
      counter += 1;
      lines.push(renderLine(counter, depth, node));
    }

    if (node.children) {
      const nextDepth = include ? depth + 1 : depth;
      for (const child of node.children) {
        if (counter >= maxNodes) {
          truncated = true;
          break;
        }
        walk(child, nextDepth);
      }
    }
  };

  walk(root, 0);

  return {
    outline: lines.length > 0 ? lines.join('\n') : '(no interactive elements found)',
    nodeCount: counter,
    truncated,
  };
}

function renderLine(id: number, depth: number, node: AxNode): string {
  const indent = '  '.repeat(depth);
  const role = node.role || 'unknown';
  const parts: string[] = [`${indent}[${id}] ${role}`];

  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.value !== undefined && node.value !== '') parts.push(`value=${JSON.stringify(node.value)}`);

  const flags: string[] = [];
  if (node.checked === true) flags.push('checked');
  if (node.checked === 'mixed') flags.push('mixed');
  if (node.pressed === true) flags.push('pressed');
  if (node.selected) flags.push('selected');
  if (node.expanded === true) flags.push('expanded');
  if (node.expanded === false) flags.push('collapsed');
  if (node.disabled) flags.push('disabled');
  if (node.required) flags.push('required');
  if (node.readonly) flags.push('readonly');
  if (node.focused) flags.push('focused');
  if (node.modal) flags.push('modal');
  if (node.invalid && node.invalid !== 'false') flags.push(`invalid=${node.invalid}`);
  if (flags.length > 0) parts.push(`(${flags.join(',')})`);

  if (node.description) parts.push(`-- ${node.description}`);
  return parts.join(' ');
}
