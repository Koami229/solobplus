import fs from 'fs';
import path from 'path';
import { ensureDbReady } from '@/lib/db';
import { createId, sha256Hex } from './crypto';
import { AppError, AuthenticatedUser, Pillar } from './rbac';
import { recordAuditEvent } from './audit';

export const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/pdf',
  'application/json',
  'audio/wav',
  'audio/mpeg',
]);

export const FORBIDDEN_EXTENSIONS = ['.exe', '.sh', '.bat', '.cmd', '.js', '.php', '.py', '.dll', '.so'];

export interface StoredFileRecord {
  id: string;
  ownerUserId: string;
  pillar: Pillar;
  originalName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256Checksum: string;
  visibility: 'private' | 'assigned_task' | 'curriculum_resource';
  projectId: string | null;
  taskId: string | null;
  createdAt: string;
}

export interface StorageProvider {
  putObject(storageKey: string, content: Buffer): Promise<void>;
  getObject(storageKey: string): Promise<Buffer>;
  deleteObject(storageKey: string): Promise<void>;
}

class LocalPrivateStorageProvider implements StorageProvider {
  private getBaseDir(): string {
    const dir = process.env.LOCAL_STORAGE_DIR || './data/storage';
    const resolved = path.resolve(process.cwd(), dir);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  private resolveSafePath(storageKey: string): string {
    const baseDir = this.getBaseDir();
    const sanitizedKey = storageKey.replace(/[^a-zA-Z0-9._-]/g, '_');
    const target = path.resolve(baseDir, sanitizedKey);
    if (!target.startsWith(baseDir)) {
      throw new AppError('Invalid storage key path traversal attempt.', 400, 'INVALID_STORAGE_KEY');
    }
    return target;
  }

  async putObject(storageKey: string, content: Buffer): Promise<void> {
    const filePath = this.resolveSafePath(storageKey);
    await fs.promises.writeFile(filePath, content, { mode: 0o600 });
  }

  async getObject(storageKey: string): Promise<Buffer> {
    const filePath = this.resolveSafePath(storageKey);
    if (!fs.existsSync(filePath)) {
      throw new AppError('Stored file object not found on storage provider.', 404, 'FILE_OBJECT_MISSING');
    }
    return fs.promises.readFile(filePath);
  }

  async deleteObject(storageKey: string): Promise<void> {
    const filePath = this.resolveSafePath(storageKey);
    if (fs.existsSync(filePath)) {
      await fs.promises.unlink(filePath);
    }
  }
}

const storageProvider: StorageProvider = new LocalPrivateStorageProvider();

export interface UploadFileInput {
  user: AuthenticatedUser;
  pillar: Pillar;
  originalName: string;
  mimeType: string;
  content: Buffer | string;
  visibility?: 'private' | 'assigned_task' | 'curriculum_resource';
  projectId?: string | null;
  taskId?: string | null;
}

export async function uploadAndStoreFile(input: UploadFileInput): Promise<StoredFileRecord> {
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024); // 10 MB default
  const buffer = typeof input.content === 'string' ? Buffer.from(input.content, 'utf8') : input.content;

  if (!input.originalName || input.originalName.trim().length === 0) {
    throw new AppError('File name is required.', 400, 'INVALID_FILE_NAME');
  }

