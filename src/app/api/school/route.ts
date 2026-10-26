import { NextResponse } from 'next/server';
import { getAuthenticatedUserFromRequest } from '@/lib/core/auth';
import { handleApiError } from '@/lib/core/http';
import { AppError } from '@/lib/core/rbac';
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
    const catalog = await getSchoolCatalog();
    const user = await getAuthenticatedUserFromRequest(req);
    if (!user) {
      return NextResponse.json({ ok: true, catalog, workspace: null });
    }
    const workspace = await getStudentWorkspaceData(user);
    return NextResponse.json({ ok: true, catalog, workspace });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'upsert_profile') {
      const profile = await upsertAcademicProfile(user, {
        country: body.country,
        curriculumId: body.curriculumId,
        levelId: body.levelId,
        primarySubjectId: body.primarySubjectId,
        institutionName: body.institutionName,
        learningGoals: body.learningGoals,
      });
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

    throw new AppError(`Unknown school action '${action}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
