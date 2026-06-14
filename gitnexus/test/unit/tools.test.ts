/**
 * Unit Tests: MCP Tool Definitions
 *
 * Tests: GITNEXUS_TOOLS from tools.ts
 * - All tools are defined (per-repo + group_list/group_sync)
 * - Each tool has valid name, description, inputSchema
 * - Required fields are correct
 * - Optional repo parameter is present on tools that need it
 */
import { describe, it, expect } from 'vitest';
import { GITNEXUS_TOOLS } from '../../src/mcp/tools.js';

const GROUP_TOOLS = new Set(['group_list', 'group_sync']);

describe('GITNEXUS_TOOLS', () => {
  it('exports all tools (7 base + 3 route/tool/shape + 1 api_impact + 2 group + code_snippet + git_author_trace)', () => {
    expect(GITNEXUS_TOOLS).toHaveLength(15);
  });

  it('contains all expected tool names', () => {
    const names = GITNEXUS_TOOLS.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'list_repos',
        'query',
        'cypher',
        'context',
        'detect_changes',
        'rename',
        'impact',
        'api_impact',
        'code_snippet',
        'git_author_trace',
      ]),
    );
  });

  it('each tool has name, description, and inputSchema', () => {
    for (const tool of GITNEXUS_TOOLS) {
      expect(tool.name).toBeTruthy();
      expect(typeof tool.name).toBe('string');
      expect(tool.description).toBeTruthy();
      expect(typeof tool.description).toBe('string');
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.inputSchema.properties).toBeDefined();
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
    }
  });

  it('query tool accepts "query" and raw "zoekt" parameters', () => {
    const queryTool = GITNEXUS_TOOLS.find((t) => t.name === 'query')!;
    expect(queryTool.inputSchema.properties.query).toBeDefined();
    expect(queryTool.inputSchema.properties.query.type).toBe('string');
    expect(queryTool.inputSchema.properties.zoekt).toBeDefined();
    expect(queryTool.inputSchema.properties.zoekt.type).toBe('string');
  });

  it('cypher tool requires "query" parameter', () => {
    const cypherTool = GITNEXUS_TOOLS.find((t) => t.name === 'cypher')!;
    expect(cypherTool.inputSchema.required).toContain('query');
  });

  it('context tool has no required parameters', () => {
    const contextTool = GITNEXUS_TOOLS.find((t) => t.name === 'context')!;
    expect(contextTool.inputSchema.required).toEqual([]);
  });

  it('impact tool requires target and direction', () => {
    const impactTool = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    expect(impactTool.inputSchema.required).toContain('target');
    expect(impactTool.inputSchema.required).toContain('direction');
  });

  it('rename tool requires new_name', () => {
    const renameTool = GITNEXUS_TOOLS.find((t) => t.name === 'rename')!;
    expect(renameTool.inputSchema.required).toContain('new_name');
  });

  it('detect_changes tool has no required parameters', () => {
    const detectTool = GITNEXUS_TOOLS.find((t) => t.name === 'detect_changes')!;
    expect(detectTool.inputSchema.required).toEqual([]);
  });

  it('list_repos tool has no parameters', () => {
    const listTool = GITNEXUS_TOOLS.find((t) => t.name === 'list_repos')!;
    expect(Object.keys(listTool.inputSchema.properties)).toHaveLength(0);
    expect(listTool.inputSchema.required).toEqual([]);
  });

  it('per-repo tools have optional repo parameter for backend selection', () => {
    for (const tool of GITNEXUS_TOOLS) {
      if (tool.name === 'list_repos') continue;
      if (GROUP_TOOLS.has(tool.name)) continue;
      expect(tool.inputSchema.properties.repo).toBeDefined();
      expect(tool.inputSchema.properties.repo.type).toBe('string');
      expect(tool.inputSchema.required).not.toContain('repo');
    }
  });

  it('does not expose direct Zoekt MCP tools', () => {
    const names = GITNEXUS_TOOLS.map((t) => t.name);
    expect(names).not.toContain('zoekt_search');
    expect(names).not.toContain('zoekt_symbol');
  });

  it('documents Neo4j-first cross-repo query guidance', () => {
    const listReposTool = GITNEXUS_TOOLS.find((t) => t.name === 'list_repos')!;
    const queryTool = GITNEXUS_TOOLS.find((t) => t.name === 'query')!;
    expect(listReposTool.description).toContain('call query without "repo"');
    expect(listReposTool.description).toContain('Single-file LadybugDB indexes are repo-scoped');
    expect(queryTool.description).toContain('SMART DISCOVERY');
    expect(queryTool.description).toContain('omit "repo" by default for the first query');
    expect(queryTool.description).toContain('Single-file LadybugDB indexes are repo-scoped');
    expect(queryTool.description).toContain('SEARCH CHANNELS');
    expect(queryTool.description).toContain('BM25/vector are the primary discovery channels');
    expect(queryTool.description).toContain(
      'Zoekt is only an auxiliary exact-source search channel',
    );
    expect(queryTool.description).toContain('switch to context() or impact()');
    expect(queryTool.description).toContain('QUERY LANGUAGE SPLIT');
    expect(queryTool.description).toContain('uses "query" for semantic vector discovery');
    expect(queryTool.inputSchema.properties.zoekt.description).toContain('raw Zoekt DSL only');
    expect(queryTool.inputSchema.properties.repo.description).toContain(
      'In Neo4j mode, omit for the first search',
    );
  });

  it('documents graph-first workflow before source snippets', () => {
    const queryTool = GITNEXUS_TOOLS.find((t) => t.name === 'query')!;
    const contextTool = GITNEXUS_TOOLS.find((t) => t.name === 'context')!;
    const impactTool = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    const snippetTool = GITNEXUS_TOOLS.find((t) => t.name === 'code_snippet')!;

    expect(queryTool.description).toContain('GRAPH-FIRST WORKFLOW');
    expect(queryTool.description).toContain('Do not start by reading large source files');
    expect(contextTool.description).toContain('call context() before reading its file');
    expect(impactTool.description).toContain('run impact() to see the blast radius');
    expect(snippetTool.description).toContain('LOCATE -> VERIFY -> EXPAND');
    expect(snippetTool.description).toContain('roughly 10-20 relevant lines');
  });

  it('documents precise Zoekt filters on the unified query tool', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'query')!;

    expect(tool.inputSchema.properties.query.description).toContain('Plain natural-language');
    expect(tool.inputSchema.properties.query.description).toContain('Do NOT include Zoekt DSL');
    expect(tool.inputSchema.properties.query.description).toContain('Strongly recommended');
    expect(tool.inputSchema.properties.zoekt.description).toContain('Auxiliary exact-source');
    expect(tool.inputSchema.properties.zoekt.description).toContain('literal Chinese messages');
    expect(tool.inputSchema.properties.zoekt.description).toContain(
      'switch to context() or impact()',
    );
    expect(tool.inputSchema.properties.zoekt.description).toContain('raw Zoekt DSL only');
    expect(tool.inputSchema.properties.zoekt.description).toContain('Pair complex Zoekt DSL');
  });

  it('group tools without backend repo param omit repo property', () => {
    for (const name of ['group_list', 'group_sync'] as const) {
      const tool = GITNEXUS_TOOLS.find((t) => t.name === name)!;
      expect(tool.inputSchema.properties).not.toHaveProperty('repo');
    }
  });

  it('impact, query, and context expose optional service with minLength', () => {
    for (const n of ['impact', 'query', 'context'] as const) {
      const tool = GITNEXUS_TOOLS.find((t) => t.name === n)!;
      const svc = tool.inputSchema.properties.service;
      expect(svc, n).toBeDefined();
      expect(svc!.minLength).toBe(1);
    }
  });

  it('impact schema bounds match cross-impact validation ranges', () => {
    const impact = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    expect(impact.inputSchema.properties.maxDepth.minimum).toBe(1);
    expect(impact.inputSchema.properties.maxDepth.maximum).toBe(32);
    expect(impact.inputSchema.properties.minConfidence.minimum).toBe(0);
    expect(impact.inputSchema.properties.minConfidence.maximum).toBe(1);
    expect(impact.inputSchema.properties.timeoutMs.maximum).toBe(3600000);
  });

  it('detect_changes scope has correct enum values', () => {
    const detectTool = GITNEXUS_TOOLS.find((t) => t.name === 'detect_changes')!;
    const scopeProp = detectTool.inputSchema.properties.scope;
    expect(scopeProp.enum).toEqual(['unstaged', 'staged', 'all', 'compare']);
  });

  it('api_impact tool has no required parameters', () => {
    const apiImpactTool = GITNEXUS_TOOLS.find((t) => t.name === 'api_impact')!;
    expect(apiImpactTool).toBeDefined();
    expect(apiImpactTool.inputSchema.required).toEqual([]);
    expect(apiImpactTool.inputSchema.properties.route).toBeDefined();
    expect(apiImpactTool.inputSchema.properties.file).toBeDefined();
    expect(apiImpactTool.inputSchema.properties.repo).toBeDefined();
  });

  it('code_snippet requires filePath and line range', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'code_snippet')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['filePath', 'startLine', 'endLine']);
    expect(tool.inputSchema.properties.repo).toBeDefined();
    expect(tool.inputSchema.properties.filePath.type).toBe('string');
    expect(tool.inputSchema.properties.startLine.minimum).toBe(1);
    expect(tool.inputSchema.properties.endLine.minimum).toBe(1);
  });

  it('git_author_trace requires filePath and line range', () => {
    const tool = GITNEXUS_TOOLS.find((t) => t.name === 'git_author_trace')!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(['filePath', 'startLine', 'endLine']);
    expect(tool.inputSchema.properties.repo).toBeDefined();
    expect(tool.inputSchema.properties.filePath.type).toBe('string');
    expect(tool.inputSchema.properties.startLine.minimum).toBe(1);
    expect(tool.inputSchema.properties.endLine.minimum).toBe(1);
    expect(tool.inputSchema.properties.includeHistory.type).toBe('boolean');
    expect(tool.inputSchema.properties.maxCommits.minimum).toBe(1);
  });

  it('impact relationTypes is array of strings', () => {
    const impactTool = GITNEXUS_TOOLS.find((t) => t.name === 'impact')!;
    const relProp = impactTool.inputSchema.properties.relationTypes;
    expect(relProp.type).toBe('array');
    expect(relProp.items).toEqual({ type: 'string' });
  });

  it('route_map description defers to api_impact for pre-change analysis', () => {
    const routeMapTool = GITNEXUS_TOOLS.find((t) => t.name === 'route_map')!;
    expect(routeMapTool.description).toContain('api_impact');
    expect(routeMapTool.description).toContain('pre-change analysis');
  });

  it('shape_check description defers to api_impact for pre-change analysis', () => {
    const shapeCheckTool = GITNEXUS_TOOLS.find((t) => t.name === 'shape_check')!;
    expect(shapeCheckTool.description).toContain('api_impact');
    expect(shapeCheckTool.description).toContain('pre-change analysis');
  });
});
