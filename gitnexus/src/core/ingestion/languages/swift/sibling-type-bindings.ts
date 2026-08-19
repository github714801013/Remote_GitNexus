/**
 * Swift target-wide return-type bindings.
 *
 * The target-level declaration channel mirrors Swift's single module namespace:
 * a free top-level function's return type is published once, then consumed only
 * by files registered for that target.  Member methods and nested functions are
 * intentionally excluded because their names require a receiver / lexical owner.
 */

import type { ParsedFile, TypeRef } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../../scope-resolution/workspace-index.js';
import { followChainPostFinalize } from '../../scope-resolution/passes/imported-return-types.js';
import { coerceSwiftTargets, groupSwiftFilesBySpmTarget } from './target-grouping.js';
import { swiftTargetNamespace, swiftTargetVisibleDefs } from './target-siblings.js';

export function mirrorSwiftSiblingTypeBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
  workspaceIndex: WorkspaceResolutionIndex,
  resolutionConfig?: unknown,
): void {
  const config = coerceSwiftTargets(resolutionConfig);
  const filesByTarget = groupSwiftFilesBySpmTarget(parsedFiles, (parsed) => parsed.filePath, config);
  const namespaceTypeBindings = indexes.namespaceTypeBindings as Map<string, Map<string, TypeRef>>;

  for (const [targetName, group] of filesByTarget) {
    const namespace = swiftTargetNamespace(targetName);
    let targetTypeBindings = namespaceTypeBindings.get(namespace);

    for (const parsed of group) {
      const sourceModule = workspaceIndex.moduleScopeByFile.get(parsed.filePath);
      if (sourceModule === undefined) continue;

      for (const def of swiftTargetVisibleDefs(parsed)) {
        if (
          (def.type !== 'Function' && def.type !== 'Method') ||
          def.ownerId !== undefined
        )
          continue;
        const name = simpleName(def.qualifiedName);
        if (name === '') continue;
        const ref = sourceModule.typeBindings.get(name);
        if (ref === undefined) continue;
        if (targetTypeBindings === undefined) {
          targetTypeBindings = new Map<string, TypeRef>();
          namespaceTypeBindings.set(namespace, targetTypeBindings);
        }
        if (targetTypeBindings.has(name)) continue;
        targetTypeBindings.set(name, followChainPostFinalize(ref, sourceModule.id, indexes));
      }
    }
  }
}

function simpleName(qualifiedName: string | undefined): string {
  if (qualifiedName === undefined) return '';
  const dot = qualifiedName.lastIndexOf('.');
  return dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
}
