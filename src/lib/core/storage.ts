import fs from 'fs';
import path from 'path';
import { ensureDbReady } from '@/lib/db';
import { createId, sha256Hex } from './crypto';
import { AppError, AuthenticatedUser, Pillar } from './rbac';
import { recordAuditEvent } from './audit';

const ALLOWED_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'application/pdf',
  'audio/wav',
  'audio/mpeg',
]);

const FORBIDDEN_EXTENSIONS = [
  '.exe',
  '.sh',
  '.bat',
  '.cmd',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.php',
  '.py',
  '.rb',
  '.pl',
  '.dll',
  '.so',
  '.dylib',
  '.jar',
  '.msi',
  '.com',
  '.scr',
  '.ps1',
  '.vbs',
  '.html',
  '.htm',
  '.svg',
];

export interface StorageProvider {
  putObject(storageKey: string, data: Buffer): Promise<void>;
  getObject(storageKey: string): Promise<Buffer>;
  deleteObject(storageKey: string): Promise<void>;
  existsObject(storageKey: string): Promise<boolean>;
}

class LocalPrivateStorageProvider implements StorageProvider {
  private getBaseDir(): string {
    const dir = process.env.LOCAL_STORAGE_DIR || './data/storage';
    const resolved = path.resolve(process.cwd(), dir);
    fs.mkdirSync(resolved, { recursive: true });
    return resolved;
  }

  private resolveSafePath(storageKey: string): string {
    const base = this.getBaseDir();
    const normalizedKey = storageKey.replace(/[^a-zA-Z0-9._/-]/g, '_').replace(/\.\./g, '_');
    const target = path.resolve(base, normalizedKey);
    if (!target.startsWith(base)) {
      throw new AppError('Invalid storage path traversal attempt.', 400, 'STORAGE_PATH_INVALID');
    }
    return target;
  }

  async putObject(storageKey: string, data: Buffer): Promise<void> {
    const target = this.resolveSafePath(storageKey);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o600 });
  }

  async getObject(storageKey: string): Promise<Buffer> {
    const target = this.resolveSafePath(storageKey);
    if (!fs.existsSync(target)) {
      throw new AppError('Stored file object not found on disk.', 404, 'FILE_OBJECT_MISSING');
    }
    return fs.readFileSync(target);
  }

  async deleteObject(storageKey: string): Promise<void> {
    const target = this.resolveSafePath(storageKey);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
  }

  async existsObject(storageKey: string): Promise<boolean> {
    const target = this.resolveSafePath(storageKey);
    return fs.existsSync(target);
  }
}

export const storageProvider: StorageProvider = new LocalPrivateStorageProvider();

export function inferAllowedMimeType(originalName: string, providedMime?: string): string {
  const lower = (originalName || '').trim().toLowerCase();
  const cleanMime = (providedMime || '').trim().toLowerCase();
  if (cleanMime && ALLOWED_MIME_TYPES.has(cleanMime)) {
    if (lower.endsWith('.pdf') && cleanMime !== 'application/pdf') {
      return 'application/pdf';
    }
    if (lower.endsWith('.json') && cleanMime !== 'application/json') {
      return 'application/json';
    }
    return cleanMime;
  }
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'text/markdown';
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt')) return 'text/plain';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  return cleanMime || 'application/octet-stream';
}

function hasExecutableBinaryHeader(buffer: Buffer): boolean {
  if (buffer.length >= 4) {
    // ELF binary: 0x7F 'E' 'L' 'F'
    if (
      buffer[0] === 0x7f &&
      buffer[1] === 0x45 &&
      buffer[2] === 0x4c &&
      buffer[3] === 0x46
    ) {
      return true;
    }
    // Mach-O 32/64-bit magic numbers
    const magic32 = buffer.readUInt32BE(0);
    if (
      magic32 === 0xfeedface ||
      magic32 === 0xfeedfacf ||
      magic32 === 0xcefaedfe ||
      magic32 === 0xcffaedfe
    ) {
      return true;
    }
  }
  if (buffer.length >= 2) {
    // Windows PE / DOS MZ header: 'M' 'Z'
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      return true;
    }
    // Shell / script shebang: '#!'
    if (buffer[0] === 0x23 && buffer[1] === 0x21) {
      return true;
    }
  }
  return false;
}

/**
 * Validates file signatures (magic bytes) and content structure against the declared MIME type and filename.
 */
