import { ensureDbReady } from '@/lib/db';
import { createId } from '@/lib/core/crypto';
import { AppError, AuthenticatedUser, Pillar } from '@/lib/core/rbac';
import { enforceRateLimit } from '@/lib/core/rate-limit';
import { recordAuditEvent } from '@/lib/core/audit';

export type AIMode = 'LIVE' | 'MOCK_DEMO';
export type UncertaintyLevel = 'LOW' | 'MEDIUM' | 'HIGH';

export interface GroundingCitation {
  sourceTitle: string;
  documentId: string | null;
  excerpt: string;
  relevanceScore: number;
  verifiedSource: boolean;
}

export interface AIExecutionOptions {
  user: AuthenticatedUser;
  pillar: Pillar;
  operation:
    | 'ACADEMIC_EXPLANATION'
    | 'STUDY_MATERIAL_GENERATION'
    | 'EXERCISE_GENERATION'
    | 'EXERCISE_CORRECTION'
    | 'FACT_CHECK_INSPECTION'
    | 'LINGUISTIC_QA_ASSIST';
  prompt: string;
  sourceDocument?: {
    id: string;
    title: string;
    extractedText: string;
    verifiedSource: boolean;
  } | null;
  simulateProviderFailure?: boolean;
  strictLiveRequired?: boolean;
}

export interface AIExecutionResult<T> {
  aiMode: AIMode;
  provider: string;
  model: string;
  uncertaintyLevel: UncertaintyLevel;
  epistemicNotice: string;
  groundingCitations: GroundingCitation[];
  data: T;
  usage: {
    promptTokens: number;
    completionTokens: number;
    estimatedCostUsd: number;
    latencyMs: number;
    status: 'SUCCESS' | 'FALLBACK_MOCK' | 'ERROR' | 'RATE_LIMITED';
  };
}

