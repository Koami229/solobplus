import { NextResponse } from 'next/server';
import { getAuthenticatedUserFromRequest } from '@/lib/core/auth';
import { handleApiError } from '@/lib/core/http';
import { AppError } from '@/lib/core/rbac';
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
    const user = await getAuthenticatedUserFromRequest(req);
    const { searchParams } = new URL(req.url);
    const taskId = searchParams.get('taskId');
    const reportId = searchParams.get('reportId');
    const matchProjectId = searchParams.get('matchProjectId');

    if (taskId) {
      const detail = await getAuthorizedTaskForUser(user, taskId);
      return NextResponse.json({ ok: true, ...detail });
    }

    if (reportId) {
      const report = await getAuthorizedDeliveryReport(user, reportId);
      return NextResponse.json({ ok: true, report });
    }

    if (matchProjectId) {
      const matches = await computeExplainableTalentMatches(user, matchProjectId);
      return NextResponse.json({ ok: true, matches });
    }

    const workspace = await getBusinessWorkspaceData(user);
    return NextResponse.json({ ok: true, workspace });
  } catch (err) {
    return handleApiError(err);
  }
}

export async function POST(req: Request) {
  try {
    const user = await getAuthenticatedUserFromRequest(req);
    const body = await req.json();
    const action = body?.action;

    if (action === 'create_project') {
      const project = await createProjectRequest(user, {
        organizationName: body.organizationName,
        organizationCountry: body.organizationCountry,
        organizationIndustry: body.organizationIndustry,
        title: body.title,
        serviceMode: body.serviceMode,
        serviceCategory: body.serviceCategory,
        description: body.description,
        deliverablesSpec: body.deliverablesSpec,
        acceptanceCriteria: body.acceptanceCriteria,
        targetLanguages: body.targetLanguages || [],
        targetDialects: body.targetDialects || [],
        budgetAmountCents: Number(body.budgetAmountCents || 0),
        currency: body.currency || 'USD',
        deadlineDate: body.deadlineDate,
      });
      return NextResponse.json({ ok: true, project }, { status: 201 });
    }

    if (action === 'review_project') {
      const project = await reviewProjectRequest(user, {
        projectId: body.projectId,
        newStatus: body.newStatus,
        operatorNotes: body.operatorNotes,
        acceptanceCriteriaOverride: body.acceptanceCriteriaOverride,
        estimatedCostCents: body.estimatedCostCents,
      });
      return NextResponse.json({ ok: true, project });
    }

    if (action === 'upsert_talent_profile') {
      const profile = await upsertTalentProfile(user, {
        targetUserId: body.targetUserId,
        headline: body.headline,
        country: body.country,
        nativeLanguages: body.nativeLanguages || [],
        dialects: body.dialects || [],
        skills: body.skills || [],
        workSamples: body.workSamples || [],
        availabilityHoursPerWeek: body.availabilityHoursPerWeek,
        availabilityStatus: body.availabilityStatus,
        consentVoiceDataset: body.consentVoiceDataset,
        consentLinguisticCorpus: body.consentLinguisticCorpus,
      });
      return NextResponse.json({ ok: true, talent: profile });
    }

    if (action === 'record_assessment') {
      const assessment = await recordTalentAssessment(user, {
        talentUserId: body.talentUserId,
        assessmentType: body.assessmentType,
        languageCode: body.languageCode,
        dialect: body.dialect,
        skillName: body.skillName,
        score: Number(body.score),
        passingScore: body.passingScore !== undefined ? Number(body.passingScore) : 75,
        notes: body.notes,
      });
      return NextResponse.json({ ok: true, assessment }, { status: 201 });
    }

    if (action === 'compute_matches') {
      const matches = await computeExplainableTalentMatches(user, body.projectId);
      return NextResponse.json({ ok: true, matches });
    }

    if (action === 'create_assign_task') {
      const result = await createAndAssignTask(user, {
        projectId: body.projectId,
        title: body.title,
        instructions: body.instructions,
        languageCode: body.languageCode,
        dialect: body.dialect,
        assignedContributorId: body.assignedContributorId,
        assignedReviewerId: body.assignedReviewerId,
        sourceFileId: body.sourceFileId,
        compensationCents: Number(body.compensationCents || 0),
        currency: body.currency || 'USD',
        dueDate: body.dueDate,
        requireVerifiedLanguage: body.requireVerifiedLanguage !== false,
      });
      return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }

    if (action === 'submit_work') {
      const submission = await submitTaskWork(user, {
        taskId: body.taskId,
        contentText: body.contentText,
        structuredPayload: body.structuredPayload,
        dialect: body.dialect,
        contributorNotes: body.contributorNotes,
        attachmentFileId: body.attachmentFileId,
      });
      return NextResponse.json({ ok: true, submission }, { status: 201 });
    }

    if (action === 'review_submission') {
      const result = await reviewTaskSubmission(user, {
        submissionId: body.submissionId,
        decision: body.decision,
        qualityScore: Number(body.qualityScore),
        accuracyScore: body.accuracyScore !== undefined ? Number(body.accuracyScore) : undefined,
        linguisticFidelityScore:
          body.linguisticFidelityScore !== undefined ? Number(body.linguisticFidelityScore) : undefined,
        disagreementFlag: Boolean(body.disagreementFlag),
        disagreementResolutionNotes: body.disagreementResolutionNotes,
        feedback: body.feedback,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (action === 'finalize_delivery') {
      const report = await finalizeProjectDeliverables(user, {
        projectId: body.projectId,
        title: body.title,
        executiveSummary: body.executiveSummary,
      });
      return NextResponse.json({ ok: true, report }, { status: 201 });
    }

    if (action === 'update_compensation') {
      const compensation = await updateCompensationStatus(user, {
        compensationId: body.compensationId,
        newStatus: body.newStatus,
        attemptLiveTransfer: Boolean(body.attemptLiveTransfer),
        auditNote: body.auditNote,
      });
      return NextResponse.json({ ok: true, compensation });
    }

    throw new AppError(`Unknown business action '${action}'.`, 400, 'UNKNOWN_ACTION');
  } catch (err) {
    return handleApiError(err);
  }
}
