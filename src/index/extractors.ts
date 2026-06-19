import { type Node } from 'web-tree-sitter';
import { type GrammarId } from './runtime.js';
import { type IndexItem, type IndexSection, type IndexOptions } from './types.js';

type LabelMode = 'name' | 'raw';

type Capture = {
  section: string;
  kind: string;
  container?: boolean;
  label?: LabelMode;
  signature?: boolean;
  /** Optional gate: only capture when this returns true (e.g. C++ prototypes). */
  when?: (node: Node) => boolean;
};

export type LangConfig = {
  grammar: GrammarId;
  captures: Record<string, Capture>;
  /** call-expression callee names treated as tests (js/ts). */
  testCalls?: { names: Set<string>; containers: Set<string> };
};

const SECTION_ORDER = [
  'imports', 'namespaces', 'types', 'interfaces', 'classes', 'functions', 'methods', 'properties', 'tests',
];

const IDENTIFIER_TYPES = new Set([
  'identifier', 'type_identifier', 'field_identifier', 'qualified_identifier',
  'scoped_identifier', 'property_identifier',
]);

function collapse(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

function findIdentifier(node: Node | null, depth = 0): string | null {
  if (!node || depth > 6) return null;
  if (IDENTIFIER_TYPES.has(node.type)) return node.text;
  for (let i = 0; i < node.childCount; i++) {
    const found = findIdentifier(node.child(i), depth + 1);
    if (found) return found;
  }
  return null;
}

function nodeName(node: Node): string {
  const nameField = node.childForFieldName('name');
  if (nameField) return collapse(nameField.text, 60);
  const decl = node.childForFieldName('declarator');
  const fromDecl = findIdentifier(decl);
  if (fromDecl) return collapse(fromDecl, 60);
  return collapse(findIdentifier(node) ?? '?', 60);
}

function signatureSuffix(node: Node): string {
  const direct = findParameterList(node, 0);
  return direct ? collapse(direct, 50) : '()';
}

function findParameterList(node: Node, depth: number): string | null {
  if (depth > 2) return null;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type.includes('parameter')) return c.text;
    if (c.type.includes('declarator')) {
      const nested = findParameterList(c, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

function hasDescendantType(node: Node, type: string, depth = 0): boolean {
  if (depth > 4) return false;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (!c) continue;
    if (c.type === type) return true;
    if (hasDescendantType(c, type, depth + 1)) return true;
  }
  return false;
}

function labelFor(node: Node, cap: Capture): string {
  if (cap.label === 'raw') return collapse(node.text, 80);
  const name = nodeName(node);
  return cap.signature ? `${name}${signatureSuffix(node)}` : name;
}

/**
 * Walk the syntax tree once, emitting captured declarations grouped into
 * sections. Captured container nodes (class/namespace/...) own their captured
 * descendants as children. Honors the maxEntries budget and sets `truncated`.
 */
export function extractSections(
  root: Node,
  config: LangConfig,
  options: IndexOptions,
): { sections: IndexSection[]; truncated: boolean } {
  const topLevel = new Map<string, IndexItem[]>();
  let count = 0;
  let truncated = false;

  const pushTo = (section: string, item: IndexItem, parent: IndexItem | null): boolean => {
    if (count >= options.maxEntries) {
      truncated = true;
      return false;
    }
    count++;
    if (parent) {
      (parent.children ??= []).push(item);
    } else {
      const list = topLevel.get(section) ?? [];
      list.push(item);
      topLevel.set(section, list);
    }
    return true;
  };

  const testCalls = config.testCalls;

  const endLineFor = (node: Node): number => {
    const end = node.endPosition;
    if (end.column === 0 && end.row > node.startPosition.row) {
      return end.row;
    }
    return end.row + 1;
  };

  const walk = (node: Node, container: IndexItem | null): void => {
    if (truncated) return;

    let nextContainer = container;
    const cap = config.captures[node.type];

    if (cap && (!cap.when || cap.when(node))) {
      const item: IndexItem = {
        label: labelFor(node, cap),
        kind: cap.kind,
        startLine: node.startPosition.row + 1,
        endLine: endLineFor(node),
      };
      const added = pushTo(cap.section, item, container);
      if (!added) return;
      if (cap.container) nextContainer = item;
    } else if (testCalls && node.type === 'call_expression') {
      const callee = node.childForFieldName('function');
      const name = callee ? findIdentifier(callee) : null;
      if (name && testCalls.names.has(name)) {
        const args = node.childForFieldName('arguments');
        const firstStr = args ? firstStringArg(args) : null;
        const item: IndexItem = {
          label: `${name} ${firstStr ?? ''}`.trim(),
          kind: 'test',
          startLine: node.startPosition.row + 1,
          endLine: endLineFor(node),
        };
        const added = pushTo('tests', item, container);
        if (!added) return;
        if (testCalls.containers.has(name)) nextContainer = item;
      }
    }

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child, nextContainer);
    }
  };

  walk(root, null);

  const sections: IndexSection[] = [];
  for (const name of SECTION_ORDER) {
    const items = topLevel.get(name);
    if (items && items.length) sections.push({ name, items });
  }
  return { sections, truncated };
}