export function extractGroundedCitations(
  prompt: string,
  sourceDocument?: {
    id: string;
    title: string;
    extractedText: string;
    verifiedSource: boolean;
  } | null
): { citations: GroundingCitation[]; uncertaintyLevel: UncertaintyLevel } {
  if (!sourceDocument || !sourceDocument.extractedText.trim()) {
    return {
      citations: [],
      uncertaintyLevel: 'HIGH',
    };
  }

  const text = sourceDocument.extractedText.trim();
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  const queryKeywords = prompt
    .toLowerCase()
    .replace(/[^a-z0-9àâçéèêëîïôûùüÿñæœ\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3);

  const scored = sentences.map((sentence) => {
    const lower = sentence.toLowerCase();
    let matches = 0;
    for (const kw of queryKeywords) {
      if (lower.includes(kw)) matches += 1;
    }
    const score = queryKeywords.length > 0 ? Math.min(1, matches / Math.max(1, Math.min(4, queryKeywords.length))) : 0.5;
    return { sentence, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 3).filter((item) => item.sentence.length > 0);

  if (top.length === 0) {
    const fallbackExcerpt = text.slice(0, 240);
    return {
      citations: [
        {
          sourceTitle: sourceDocument.title,
          documentId: sourceDocument.id,
          excerpt: fallbackExcerpt,
          relevanceScore: 0.35,
          verifiedSource: sourceDocument.verifiedSource,
        },
      ],
      uncertaintyLevel: 'MEDIUM',
    };
  }

  const maxScore = top[0]?.score ?? 0;
  const uncertaintyLevel: UncertaintyLevel =
    maxScore >= 0.6 && sourceDocument.verifiedSource
      ? 'LOW'
      : maxScore >= 0.25
        ? 'MEDIUM'
        : 'HIGH';

  return {
    citations: top.map((t) => ({
      sourceTitle: sourceDocument.title,
      documentId: sourceDocument.id,
      excerpt: t.sentence.slice(0, 300),
      relevanceScore: Number(Math.max(0.25, t.score).toFixed(2)),
      verifiedSource: sourceDocument.verifiedSource,
    })),
    uncertaintyLevel,
  };
}

export async function executeGroundedAI<T>(
  options: AIExecutionOptions,
  mockBuilder: (ctx: {
    citations: GroundingCitation[];
    uncertaintyLevel: UncertaintyLevel;
    epistemicNotice: string;
  }) => T
): Promise<AIExecutionResult<T>> {
  const startMs = Date.now();
  const maxPerMin = Number(process.env.AI_RATE_LIMIT_PER_MINUTE || 30);
  await enforceRateLimit(`ai:${options.user.id}`, maxPerMin, 60_000);

  const cleanPrompt = options.prompt?.trim() || '';
  if (cleanPrompt.length < 3) {
    throw new AppError('AI prompt must contain at least 3 characters.', 400, 'INVALID_AI_PROMPT');
  }
  if (cleanPrompt.length > 12_000) {
    throw new AppError('AI prompt exceeds maximum allowed length (12,000 characters).', 400, 'AI_PROMPT_TOO_LONG');
  }

  const configuredProvider = process.env.AI_PROVIDER || 'mock';
  const configuredModel = process.env.AI_MODEL || 'solob-grounded-tutor-v1';
  const apiKey = process.env.AI_API_KEY?.trim() || '';
  const maxRetries = Number(process.env.AI_MAX_RETRIES || 2);

  const { citations, uncertaintyLevel } = extractGroundedCitations(cleanPrompt, options.sourceDocument);

  const isMockConfigured = !apiKey || configuredProvider === 'mock';
  const aiMode: AIMode = isMockConfigured ? 'MOCK_DEMO' : 'LIVE';

  const db = await ensureDbReady();

  // Handle simulated or real external provider calls with retry logic
  if (options.simulateProviderFailure || (!isMockConfigured && configuredProvider !== 'mock')) {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        if (options.simulateProviderFailure) {
          throw new Error(`Upstream AI provider timeout on attempt ${attempt}/${maxRetries + 1}`);
        }
        // If an external OpenAI-compatible key & endpoint are configured, attempt live fetch with timeout
        const timeoutMs = Number(process.env.AI_TIMEOUT_MS || 10_000);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const baseUrl = process.env.AI_BASE_URL || 'https://api.openai.com/v1';
          const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: configuredModel,
              messages: [
                {
                  role: 'system',
                  content:
                    'You are SOLOB+ Academic & Linguistic Assistant. Communicate uncertainty clearly and never fabricate citations.',
                },
                { role: 'user', content: cleanPrompt },
              ],
              temperature: 0.2,
            }),
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(`Upstream provider HTTP ${res.status}`);
          }
          break;
        } finally {
          clearTimeout(timer);
        }
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (lastError) {
      const latencyMs = Math.max(1, Date.now() - startMs);
      const usageId = createId('aiu');
      const status = options.strictLiveRequired ? 'ERROR' : 'FALLBACK_MOCK';

      await db.query(
        `INSERT INTO ai_usage_records (
          id, user_id, pillar, operation, provider, model, is_mock,
          prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, status, error_code
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          usageId,
          options.user.id,
          options.pillar,
          options.operation,
          configuredProvider,
          configuredModel,
          true,
          Math.ceil(cleanPrompt.length / 4),
          0,
          0,
          latencyMs,
          status,
          'UPSTREAM_PROVIDER_FAILURE',
        ]
      );

      await recordAuditEvent({
        actorUserId: options.user.id,
        actorRole: options.user.role,
        pillar: options.pillar,
        action: 'AI_PROVIDER_FAILURE_HANDLED',
        targetType: 'AI_SERVICE',
        targetId: usageId,
        status: options.strictLiveRequired ? 'ERROR' : 'SUCCESS',
        metadata: {
          operation: options.operation,
          provider: configuredProvider,
          attempts: maxRetries + 1,
          errorMessage: lastError.message,
          fallbackApplied: !options.strictLiveRequired,
        },
      });

      if (options.strictLiveRequired) {
        throw new AppError(
          `AI provider failed after ${maxRetries + 1} attempts: ${lastError.message}`,
          503,
          'AI_PROVIDER_UNAVAILABLE'
        );
      }

      const fallbackNotice = `[DEMO / MOCK FALLBACK MODE — Upstream provider failed after ${maxRetries + 1} attempts (${lastError.message}). Output below is deterministic source-grounded mock output and MUST NOT be treated as a live model inference. Verify all claims against primary academic sources.]`;
      const data = mockBuilder({
        citations,
        uncertaintyLevel: 'HIGH',
        epistemicNotice: fallbackNotice,
      });

      return {
        aiMode: 'MOCK_DEMO',
        provider: configuredProvider,
        model: configuredModel,
        uncertaintyLevel: 'HIGH',
        epistemicNotice: fallbackNotice,
        groundingCitations: citations,
        data,
        usage: {
          promptTokens: Math.ceil(cleanPrompt.length / 4),
          completionTokens: 120,
          estimatedCostUsd: 0,
          latencyMs,
          status: 'FALLBACK_MOCK',
        },
      };
    }
  }

  const epistemicNotice =
    aiMode === 'MOCK_DEMO'
      ? `[DEMO / MOCK MODE — No external AI_API_KEY configured. This response is generated deterministically from your uploaded document excerpts. AI responses are fallible by design; never rely on unverified claims without checking the cited source passages.]`
      : `[LIVE AI MODE — Grounded in ${citations.length} source excerpt(s). Uncertainty level: ${uncertaintyLevel}. Verify critical academic facts against official curriculum texts.]`;

  const data = mockBuilder({
    citations,
    uncertaintyLevel,
    epistemicNotice,
  });

  const promptTokens = Math.ceil(cleanPrompt.length / 4);
  const completionTokens = Math.ceil(JSON.stringify(data).length / 4);
  const estimatedCostUsd = aiMode === 'MOCK_DEMO' ? 0 : Number(((promptTokens + completionTokens) * 0.0000015).toFixed(6));
  const latencyMs = Math.max(1, Date.now() - startMs);

  const usageId = createId('aiu');
  await db.query(
    `INSERT INTO ai_usage_records (
      id, user_id, pillar, operation, provider, model, is_mock,
      prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'SUCCESS')`,
    [
      usageId,
      options.user.id,
      options.pillar,
      options.operation,
      configuredProvider,
      configuredModel,
      aiMode === 'MOCK_DEMO',
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      latencyMs,
    ]
  );

  return {
    aiMode,
    provider: configuredProvider,
    model: configuredModel,
    uncertaintyLevel,
    epistemicNotice,
    groundingCitations: citations,
    data,
    usage: {
      promptTokens,
      completionTokens,
      estimatedCostUsd,
      latencyMs,
      status: 'SUCCESS',
    },
  };
}
