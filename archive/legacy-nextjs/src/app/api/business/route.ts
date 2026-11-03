import { NextResponse } from 'next/server';
import { resolveUserFromRequest } from '@/lib/core/auth';
import { AppError, enforceCsrfProtection, handleApiError } from '@/lib/core/http';
import { enforceRateLimit, extractTrustedClientIp } from '@/lib/core/rate-limit';
import {
  computeExplainableTalentMatches,
  createAndAssignTask,
  createProjectRequest,
  finalizeProjectDeliverables,
  getAuthorizedDeliveryReport,
  getAuthorizedTaskForUser,
  getBusinessWorkspaceData,
  recordTalentAssessment,
  reviewProjectRequest,
  reviewTaskSubmission,
  submitTaskWork,
  updateCompensationStatus,
  upsertTalentProfile,
} from '@/lib/business/service';

export async function GET(req: Request) {
  try {
    const user = await resolveUserFromRequest(req);
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');
    const reportId = searchParams.get('reportId');
    const matchProjectId = searchParams.get('matchProjectId');

    if (taskId) {
      const data = await getAuthorizedTaskForUser(user, taskId);
      return NextResponse.json({ ok: true, ...data });
    }

    if (reportId) {
      const report = await getAuthorizedDeliveryReport(user, reportId);
      return NextResponse.json({ ok: true, report });
    }

    if (matchProjectId) {
      const matches = await computeExplainableTalentMatches(user, matchProjectId);
      return NextResponse.json({ ok: true, ...matches });
    }

    const workspace = await getBusinessWorkspaceData(user);
    return NextResponse.json({ ok: true, workspace });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    enforceCsrfProtection(req);
    const clientIp = extractTrustedClientIp(req);
    await enforceRateLimit(`api:business:${clientIp}`, 60, 60_000);

    const user = await resolveUserFromRequest(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'create_project') {
      const project = await createProjectRequest(user, body);
      return NextResponse.json({ ok: true, project }, { status: 201 });
    }

    if (action === 'review_project') {
      const project = await reviewProjectRequest(user, body);
      return NextResponse.json({ ok: true, project });
    }

    if (action === 'upsert_talent_profile') {
      const profile = await upsertTalentProfile(user, body);
      return NextResponse.json({ ok: true, profile });
    }

    if (action === 'record_assessment') {
      const assessment = await recordTalentAssessment(user, body);
      return NextResponse.json({ ok: true, assessment }, { status: 201 });
    }

    if (action === 'create_assign_task') {
      const result = await createAndAssignTask(user, body);
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (action === 'submit_work') {
      const submission = await submitTaskWork(user, body);
      return NextResponse.json({ ok: true, submission }, { status: 201 });
    }

    if (action === 'review_submission') {
      const result = await reviewTaskSubmission(user, body);
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'finalize_delivery') {
      const report = await finalizeProjectDeliverables(user, body);
      return NextResponse.json({ ok: true, report }, { status: 201 });
    }

    if (action === 'update_compensation') {
      const compensation = await updateCompensationStatus(user, body);
      return NextResponse.json({ ok: true, compensation });
    }

    throw new AppError(`Unknown business action '${String(action)}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
