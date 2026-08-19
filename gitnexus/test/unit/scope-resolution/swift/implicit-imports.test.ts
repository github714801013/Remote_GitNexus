import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { _captureLogger, type LoggerCapture } from '../../../../src/core/logger.js';
import { generateId } from '../../../../src/lib/utils.js';
import {
  DEFAULT_SWIFT_IMPLICIT_IMPORT_EDGE_CAP,
  emitSwiftImplicitImportEdges,
  swiftImplicitImportEdgeCap,
} from '../../../../src/core/ingestion/languages/swift/implicit-imports.js';

const parsed = (filePath: string): ParsedFile => ({ filePath } as ParsedFile);

const emit = (files: readonly ParsedFile[], targets: ReadonlyMap<string, string> | null = null) => {
  const graph = createKnowledgeGraph();
  emitSwiftImplicitImportEdges(graph, files, {} as never, targets === null ? undefined : { targets });
  return graph;
};

const filesForExactEdgeCount = (edgeCount: number, root = 'Sources/App'): ParsedFile[] => {
  const fileCount = (1 + Math.sqrt(1 + 4 * edgeCount)) / 2;
  if (!Number.isInteger(fileCount)) {
    throw new Error(`Edge count ${edgeCount} cannot be represented by a complete directed graph.`);
  }
  return Array.from({ length: fileCount }, (_, index) => parsed(`${root}/File${index}.swift`));
};

describe('emitSwiftImplicitImportEdges', () => {
  let logs: LoggerCapture;

  beforeEach(() => {
    logs = _captureLogger();
  });

  afterEach(() => {
    logs.restore();
    delete process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP;
  });

  it.each([undefined, '', '   ', 'invalid', '-1', '1.5'])(
    'uses the default cap for an invalid environment value %#',
    (value) => {
      if (value === undefined) {
        delete process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP;
      } else {
        process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP = value;
      }

      expect(swiftImplicitImportEdgeCap()).toBe(DEFAULT_SWIFT_IMPLICIT_IMPORT_EDGE_CAP);
    },
  );

  it('accepts zero as an explicit cap that disables implicit import edges', () => {
    process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP = '0';

    expect(swiftImplicitImportEdgeCap()).toBe(0);
  });

  it('emits every ordered pair within a small same-target group', () => {
    const files = [
      parsed('Sources/App/Core/A.swift'),
      parsed('Sources/App/Feature/B.swift'),
      parsed('Sources/App/C.swift'),
    ];

    const graph = emit(files, new Map([['App', 'Sources/App']]));

    expect(graph.relationships).toHaveLength(6);
    expect(
      graph.relationships.map((relationship) => [relationship.sourceId, relationship.targetId]),
    ).toEqual(
      expect.arrayContaining([
        [
          generateId('File', 'Sources/App/Core/A.swift'),
          generateId('File', 'Sources/App/Feature/B.swift'),
        ],
        [
          generateId('File', 'Sources/App/Feature/B.swift'),
          generateId('File', 'Sources/App/Core/A.swift'),
        ],
      ]),
    );
    expect(graph.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'IMPORTS',
          confidence: 1,
          reason: 'swift-scope: implicit module visibility',
        }),
      ]),
    );
    expect(graph.relationships.every((relationship) => relationship.sourceId !== relationship.targetId)).toBe(
      true,
    );
  });

  it('keeps a group at the configured cap complete', () => {
    process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP = '6';

    const graph = emit(filesForExactEdgeCount(6));

    expect(graph.relationships).toHaveLength(6);
    expect(logs.records()).toHaveLength(0);
  });

  it('skips an over-cap target without emitting a partial visibility graph', () => {
    process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP = '6';

    const graph = emit(
      [...filesForExactEdgeCount(6), parsed('Sources/App/Extra.swift')],
      new Map([['App', 'Sources/App']]),
    );

    expect(graph.relationships).toHaveLength(0);
    expect(logs.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 40,
          msg: 'Swift implicit import edges skipped because the target exceeds the edge cap',
          targetName: 'App',
          fileCount: 4,
          expectedEdgeCount: 12,
          edgeCap: 6,
        }),
      ]),
    );
  });

  it('does not let an over-cap target suppress a separate small target', () => {
    process.env.GITNEXUS_SWIFT_IMPLICIT_IMPORT_EDGE_CAP = '6';
    const huge = [...filesForExactEdgeCount(6, 'Sources/Huge'), parsed('Sources/Huge/Extra.swift')];
    const small = [parsed('Sources/Small/A.swift'), parsed('Sources/Small/B.swift')];

    const graph = emit(
      [...huge, ...small],
      new Map([
        ['Huge', 'Sources/Huge'],
        ['Small', 'Sources/Small'],
      ]),
    );

    expect(graph.relationships).toHaveLength(2);
    expect(graph.relationships.every((relationship) => relationship.reason === 'swift-scope: implicit module visibility')).toBe(
      true,
    );
  });

  it('protects the no-SPM __default__ group at the OA file count', () => {
    const files = Array.from({ length: 1647 }, (_, index) => parsed(`OA/File${index}.swift`));

    const graph = emit(files);

    expect(graph.relationships).toHaveLength(0);
    expect(logs.records()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetName: '__default__',
          fileCount: 1647,
          expectedEdgeCount: 2_710_962,
          edgeCap: DEFAULT_SWIFT_IMPLICIT_IMPORT_EDGE_CAP,
        }),
      ]),
    );
  });
});