  const ext = path.extname(input.originalName).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.includes(ext)) {
    await recordAuditEvent({
      actorUserId: input.user.id,
      actorRole: input.user.role,
      pillar: input.pillar,
      action: 'FILE_UPLOAD_REJECTED_EXTENSION',
      targetType: 'FILE',
      status: 'DENIED',
      metadata: { originalName: input.originalName, mimeType: input.mimeType, ext },
    });
    throw new AppError(`File extension '${ext}' is forbidden for security reasons.`, 400, 'FORBIDDEN_FILE_TYPE');
  }

  if (!ALLOWED_MIME_TYPES.has(input.mimeType)) {
    await recordAuditEvent({
      actorUserId: input.user.id,
      actorRole: input.user.role,
      pillar: input.pillar,
      action: 'FILE_UPLOAD_REJECTED_MIME',
      targetType: 'FILE',
      status: 'DENIED',
      metadata: { originalName: input.originalName, mimeType: input.mimeType },
    });
    throw new AppError(
      `Unsupported MIME type '${input.mimeType}'. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`,
      400,
      'INVALID_MIME_TYPE'
    );
  }

  if (buffer.byteLength === 0) {
    throw new AppError('Uploaded file cannot be empty.', 400, 'EMPTY_FILE');
  }

  if (buffer.byteLength > maxBytes) {
    await recordAuditEvent({
      actorUserId: input.user.id,
      actorRole: input.user.role,
      pillar: input.pillar,
      action: 'FILE_UPLOAD_REJECTED_SIZE',
      targetType: 'FILE',
      status: 'DENIED',
      metadata: { originalName: input.originalName, sizeBytes: buffer.byteLength, maxBytes },
    });
    throw new AppError(
      `File size (${buffer.byteLength} bytes) exceeds maximum allowed limit (${maxBytes} bytes).`,
      413,
      'FILE_TOO_LARGE'
    );
  }

  const fileId = createId('fil');
  const checksum = sha256Hex(buffer);
  const safeName = input.originalName.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  const storageKey = `${fileId}_${safeName}`;

  await storageProvider.putObject(storageKey, buffer);

  const db = await ensureDbReady();
  const visibility = input.visibility || 'private';

  await db.query(
    `INSERT INTO stored_files (
      id, owner_user_id, pillar, original_name, storage_key, mime_type, size_bytes,
      sha256_checksum, visibility, project_id, task_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      fileId,
      input.user.id,
      input.pillar,
      input.originalName,
      storageKey,
      input.mimeType,
      buffer.byteLength,
      checksum,
      visibility,
      input.projectId ?? null,
      input.taskId ?? null,
    ]
  );

  await recordAuditEvent({
    actorUserId: input.user.id,
    actorRole: input.user.role,
    pillar: input.pillar,
    action: 'FILE_UPLOADED',
    targetType: 'FILE',
    targetId: fileId,
    status: 'SUCCESS',
    metadata: {
      originalName: input.originalName,
      mimeType: input.mimeType,
      sizeBytes: buffer.byteLength,
      visibility,
    },
  });

  return {
    id: fileId,
    ownerUserId: input.user.id,
    pillar: input.pillar,
    originalName: input.originalName,
    storageKey,
    mimeType: input.mimeType,
    sizeBytes: buffer.byteLength,
    sha256Checksum: checksum,
    visibility,
    projectId: input.projectId ?? null,
    taskId: input.taskId ?? null,
    createdAt: new Date().toISOString(),
  };
}

export async function readAuthorizedFile(
  user: AuthenticatedUser,
  fileId: string
): Promise<{ metadata: StoredFileRecord; content: Buffer }> {
  const db = await ensureDbReady();
  const res = await db.query<{
    id: string;
    owner_user_id: string;
    pillar: Pillar;
    original_name: string;
    storage_key: string;
    mime_type: string;
    size_bytes: number;
    sha256_checksum: string;
    visibility: 'private' | 'assigned_task' | 'curriculum_resource';
    project_id: string | null;
    task_id: string | null;
    created_at: string;
  }>(`SELECT * FROM stored_files WHERE id = $1`, [fileId]);

  if (res.rows.length === 0) {
    throw new AppError('File not found.', 404, 'FILE_NOT_FOUND');
  }

  const row = res.rows[0];
  let isAuthorized = false;

  if (user.role === 'admin') {
    isAuthorized = true;
  } else if (row.owner_user_id === user.id) {
    isAuthorized = true;
  } else if (row.pillar === 'school') {
    if (
      row.visibility === 'curriculum_resource' &&
      (user.role === 'student' || user.role === 'teacher')
    ) {
      isAuthorized = true;
    }
  } else if (row.pillar === 'business') {
    if (user.role === 'operator') {
      isAuthorized = true;
    } else if (row.task_id) {
      const taskRes = await db.query<{
        assigned_contributor_id: string | null;
        assigned_reviewer_id: string | null;
        project_id: string;
      }>(`SELECT assigned_contributor_id, assigned_reviewer_id, project_id FROM business_tasks WHERE id = $1`, [
        row.task_id,
      ]);
      if (taskRes.rows.length > 0) {
        const t = taskRes.rows[0];
        if (t.assigned_contributor_id === user.id || t.assigned_reviewer_id === user.id) {
          isAuthorized = true;
        }
      }
    } else if (row.project_id && user.role === 'org_client') {
      const projRes = await db.query<{ client_user_id: string }>(
        `SELECT client_user_id FROM business_projects WHERE id = $1`,
        [row.project_id]
      );
      if (projRes.rows.length > 0 && projRes.rows[0].client_user_id === user.id) {
        isAuthorized = true;
      }
    }
  }

  if (!isAuthorized) {
    await recordAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      pillar: row.pillar,
      action: 'FILE_ACCESS_DENIED',
      targetType: 'FILE',
      targetId: fileId,
      status: 'DENIED',
      metadata: {
        ownerUserId: row.owner_user_id,
        visibility: row.visibility,
        taskId: row.task_id,
      },
    });
    throw new AppError('You are not authorized to access this private file.', 403, 'FORBIDDEN_FILE_ACCESS');
  }

  const content = await storageProvider.getObject(row.storage_key);
  return {
    metadata: {
      id: row.id,
      ownerUserId: row.owner_user_id,
      pillar: row.pillar,
      originalName: row.original_name,
      storageKey: row.storage_key,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      sha256Checksum: row.sha256_checksum,
      visibility: row.visibility,
      projectId: row.project_id,
      taskId: row.task_id,
      createdAt: row.created_at,
    },
    content,
  };
}