export function validateFileSignatureAndContent(
  buffer: Buffer,
  mimeType: string,
  originalName: string
): void {
  const lowerName = originalName.toLowerCase();

  if (hasExecutableBinaryHeader(buffer)) {
    throw new AppError(
      'Uploaded file contains a forbidden executable or script signature.',
      400,
      'INVALID_FILE_SIGNATURE'
    );
  }

  if (mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
    if (mimeType !== 'application/pdf') {
      throw new AppError(
        'PDF file extension does not match declared MIME type.',
        400,
        'INVALID_MIME_TYPE'
      );
    }
    const header = buffer.subarray(0, 5).toString('ascii');
    if (header !== '%PDF-') {
      throw new AppError(
        'Invalid PDF file: missing required %PDF- magic header.',
        400,
        'INVALID_FILE_SIGNATURE'
      );
    }
    return;
  }

  if (mimeType === 'audio/wav' || lowerName.endsWith('.wav')) {
    const riff = buffer.subarray(0, 4).toString('ascii');
    const wave = buffer.subarray(8, 12).toString('ascii');
    if (buffer.length < 12 || riff !== 'RIFF' || wave !== 'WAVE') {
      throw new AppError(
        'Invalid WAV file: missing RIFF/WAVE header signature.',
        400,
        'INVALID_FILE_SIGNATURE'
      );
    }
    return;
  }

  if (mimeType === 'audio/mpeg' || lowerName.endsWith('.mp3')) {
    const id3 = buffer.subarray(0, 3).toString('ascii') === 'ID3';
    const frameSync = buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
    if (!id3 && !frameSync) {
      throw new AppError(
        'Invalid MP3 file: missing ID3 or MPEG audio frame signature.',
        400,
        'INVALID_FILE_SIGNATURE'
      );
    }
    return;
  }

  // Text-based formats: text/plain, text/markdown, text/csv, application/json
  if (buffer.includes(0x00)) {
    throw new AppError(
      'Text document upload rejected: binary null bytes detected.',
      400,
      'INVALID_FILE_SIGNATURE'
    );
  }

  if (mimeType === 'application/json' || lowerName.endsWith('.json')) {
    try {
      JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new AppError(
        'Invalid JSON file: content is not well-formed JSON.',
        400,
        'INVALID_FILE_CONTENT'
      );
    }
  }
}

export interface UploadFileParams {
  user: AuthenticatedUser;
  pillar: Pillar;
  originalName: string;
  mimeType: string;
  content: string | Buffer;
  visibility?: 'private' | 'assigned_task' | 'curriculum_resource';
  projectId?: string | null;
  taskId?: string | null;
  simulateDbFailure?: boolean;
}

export interface StoredFileRecord {
  id: string;
  ownerUserId: string;
  pillar: Pillar;
  originalName: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  sha256Checksum: string;
  visibility: string;
  projectId: string | null;
  taskId: string | null;
}

