import { NextResponse } from 'next/server';
import { resolveUserFromRequest } from '@/lib/core/auth';
import { AppError, enforceCsrfProtection, handleApiError } from '@/lib/core/http';
import { enforceRateLimit, extractTrustedClientIp } from '@/lib/core/rate-limit';
import { inferAllowedMimeType } from '@/lib/core/storage';
import {
  generateRevisionAndExercise,
  getSchoolCatalog,
  getStudentWorkspaceData,
  requestGroundedExplanation,
  submitExerciseAnswers,
  uploadSchoolDocument,
  upsertAcademicProfile,
} from '@/lib/school/service';

export async function GET(req: Request) {
  try {
    const user = await resolveUserFromRequest(req);
    const catalog = await getSchoolCatalog();
    let workspace = null;
    if (user && (user.role === 'student' || user.role === 'teacher' || user.role === 'admin')) {
      workspace = await getStudentWorkspaceData(user);
    }
    return NextResponse.json({
      ok: true,
      catalog,
      workspace,
    });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    enforceCsrfProtection(req);
    const clientIp = extractTrustedClientIp(req);
    await enforceRateLimit(`api:school:${clientIp}`, 60, 60_000);

    const user = await resolveUserFromRequest(req);
    const contentType = (req.headers.get('content-type') || '').toLowerCase();

    if (contentType.includes('multipart/form-data')) {
      const formData = await req.formData();
      const action = String(formData.get('action') || 'upload_document');
      if (action !== 'upload_document') {
        throw new AppError(
          `Multipart upload is only supported for 'upload_document' action.`,
          400,
          'INVALID_MULTIPART_ACTION'
        );
      }

      const title = String(formData.get('title') || '').trim();
      const curriculumId = formData.get('curriculumId')
        ? String(formData.get('curriculumId'))
        : null;
      const subjectId = formData.get('subjectId') ? String(formData.get('subjectId')) : null;
      const isTeacherResource = formData.get('isTeacherResource') === 'true';

      const fileField = formData.get('file');
      let originalFileName = String(formData.get('originalFileName') || '').trim();
      let mimeType = String(formData.get('mimeType') || '').trim();
      let content: Buffer | string;

      if (fileField && typeof (fileField as Blob).arrayBuffer === 'function') {
        const blob = fileField as File;
        const ab = await blob.arrayBuffer();
        content = Buffer.from(ab);
        originalFileName = blob.name || originalFileName || 'uploaded_document.txt';
        mimeType = inferAllowedMimeType(originalFileName, blob.type || mimeType);
      } else {
        const textContent = String(formData.get('content') || '');
        originalFileName = originalFileName || 'document.txt';
        mimeType = inferAllowedMimeType(originalFileName, mimeType || 'text/plain');
        content = Buffer.from(textContent, 'utf8');
      }

      const result = await uploadSchoolDocument(user, {
        title,
        originalFileName,
        mimeType,
        content,
        curriculumId,
        subjectId,
        isTeacherResource,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    const body = await req.json();
    const action = body?.action;

    if (action === 'upsert_profile') {
      const profile = await upsertAcademicProfile(user, body);
      return NextResponse.json({ ok: true, profile });
    }

    if (action === 'upload_document') {
      const result = await uploadSchoolDocument(user, {
        title: body.title,
        originalFileName: body.originalFileName || 'document.txt',
        mimeType: body.mimeType || 'text/plain',
        content: body.content || '',
        curriculumId: body.curriculumId,
        subjectId: body.subjectId,
        isTeacherResource: Boolean(body.isTeacherResource),
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (action === 'explain_grounded') {
      const result = await requestGroundedExplanation(user, {
        documentId: body.documentId,
        subjectId: body.subjectId,
        question: body.question,
        simulateProviderFailure: Boolean(body.simulateProviderFailure),
        strictLiveRequired: Boolean(body.strictLiveRequired),
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'generate_revision_exercise') {
      const result = await generateRevisionAndExercise(user, {
        documentId: body.documentId,
        subjectId: body.subjectId,
        title: body.title,
        difficulty: body.difficulty,
        materialType: body.materialType,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (action === 'submit_exercise') {
      const submission = await submitExerciseAnswers(user, {
        exerciseId: body.exerciseId,
        answers: body.answers || {},
      });
      return NextResponse.json({ ok: true, submission }, { status: 201 });
    }

    throw new AppError(`Unknown school action '${String(action)}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
