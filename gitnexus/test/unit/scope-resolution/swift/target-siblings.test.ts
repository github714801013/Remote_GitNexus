import { describe, expect, it } from 'vitest';
import type { ParsedFile, Scope, ScopeId, SymbolDefinition } from 'gitnexus-shared';
import {
  populateSwiftTargetSiblings,
  swiftTargetNamespace,
  swiftTargetVisibleDefs,
} from '../../../../src/core/ingestion/languages/swift/target-siblings.js';

const range = { startLine: 1, startCol: 0, endLine: 99, endCol: 0 };

const def = (nodeId: string, type: SymbolDefinition['type'], qualifiedName: string, ownerId?: string) => ({
  nodeId,
  type,
  qualifiedName,
  filePath: 'Sources/App/Models.swift',
  ...(ownerId === undefined ? {} : { ownerId }),
});

const scope = (
  id: ScopeId,
  kind: Scope['kind'],
  parent: ScopeId | null,
  ownedDefs: readonly SymbolDefinition[],
): Scope => ({
  id,
  kind,
  parent,
  filePath: 'Sources/App/Models.swift',
  range,
  bindings: new Map(),
  imports: [],
  typeBindings: new Map(),
  ownedDefs,
});

const parsed = (
  filePath: string,
  moduleScope: ScopeId,
  scopes: readonly Scope[],
): ParsedFile => ({
  filePath,
  moduleScope,
  scopes,
  localDefs: scopes.flatMap((entry) => entry.ownedDefs),
  parsedImports: [],
  referenceSites: [],
});

describe('Swift target shared visibility', () => {
  it('publishes only structural top-level types and free functions', () => {
    const user = def('def:User', 'Struct', 'User');
    const getUser = def('def:getUser', 'Function', 'getUser');
    const apiVersion = def('def:apiVersion', 'Property', 'apiVersion');
    const save = def('def:User.save', 'Method', 'User.save', user.nodeId);
    const nested = def('def:inner', 'Function', 'inner');
    const module = scope('scope:models', 'Module', null, [user, apiVersion]);
    const topFunction = scope('scope:getUser', 'Function', module.id, [getUser]);
    const classScope = scope('scope:User', 'Class', module.id, [save]);
    const nestedFunction = scope('scope:inner', 'Function', topFunction.id, [nested]);
    const file = parsed('Sources/App/Models.swift', module.id, [module, topFunction, classScope, nestedFunction]);

    expect(swiftTargetVisibleDefs(file).map((entry) => entry.nodeId)).toEqual([
      user.nodeId,
      apiVersion.nodeId,
      getUser.nodeId,
    ]);
  });

  it('stores one target-level binding surface and gates it to matching target modules', () => {
    const user = def('def:User', 'Struct', 'User');
    const moduleA = scope('scope:a', 'Module', null, [user]);
    const moduleB = scope('scope:b', 'Module', null, []);
    const foreignModule = scope('scope:foreign', 'Module', null, []);
    const indexes = {
      moduleScopes: {
        byFilePath: new Map([
          ['Sources/App/Models.swift', moduleA.id],
          ['Sources/App/App.swift', moduleB.id],
          ['Sources/Other/Other.swift', foreignModule.id],
        ]),
      },
      namespaceFqnBindings: new Map(),
      accessibleNamespacesByScope: new Map(),
    };
    const files = [
      parsed('Sources/App/Models.swift', moduleA.id, [moduleA]),
      parsed('Sources/App/App.swift', moduleB.id, [moduleB]),
      parsed('Sources/Other/Other.swift', foreignModule.id, [foreignModule]),
    ];

    populateSwiftTargetSiblings(files, indexes as never, {
      fileContents: new Map(),
      resolutionConfig: {
        hasPackageManifest: true,
        targets: new Map([
          ['App', 'Sources/App'],
          ['Other', 'Sources/Other'],
        ]),
      },
    });

    const namespace = swiftTargetNamespace('App');
    expect(indexes.namespaceFqnBindings.get(namespace)?.get('User')?.map((entry) => entry.def)).toEqual([
      user,
    ]);
    expect(indexes.accessibleNamespacesByScope.get(moduleA.id)).toEqual([namespace]);
    expect(indexes.accessibleNamespacesByScope.get(moduleB.id)).toEqual([namespace]);
    expect(indexes.accessibleNamespacesByScope.get(foreignModule.id)).toEqual([
      swiftTargetNamespace('Other'),
    ]);
  });
});