export async function uploadAndStoreFile(params: UploadFileParams): Promise<StoredFileRecord> {
  const { user, pillar, originalName, mimeType, content } = params;
  const cleanName = originalName.trim();
  if (!cleanName || cleanName.length > 200) {
    throw new AppError('Invalid file name.', 400, 'INVALID_FILE_NAME');
  }

  const lowerName = cleanName.toLowerCase();
  for (const ext of FORBIDDEN_EXTENSIONS) {
    if (lowerName.endsWith(ext)) {
      await recordAuditEvent({
        actorUserId: user.id,
        actorRole: user.role,
        pillar,
        action: 'FILE_UPLOAD_BLOCKED_EXTENSION',
        targetType: 'file',
        status: 'DENIED',
        metadata: { originalName: cleanName, mimeType },
      });
      throw new AppError(
        `File extension '${ext}' is prohibited for security reasons.`,
        400,
        'FORBIDDEN_FILE_TYPE'
      );
    }
  }

  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    await recordAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      pillar,
      action: 'FILE_UPLOAD_BLOCKED_MIME',
      targetType: 'file',
      status: 'DENIED',
      metadata: { originalName: cleanName, mimeType },
    });
    throw new AppError(
      `Unsupported MIME type '${mimeType}'.`,
      400,
      'INVALID_MIME_TYPE'
    );
  }

  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const maxBytes = Number(process.env.MAX_UPLOAD_BYTES || 10_485_760);
  if (buffer.byteLength === 0) {
    throw new AppError('Uploaded file cannot be empty.', 400, 'EMPTY_FILE');
  }
  if (buffer.byteLength > maxBytes) {
    throw new AppError(
      `File size (${buffer.byteLength} bytes) exceeds limit (${maxBytes} bytes).`,
      413,
      'FILE_TOO_LARGE'
    );
  }

  validateFileSignatureAndContent(buffer, mimeType, cleanName);

  const fileId = createId('fil');
  const safeBaseName = cleanName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storageKey = `${pillar}/${user.id}/${fileId}_${safeBaseName}`;
  const checksum = sha256Hex(buffer);
  const visibility = params.visibility ?? 'private';

  await storageProvider.putObject(storageKey, buffer);

  const db = await ensureDbReady();
  try {
    if (params.simulateDbFailure) {
      throw new Error('Simulated database persistence failure after disk write.');
    }

    await db.query(
      `INSERT INTO stored_files (
         id, owner_user_id, pillar, original_name, storage_key,
         mime_type, size_bytes, sha256_checksum, visibility, project_id, task_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        fileId,
        user.id,
        pillar,
        cleanName,
        storageKey,
        mimeType,
        buffer.byteLength,
        checksum,
        visibility,
        params.projectId ?? null,
        params.taskId ?? null,
      ]
    );
  } catch (dbErr) {
    // Compensating cleanup: remove physical file so no orphaned object remains on disk
    await storageProvider.deleteObject(storageKey).catch(() => {});
    throw dbErr;
  }

  await recordAuditEvent({
    actorUserId: user.id,
    actorRole: user.role,
    pillar,
    action: 'FILE_UPLOADED',
    targetType: 'file',
    targetId: fileId,
    status: 'SUCCESS',
    metadata: {
      originalName: cleanName,
      mimeType,
      sizeBytes: buffer.byteLength,
      visibility,
    },
  });

  return {
    id: fileId,
    ownerUserId: user.id,
    pillar,
    originalName: cleanName,
    storageKey,
    mimeType,
    sizeBytes: buffer.byteLength,
    sha256Checksum: checksum,
    visibility,
    projectId: params.projectId ?? null,
    taskId: params.taskId ?? null,
  };
}

/**
 * Deletes both the database record and the underlying physical storage object.
 * Used for compensating cleanup when downstream persistence fails.
 */
export async function deleteStoredFile(fileId: string, storageKey?: string): Promise<void> {
  const db = await ensureDbReady();
  let keyToRemove = storageKey;
  if (!keyToRemove) {
    const res = await db.query<{ storage_key: string }>(
      `SELECT storage_key FROM stored_files WHERE id = $1`,
      [fileId]
    );
    keyToRemove = res.rows[0]?.storage_key;
  }
  await db.query(`DELETE FROM stored_files WHERE id = $1`, [fileId]).catch(() => {});
  if (keyToRemove) {
    await storageProvider.deleteObject(keyToRemove).catch(() => {});
  }
}

/**
 * Enforces strict access control before reading a stored file:
 * - Owner can always read their file.
 * - Admin / Operator can read Business/Core files.
 * - Curriculum resources in School can be read by authenticated School users.
 * - Task files in Business can ONLY be read by the assigned contributor, assigned reviewer, or owning client.
 */
export async function readAuthorizedFile(
  user: AuthenticatedUser | null,
  fileId: string
): Promise<{ record: StoredFileRecord; content: Buffer }> {
  if (!user) {
    throw new AppError('Authentication required to access files.', 401, 'UNAUTHENTICATED');
  }

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
    visibility: string;
    project_id: string | null;
    task_id: string | null;
  }>(`SELECT * FROM stored_files WHERE id = $1`, [fileId]);

  if (res.rows.length === 0) {
    throw new AppError('File not found.', 404, 'FILE_NOT_FOUND');
  }

  const file = res.rows[0];
  let authorized = false;

  if (file.owner_user_id === user.id || user.role === 'admin') {
    authorized = true;
  } else if (file.pillar === 'school') {
    if (
      file.visibility === 'curriculum_resource' &&
      (user.role === 'student' || user.role === 'teacher')
    ) {
      authorized = true;
    }
  } else if (file.pillar === 'business') {
    if (user.role === 'operator') {
      authorized = true;
    } else if (file.task_id) {
      const taskRes = await db.query<{
        assigned_contributor_id: string | null;
        assigned_reviewer_id: string | null;
        client_user_id: string;
      }>(
        `SELECT t.assigned_contributor_id, t.assigned_reviewer_id, p.client_user_id
         FROM business_tasks t
         JOIN business_projects p ON p.id = t.project_id
         WHERE t.id = $1`,
        [file.task_id]
      );
      if (taskRes.rows.length > 0) {
        const t = taskRes.rows[0];
        if (
          t.assigned_contributor_id === user.id ||
          t.assigned_reviewer_id === user.id ||
          t.client_user_id === user.id
        ) {
          authorized = true;
        }
      }
    }
  }

  if (!authorized) {
    await recordAuditEvent({
      actorUserId: user.id,
      actorRole: user.role,
      pillar: file.pillar,
      action: 'FILE_ACCESS_DENIED',
      targetType: 'file',
      targetId: file.id,
      status: 'DENIED',
    });
    throw new AppError(
      'You are not authorized to access this private file.',
      403,
      'FORBIDDEN_FILE_ACCESS'
    );
  }

  const content = await storageProvider.getObject(file.storage_key);
  return {
    record: {
      id: file.id,
      ownerUserId: file.owner_user_id,
      pillar: file.pillar,
      originalName: file.original_name,
      storageKey: file.storage_key,
      mimeType: file.mime_type,
      sizeBytes: file.size_bytes,
      sha256Checksum: file.sha256_checksum,
      visibility: file.visibility,
      projectId: file.project_id,
      taskId: file.task_id,
    },
    content,
  };
}
