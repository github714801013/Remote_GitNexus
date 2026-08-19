/**
 * Swift same-module (SPM target) implicit visibility.
 *
 * A Swift target has one module-wide top-level declaration space.  This hook
 * publishes that surface once in a gated namespace channel rather than copying
 * every sibling declaration into every module scope.
 */

import type { BindingRef, ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';

const SWIFT_TARGET_NAMESPACE_PREFIX = 'swift-target:';
const TOP_LEVEL_VALUE_KINDS = new Set(['Property', 'Const', 'Variable', 'Static']);
const TOP_LEVEL_TYPE_KINDS = new Set([
  'Class',
  'Interface',
  'Enum',
  'Struct',
  'Union',
  'Trait',
  'TypeAlias',
  'Typedef',
  'Record',
  'Delegate',
  'Annotation',
  'Template',
]);

export function swiftTargetNamespace(targetName: string): string {
  return `${SWIFT_TARGET_NAMESPACE_PREFIX}${targetName}`;
}

/** Return only declarations that Swift exposes as bare target-level names. */
export function swiftTargetVisibleDefs(parsed: ParsedFile): readonly SymbolDefinition[] {
  const scopesById = new Map<ScopeId, Scope>();
  for (const scope of parsed.scopes) scopesById.set(scope.id, scope);

  const seen = new Set<string>();
  const visible: SymbolDefinition[] = [];
  for (const scope of parsed.scopes) {
    const parent = scope.parent === null ? null : scopesById.get(scope.parent);
    const acceptsScopeDefs = scope.kind === 'Module';
    const acceptsTypeScope = scope.kind === 'Class';
    const acceptsFreeFunction = scope.kind === 'Function' && parent?.kind === 'Module';

    for (const def of scope.ownedDefs) {
      const isVisibleType = TOP_LEVEL_TYPE_KINDS.has(def.type) && (acceptsScopeDefs || acceptsTypeScope);
      const isVisibleValue = acceptsScopeDefs && TOP_LEVEL_VALUE_KINDS.has(def.type);
      const isVisibleFunction =
        (def.type === 'Function' || def.type === 'Method') &&
        (acceptsScopeDefs || acceptsFreeFunction);
      if ((!isVisibleType && !isVisibleValue && !isVisibleFunction) || seen.has(def.nodeId)) continue;
      seen.add(def.nodeId);
      visible.push(def);
    }
  }
  return visible;
}

export function populateSwiftTargetSiblings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  ctx: {
    readonly fileContents: ReadonlyMap<string, string>;
    readonly resolutionConfig?: unknown;
  },
): void {
  const config = coerceSwiftTargets(ctx.resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(parsedFiles, (parsed) => parsed.filePath, config);
  const namespaceBindings = indexes.namespaceFqnBindings as Map<
    string,
    Map<string, BindingRef[]>
  >;
  const accessibleNamespaces = indexes.accessibleNamespacesByScope as Map<ScopeId, string[]>;

  for (const [targetName, group] of filesByTarget) {
    const namespace = swiftTargetNamespace(targetName);
    let targetBindings = namespaceBindings.get(namespace);
    const seenByName = new Map<string, Set<string>>();

    for (const parsed of group) {
      const moduleScopeId = indexes.moduleScopes.byFilePath.get(parsed.filePath);
      if (moduleScopeId !== undefined) {
        const existing = accessibleNamespaces.get(moduleScopeId) ?? [];
        if (!existing.includes(namespace)) {
          accessibleNamespaces.set(moduleScopeId, [...existing, namespace]);
        }
      }

      for (const def of swiftTargetVisibleDefs(parsed)) {
        const name = simpleName(def);
        if (name === '') continue;
        if (targetBindings === undefined) {
          targetBindings = new Map<string, BindingRef[]>();
          namespaceBindings.set(namespace, targetBindings);
        }
        let bucket = targetBindings.get(name);
        if (bucket === undefined) {
          bucket = [];
          targetBindings.set(name, bucket);
        }
        let seen = seenByName.get(name);
        if (seen === undefined) {
          seen = new Set(bucket.map((binding) => binding.def.nodeId));
          seenByName.set(name, seen);
        }
        if (seen.has(def.nodeId)) continue;
        seen.add(def.nodeId);
        bucket.push({ def, origin: 'namespace' });
      }
    }
  }
}

function simpleName(def: SymbolDefinition): string {
  const qualifiedName = def.qualifiedName ?? '';
  const dot = qualifiedName.lastIndexOf('.');
  return dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
}