function firstStringArg(args: Node): string | null {
  for (let i = 0; i < args.childCount; i++) {
    const c = args.child(i);
    if (c && (c.type === 'string' || c.type === 'template_string')) return collapse(c.text, 60);
  }
  return null;
}

const hasFnDeclarator = (n: Node) => hasDescendantType(n, 'function_declarator');

const TS_CAPTURES: Record<string, Capture> = {
  import_statement: { section: 'imports', kind: 'import', label: 'raw' },
  class_declaration: { section: 'classes', kind: 'class', container: true },
  abstract_class_declaration: { section: 'classes', kind: 'class', container: true },
  interface_declaration: { section: 'interfaces', kind: 'interface', container: true },
  type_alias_declaration: { section: 'types', kind: 'type' },
  enum_declaration: { section: 'types', kind: 'enum' },
  function_declaration: { section: 'functions', kind: 'function', signature: true },
  function_signature: { section: 'functions', kind: 'function', signature: true },
  method_definition: { section: 'methods', kind: 'method', signature: true },
  method_signature: { section: 'methods', kind: 'method', signature: true },
};

const JS_CAPTURES: Record<string, Capture> = {
  import_statement: { section: 'imports', kind: 'import', label: 'raw' },
  class_declaration: { section: 'classes', kind: 'class', container: true },
  function_declaration: { section: 'functions', kind: 'function', signature: true },
  method_definition: { section: 'methods', kind: 'method', signature: true },
};

const CPP_CAPTURES: Record<string, Capture> = {
  preproc_include: { section: 'imports', kind: 'include', label: 'raw' },
  namespace_definition: { section: 'namespaces', kind: 'namespace', container: true },
  class_specifier: { section: 'classes', kind: 'class', container: true },
  struct_specifier: { section: 'types', kind: 'struct', container: true },
  union_specifier: { section: 'types', kind: 'union' },
  enum_specifier: { section: 'types', kind: 'enum' },
  type_definition: { section: 'types', kind: 'typedef' },
  alias_declaration: { section: 'types', kind: 'using' },
  function_definition: { section: 'functions', kind: 'function', signature: true },
  declaration: { section: 'functions', kind: 'function', signature: true, when: hasFnDeclarator },
  field_declaration: { section: 'methods', kind: 'method', signature: true, when: hasFnDeclarator },
};

const CS_CAPTURES: Record<string, Capture> = {
  using_directive: { section: 'imports', kind: 'using', label: 'raw' },
  namespace_declaration: { section: 'namespaces', kind: 'namespace', container: true },
  file_scoped_namespace_declaration: { section: 'namespaces', kind: 'namespace', container: true },
  class_declaration: { section: 'classes', kind: 'class', container: true },
  interface_declaration: { section: 'interfaces', kind: 'interface', container: true },
  struct_declaration: { section: 'types', kind: 'struct', container: true },
  record_declaration: { section: 'types', kind: 'record', container: true },
  enum_declaration: { section: 'types', kind: 'enum' },
  method_declaration: { section: 'methods', kind: 'method', signature: true },
  constructor_declaration: { section: 'methods', kind: 'ctor', signature: true },
  property_declaration: { section: 'properties', kind: 'property' },
};

const TEST_CALLS = { names: new Set(['describe', 'it', 'test']), containers: new Set(['describe']) };

export const LANG_CONFIGS: Record<string, LangConfig> = {
  typescript: { grammar: 'typescript', captures: TS_CAPTURES, testCalls: TEST_CALLS },
  tsx: { grammar: 'tsx', captures: TS_CAPTURES, testCalls: TEST_CALLS },
  javascript: { grammar: 'javascript', captures: JS_CAPTURES, testCalls: TEST_CALLS },
  cpp: { grammar: 'cpp', captures: CPP_CAPTURES },
  csharp: { grammar: 'c_sharp', captures: CS_CAPTURES },
};

const EXTENSION_LANG: Record<string, string> = {
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.cpp': 'cpp', '.cc': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp', '.hh': 'cpp', '.hxx': 'cpp', '.h': 'cpp', '.c': 'cpp',
  '.cs': 'csharp',
};

export function languageForExtension(ext: string): string | null {
  return EXTENSION_LANG[ext.toLowerCase()] ?? null;
}
