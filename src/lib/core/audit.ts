import { ensureDbReady } from '@/lib/db';
import { createId } from './crypto';

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /authorization/i,
  /cookie/i,
  /private[_-]?key/i,
  /credit[_-]?card/i,
];

export function redactSensitiveMetadata(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object') {
    return {};
  }
  const cleanObj: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((regex) => regex.test(key));
    if (isSensitive) {
      cleanObj[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      cleanObj[key] = value.map((item) =>
        typeof item === 'object' && item !== null ? redactSensitiveMetadata(item) : item
      );
    } else if (typeof value === 'object' && value !== null) {
      cleanObj[key] = redactSensitiveMetadata(value);
    } else {
      cleanObj[key] = value;
    }
  }
  return cleanObj;
}

export interface AuditEventInput {
  actorUserId?: string | null;
  actorRole?: string | null;
  pillar: 'school' | 'business' | 'core';
  action: string;
  targetType: string;
  targetId?: string | null;
  status: 'SUCCESS' | 'DENIED' | 'ERROR';
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

export async function recordAuditEvent(input: AuditEventInput): Promise<string> {
  const db = await ensureDbReady();
  const id = createId('aud');
  const redacted = redactSensitiveMetadata(input.metadata || {});
  await db.query(
    `INSERT INTO audit_events (
      id, actor_user_id, actor_role, pillar, action, target_type, target_id, status, redacted_metadata_json, ip_address
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
    [
      id,
      input.actorUserId ?? null,
      input.actorRole ?? null,
      input.pillar,
      input.action,
      input.targetType,
      input.targetId ?? null,
      input.status,
      JSON.stringify(redacted),
      input.ipAddress ?? '127.0.0.1',
    ]
  );
  return id;
}

export async function createNotification(params: {
  userId: string;
  category: string;
  title: string;
  message: string;
  linkPath?: string;
}): Promise<string> {
  const db = await ensureDbReady();
  const id = createId('ntf');
  await db.query(
    `INSERT INTO notifications (id, user_id, category, title, message, link_path)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, params.userId, params.category, params.title, params.message, params.linkPath ?? null]
  );
  return id;
}
