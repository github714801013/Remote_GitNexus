import type { EmbeddableNode } from './types.js';
import { isShortLabel } from './types.js';

const SUMMARY_PROMPT_VERSION = 'zh-business-keywords-v2';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CHARS = 6_000;
const DEFAULT_MODEL = 'qwen2.5-coder-14b-keyword-summary';
const DEFAULT_LANGUAGE = '中文';
// Minimum code-body length (after trim) below which keyword summary is skipped.
// Nodes whose code body is empty or trivially short carry no signal for keyword
// extraction (the LLM would only see the symbol name + file path). Skipping them
// avoids spending ~4.7s of GPU time per node on worthless summaries — this is the
// dominant cost driver when ingestion has not populated `content` yet.
// Tuned so that trivial getters/setters/one-liners are excluded while real
// function bodies (even short ones) still get summarized.
const MIN_SUMMARY_CONTENT_CHARS = 50;

const readPositiveInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const envFlagEnabled = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
};

const stripJsonFence = (text: string): string => {
  const trimmed = text.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
};

const pickStringArray = (value: unknown, maxItems: number): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, maxItems)
    : [];

export const isKeywordSummaryEnabled = (): boolean =>
  envFlagEnabled(process.env.GITNEXUS_KEYWORD_SUMMARY_ENABLED);

export const getKeywordSummaryLanguage = (): string =>
  (process.env.GITNEXUS_KEYWORD_SUMMARY_LANGUAGE || DEFAULT_LANGUAGE).trim() || DEFAULT_LANGUAGE;

export const getKeywordSummaryHashSalt = (): string =>
  isKeywordSummaryEnabled()
    ? `keyword-summary:${SUMMARY_PROMPT_VERSION}:${getKeywordSummaryLanguage()}`
    : 'keyword-summary:off';

export const shouldSummarizeNode = (node: EmbeddableNode): boolean =>
  isKeywordSummaryEnabled() &&
  !isShortLabel(node.label) &&
  ['Function', 'Method', 'Constructor', 'Class', 'Interface', 'Struct'].includes(node.label) &&
  // Nodes whose code body is empty or trivially short carry no signal for keyword
  // extraction (the LLM would only see the symbol name + file path). Skipping them
  // avoids spending ~4.7s of GPU time per node on worthless summaries — this is the
  // dominant cost driver when ingestion has not populated `content` yet.
  typeof node.content === 'string' &&
  node.content.trim().length >= MIN_SUMMARY_CONTENT_CHARS;

type SummaryPayload = {
  businessKeywords?: unknown;
  technicalKeywords?: unknown;
  intent?: unknown;
  aliases?: unknown;
};

const formatSummary = (payload: SummaryPayload, language: string): string | undefined => {
  const businessKeywords = pickStringArray(payload.businessKeywords, 8);
  const technicalKeywords = pickStringArray(payload.technicalKeywords, 8);
  const aliases = pickStringArray(payload.aliases, 6);
  const intent = typeof payload.intent === 'string' ? payload.intent.trim() : '';

  if (!businessKeywords.length && !technicalKeywords.length && !aliases.length && !intent) {
    return undefined;
  }

  return [
    `[${language}业务摘要]`,
    businessKeywords.length ? `业务词: ${businessKeywords.join(', ')}` : undefined,
    technicalKeywords.length ? `技术词: ${technicalKeywords.join(', ')}` : undefined,
    intent ? `意图: ${intent}` : undefined,
    aliases.length ? `别名: ${aliases.join(', ')}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
};

const summaryCache = new Map<string, string | undefined>();

export const clearKeywordSummaryCacheForTests = (): void => {
  summaryCache.clear();
};

export const buildKeywordSummaryPrefix = async (
  node: EmbeddableNode,
  embeddingText: string,
  contentHash: string,
): Promise<string | undefined> => {
  if (!shouldSummarizeNode(node)) return undefined;

  const baseUrl = process.env.GITNEXUS_KEYWORD_SUMMARY_URL?.replace(/\/+$/, '');
  if (!baseUrl) return undefined;
  const language = getKeywordSummaryLanguage();

  const cacheKey = `${node.id}:${contentHash}:${SUMMARY_PROMPT_VERSION}:${language}`;
  if (summaryCache.has(cacheKey)) return summaryCache.get(cacheKey);

  const maxChars = readPositiveInt(
    process.env.GITNEXUS_KEYWORD_SUMMARY_MAX_CHARS,
    DEFAULT_MAX_CHARS,
  );
  const timeoutMs = readPositiveInt(
    process.env.GITNEXUS_KEYWORD_SUMMARY_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const model = process.env.GITNEXUS_KEYWORD_SUMMARY_MODEL || DEFAULT_MODEL;

  try {
    const resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.GITNEXUS_KEYWORD_SUMMARY_API_KEY ?? 'unused'}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 160,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是代码检索关键词提取器。只输出紧凑 JSON，不要 Markdown。' +
              `摘要输出语言: ${language}。` +
              'businessKeywords 必须优先使用摘要输出语言里的业务词；英文技术词只作为 technicalKeywords 补充。' +
              '只基于输入代码、注释、SQL、路径和类型输出；证据不足时不要猜测不存在的业务。' +
              '重点提取 Javadoc/中文注释、HTTP 路由、外部 URL、SQL/Mapper、字段注释、调用目标、返回语义和异常/边界条件。' +
              '如果输入包含 Mapper XML 或 SQL，必须把关键表名、JOIN、WHERE/ON 过滤条件、GROUP BY、TOP/LIMIT、状态字段写入 businessKeywords 或 intent。' +
              '如果只有接口签名、抽象方法、getter/setter 或字段声明，intent 必须标明这是“签名级/声明级”摘要，并保持保守。' +
              '不要把返回类型名、参数名或方法名直接扩写成业务结论；只有源码、注释或 SQL 证明时才提升为业务语义。' +
              'intent 用一句话描述该符号的可证业务目的，优先包含关键过滤条件，不要只复述函数名。' +
              '字段: businessKeywords, technicalKeywords, intent, aliases。',
          },
          {
            role: 'user',
            content:
              `节点: ${node.label} ${node.name}\n路径: ${node.filePath}\n` +
              `行号: ${node.startLine ?? '?'}-${node.endLine ?? '?'}\n` +
              (node.description ? `已有描述/注释: ${node.description}\n` : '') +
              (node.returnType ? `返回类型: ${node.returnType}\n` : '') +
              (node.parameterCount !== undefined ? `参数数量: ${node.parameterCount}\n` : '') +
              (node.methodNames?.length ? `类方法: ${node.methodNames.join(', ')}\n` : '') +
              (node.fieldNames?.length ? `字段: ${node.fieldNames.join(', ')}\n` : '') +
              `代码与上下文:\n${embeddingText.slice(0, maxChars)}`,
          },
        ],
      }),
    });

    if (!resp.ok) return undefined;

    const data = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return undefined;

    const parsed = JSON.parse(stripJsonFence(content)) as SummaryPayload;
    const formatted = formatSummary(parsed, language);
    summaryCache.set(cacheKey, formatted);
    return formatted;
  } catch {
    return undefined;
  }
};
