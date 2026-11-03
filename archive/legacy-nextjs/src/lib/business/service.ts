import { ensureDbReady } from '@/lib/db';
import { createId } from '@/lib/core/crypto';
import {
  AppError,
  AuthenticatedUser,
  BUSINESS_ROLES,
  enforceRole,
  OPERATOR_ROLES,
} from '@/lib/core/rbac';
import { createNotification, recordAuditEvent } from '@/lib/core/audit';

export type ServiceMode = 'MANAGED_PROJECT' | 'QUALIFIED_TALENT_PROVISION';
export type ServiceCategory =
  | 'AFRICAN_LANG_TRANSCRIPTION_ANNOTATION'
  | 'TRANSLATION_LINGUISTIC_VALIDATION'
  | 'MULTILINGUAL_DATA_PREP'
  | 'AI_EVALUATION_MODEL_TESTING'
  | 'EXPERT_DATA_ANNOTATION_QA'
  | 'SPECIALIZED_AI_PROJECT_TEAM';

export type ProjectStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED_ACTIVE'
  | 'IN_EXECUTION'
  | 'QA_REVIEW'
  | 'DELIVERED'
  | 'CLOSED'
  | 'REJECTED';

export async function createProjectRequest(
  user: AuthenticatedUser | null,
  input: {
    organizationName: string;
    organizationCountry?: string;
    organizationIndustry?: string;
    title: string;
    serviceMode: ServiceMode;
    serviceCategory: ServiceCategory;
    description: string;
    deliverablesSpec: string;
    acceptanceCriteria: string;
    targetLanguages: string[];
    targetDialects?: string[];
    budgetAmountCents: number;
    currency?: string;
    deadlineDate?: string;
  }
) {
  const actor = await enforceRole(
    user,
    ['org_client', 'operator', 'admin'],
    'business',
    'CREATE_PROJECT_REQUEST'
  );

  if (!input.title || input.title.trim().length < 3) {
    throw new AppError('Project title is required (min 3 characters).', 400, 'INVALID_PROJECT_TITLE');
  }
  if (!input.deliverablesSpec || !input.acceptanceCriteria) {
    throw new AppError('Deliverables specification and acceptance criteria are required.', 400, 'MISSING_PROJECT_SPECS');
  }
  if (! ['MANAGED_PROJECT', 'QUALIFIED_TALENT_PROVISION'].includes(input.serviceMode)) {
    throw new AppError('Invalid service mode.', 400, 'INVALID_SERVICE_MODE');
  }
  if (input.budgetAmountCents < 0) {
    throw new AppError('Project budget cannot be negative.', 400, 'INVALID_BUDGET');
  }

  const db = await ensureDbReady();

  // Find or create organization for this client
  let orgId: string;
  const existingOrg = await db.query<{ id: string }>(
    `SELECT id FROM organizations WHERE owner_user_id = $1 AND name = $2`,
    [actor.id, input.organizationName.trim()]
  );

  if (existingOrg.rows.length > 0) {
    orgId = existingOrg.rows[0].id;
  } else {
    orgId = createId('org');
    await db.query(
      `INSERT INTO organizations (id, owner_user_id, name, country, industry, contact_email, billing_currency, verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)`,
      [
        orgId,
        actor.id,
        input.organizationName.trim(),
        input.organizationCountry?.trim() || actor.countryCode || 'BJ',
        input.organizationIndustry?.trim() || 'AI & Language Technology',
        actor.email,
        input.currency || 'USD',
      ]
    );
  }

  const projectId = createId('prj');
  const estimatedCostCents = Math.round(input.budgetAmountCents * 0.85);

  await db.query(
    `INSERT INTO business_projects (
      id, organization_id, client_user_id, title, service_mode, service_category, status,
      description, deliverables_spec, acceptance_criteria, target_languages_json, target_dialects_json,
      budget_amount_cents, estimated_cost_cents, currency, deadline_date
    ) VALUES ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15)`,
    [
      projectId,
      orgId,
      actor.id,
      input.title.trim(),
      input.serviceMode,
      input.serviceCategory,
      input.description.trim(),
      input.deliverablesSpec.trim(),
      input.acceptanceCriteria.trim(),
      JSON.stringify(input.targetLanguages || []),
      JSON.stringify(input.targetDialects || []),
      input.budgetAmountCents,
      estimatedCostCents,
      input.currency || 'USD',
      input.deadlineDate || null,
    ]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'PROJECT_REQUEST_CREATED',
    targetType: 'PROJECT',
    targetId: projectId,
    status: 'SUCCESS',
    metadata: {
      organizationId: orgId,
      serviceMode: input.serviceMode,
      serviceCategory: input.serviceCategory,
      targetLanguages: input.targetLanguages,
      budgetAmountCents: input.budgetAmountCents,
    },
  });

  const saved = await db.query(
    `SELECT p.*, o.name AS organization_name
     FROM business_projects p
     JOIN organizations o ON o.id = p.organization_id
     WHERE p.id = $1`,
    [projectId]
  );
  return saved.rows[0];
}

export async function reviewProjectRequest(
  user: AuthenticatedUser | null,
  input: {
    projectId: string;
    newStatus: ProjectStatus;
    operatorNotes?: string;
    acceptanceCriteriaOverride?: string;
    estimatedCostCents?: number;
  }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'business', 'OPERATOR_REVIEW_PROJECT');
  const db = await ensureDbReady();

  const projRes = await db.query<{
    id: string;
    client_user_id: string;
    title: string;
    status: ProjectStatus;
  }>(`SELECT id, client_user_id, title, status FROM business_projects WHERE id = $1`, [input.projectId]);

  if (projRes.rows.length === 0) {
    throw new AppError('Business project not found.', 404, 'PROJECT_NOT_FOUND');
  }
  const project = projRes.rows[0];

  await db.query(
    `UPDATE business_projects
     SET status = $2,
         operator_notes = COALESCE($3, operator_notes),
         acceptance_criteria = COALESCE($4, acceptance_criteria),
         estimated_cost_cents = COALESCE($5, estimated_cost_cents),
         reviewed_by_user_id = $6,
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.projectId,
      input.newStatus,
      input.operatorNotes ?? null,
      input.acceptanceCriteriaOverride ?? null,
      input.estimatedCostCents ?? null,
      actor.id,
    ]
  );

  await createNotification({
    userId: project.client_user_id,
    category: 'PROJECT_STATUS',
    title: `Statut du projet mis à jour : ${input.newStatus}`,
    message: `Votre projet "${project.title}" est passé de ${project.status} à ${input.newStatus}.`,
    linkPath: `/business`,
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'PROJECT_STATUS_TRANSITIONED',
    targetType: 'PROJECT',
    targetId: input.projectId,
    status: 'SUCCESS',
    metadata: {
      previousStatus: project.status,
      newStatus: input.newStatus,
      operatorNotes: input.operatorNotes,
    },
  });

  const updated = await db.query(`SELECT * FROM business_projects WHERE id = $1`, [input.projectId]);
  return updated.rows[0];
}

export async function upsertTalentProfile(
  user: AuthenticatedUser | null,
  input: {
    targetUserId?: string;
    headline: string;
    country: string;
    nativeLanguages: string[];
    dialects: string[];
    skills: string[];
    workSamples?: Array<{ title: string; description: string; language: string }>;
    availabilityHoursPerWeek?: number;
    availabilityStatus?: 'AVAILABLE' | 'PARTIALLY_AVAILABLE' | 'UNAVAILABLE';
    consentVoiceDataset?: boolean;
    consentLinguisticCorpus?: boolean;
  }
) {
  const actor = await enforceRole(
    user,
    ['contributor', 'reviewer', 'operator', 'admin'],
    'business',
    'UPSERT_TALENT_PROFILE'
  );

  const targetUserId =
    input.targetUserId && (actor.role === 'operator' || actor.role === 'admin')
      ? input.targetUserId
      : actor.id;

  const db = await ensureDbReady();
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM talent_profiles WHERE user_id = $1`,
    [targetUserId]
  );

  const consentVoice = Boolean(input.consentVoiceDataset);
  const consentCorpus = Boolean(input.consentLinguisticCorpus);
  const consentSignedAt = consentVoice || consentCorpus ? new Date().toISOString() : null;

  let profileId: string;
  if (existing.rows.length > 0) {
    profileId = existing.rows[0].id;
    await db.query(
      `UPDATE talent_profiles
       SET headline = $2,
           country = $3,
           native_languages_json = $4::jsonb,
           dialects_json = $5::jsonb,
           skills_json = $6::jsonb,
           work_samples_json = $7::jsonb,
           availability_hours_per_week = $8,
           availability_status = $9,
           consent_voice_dataset = $10,
           consent_linguistic_corpus = $11,
           consent_signed_at = COALESCE($12, consent_signed_at),
           updated_at = NOW()
       WHERE user_id = $1`,
      [
        targetUserId,
        input.headline.trim(),
        input.country.trim(),
        JSON.stringify(input.nativeLanguages || []),
        JSON.stringify(input.dialects || []),
        JSON.stringify(input.skills || []),
        JSON.stringify(input.workSamples || []),
        input.availabilityHoursPerWeek ?? 20,
        input.availabilityStatus || 'AVAILABLE',
        consentVoice,
        consentCorpus,
        consentSignedAt,
      ]
    );
  } else {
    profileId = createId('tal');
    await db.query(
      `INSERT INTO talent_profiles (
        id, user_id, headline, country, native_languages_json, dialects_json, skills_json,
        work_samples_json, availability_hours_per_week, availability_status,
        consent_voice_dataset, consent_linguistic_corpus, consent_signed_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)`,
      [
        profileId,
        targetUserId,
        input.headline.trim(),
        input.country.trim(),
        JSON.stringify(input.nativeLanguages || []),
        JSON.stringify(input.dialects || []),
        JSON.stringify(input.skills || []),
        JSON.stringify(input.workSamples || []),
        input.availabilityHoursPerWeek ?? 20,
        input.availabilityStatus || 'AVAILABLE',
        consentVoice,
        consentCorpus,
        consentSignedAt,
      ]
    );
  }

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'TALENT_PROFILE_SAVED',
    targetType: 'TALENT_PROFILE',
    targetId: profileId,
    status: 'SUCCESS',
    metadata: {
      targetUserId,
      claimedLanguages: input.nativeLanguages,
      note: 'Claimed languages remain UNVERIFIED until a corresponding assessment is passed.',
    },
  });

  return getTalentProfileWithVerification(targetUserId);
}

export async function recordTalentAssessment(
  user: AuthenticatedUser | null,
  input: {
    talentUserId: string;
    assessmentType: 'LANGUAGE_PROFICIENCY' | 'DOMAIN_SKILL' | 'ANNOTATION_QA';
    languageCode?: string | null;
    dialect?: string | null;
    skillName: string;
    score: number;
    passingScore?: number;
    notes?: string;
  }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'business', 'RECORD_TALENT_ASSESSMENT');
  const db = await ensureDbReady();

  const passingScore = input.passingScore ?? 75;
  if (input.score < 0 || input.score > 100) {
    throw new AppError('Assessment score must be between 0 and 100.', 400, 'INVALID_SCORE');
  }
  const passed = Number(input.score) >= Number(passingScore);
  const assessmentId = createId('asr');

  await db.query(
    `INSERT INTO talent_assessments (
      id, talent_user_id, assessment_type, language_code, dialect, skill_name,
      score, passing_score, passed, verified_by_user_id, notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      assessmentId,
      input.talentUserId,
      input.assessmentType,
      input.languageCode ? input.languageCode.toLowerCase().trim() : null,
      input.dialect?.trim() || null,
      input.skillName.trim(),
      input.score,
      passingScore,
      passed,
      actor.id,
      input.notes?.trim() || null,
    ]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'TALENT_ASSESSMENT_RECORDED',
    targetType: 'TALENT_ASSESSMENT',
    targetId: assessmentId,
    status: 'SUCCESS',
    metadata: {
      talentUserId: input.talentUserId,
      assessmentType: input.assessmentType,
      languageCode: input.languageCode,
      score: input.score,
      passingScore,
      passed,
    },
  });

  const saved = await db.query(`SELECT * FROM talent_assessments WHERE id = $1`, [assessmentId]);
  return saved.rows[0];
}

export async function getTalentProfileWithVerification(talentUserId: string) {
  const db = await ensureDbReady();
  const profileRes = await db.query<{
    id: string;
    user_id: string;
    headline: string;
    country: string;
    native_languages_json: string[];
    dialects_json: string[];
    skills_json: string[];
    work_samples_json: any[];
    availability_hours_per_week: number;
    availability_status: string;
    consent_voice_dataset: boolean;
    consent_linguistic_corpus: boolean;
  }>(`SELECT * FROM talent_profiles WHERE user_id = $1`, [talentUserId]);

  const userRes = await db.query<{ id: string; full_name: string; email: string; role: string }>(
    `SELECT id, full_name, email, role FROM users WHERE id = $1`,
    [talentUserId]
  );

  const assessmentsRes = await db.query<{
    id: string;
    assessment_type: string;
    language_code: string | null;
    dialect: string | null;
    skill_name: string;
    score: string;
    passing_score: string;
    passed: boolean;
    evaluated_at: string;
  }>(
    `SELECT * FROM talent_assessments WHERE talent_user_id = $1 ORDER BY evaluated_at DESC`,
    [talentUserId]
  );

  const profile = profileRes.rows[0] || null;
  const assessments = assessmentsRes.rows;

  // Enforce strict rule: A language is ONLY verified if a LANGUAGE_PROFICIENCY assessment has passed = true
  const verifiedLanguages = Array.from(
    new Set(
      assessments
        .filter((a) => a.assessment_type === 'LANGUAGE_PROFICIENCY' && a.passed && a.language_code)
        .map((a) => a.language_code!.toLowerCase())
    )
  );

  const claimedLanguages = (profile?.native_languages_json || []).map((l) => l.toLowerCase());
  const unverifiedLanguages = claimedLanguages.filter((l) => !verifiedLanguages.includes(l));

  return {
    user: userRes.rows[0] || null,
    profile,
    assessments,
    verificationSummary: {
      verifiedLanguages,
      unverifiedClaimedLanguages: unverifiedLanguages,
      passedDomainSkills: assessments
        .filter((a) => a.assessment_type !== 'LANGUAGE_PROFICIENCY' && a.passed)
        .map((a) => a.skill_name),
      hasVerifiedLanguageSkills: verifiedLanguages.length > 0,
    },
  };
}

export async function computeExplainableTalentMatches(
  user: AuthenticatedUser | null,
  projectId: string
) {
  await enforceRole(user, OPERATOR_ROLES, 'business', 'COMPUTE_TALENT_MATCHES');
  const db = await ensureDbReady();

  const projRes = await db.query<{
    id: string;
    title: string;
    target_languages_json: string[];
    target_dialects_json: string[];
    service_category: string;
  }>(`SELECT * FROM business_projects WHERE id = $1`, [projectId]);

  if (projRes.rows.length === 0) {
    throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
  }
  const project = projRes.rows[0];
  const targetLangs = (project.target_languages_json || []).map((l) => l.toLowerCase());
  const targetDialects = (project.target_dialects_json || []).map((d) => d.toLowerCase());

  const profilesRes = await db.query<{ user_id: string }>(`SELECT user_id FROM talent_profiles`);
  const candidates = [];

  for (const row of profilesRes.rows) {
    const details = await getTalentProfileWithVerification(row.user_id);
    if (!details.profile || !details.user) continue;

    const verifiedLangMatches = targetLangs.filter((tl) =>
      details.verificationSummary.verifiedLanguages.includes(tl)
    );
    const unverifiedLangMatches = targetLangs.filter((tl) =>
      details.verificationSummary.unverifiedClaimedLanguages.includes(tl)
    );
    const candidateDialects = (details.profile.dialects_json || []).map((d) => d.toLowerCase());
    const dialectMatches = targetDialects.filter((td) =>
      candidateDialects.some((cd) => cd.includes(td) || td.includes(cd))
    );

    const langScore =
      targetLangs.length > 0 ? (verifiedLangMatches.length / targetLangs.length) * 55 : 40;
    const skillScore = details.verificationSummary.passedDomainSkills.length > 0 ? 25 : 5;
    const dialectScore =
      targetDialects.length > 0
        ? (dialectMatches.length / targetDialects.length) * 10
        : 10;
    const availScore =
      details.profile.availability_status === 'AVAILABLE' &&
      details.profile.availability_hours_per_week >= 10
        ? 10
        : 3;

    const totalScore = Number(Math.min(100, langScore + skillScore + dialectScore + availScore).toFixed(1));
    const eligibleForVerifiedAssignment =
      targetLangs.length === 0 || verifiedLangMatches.length > 0;

    const reasons: string[] = [];
    if (verifiedLangMatches.length > 0) {
      reasons.push(`Verified assessment passed for language(s): ${verifiedLangMatches.join(', ').toUpperCase()}`);
    } else if (unverifiedLangMatches.length > 0) {
      reasons.push(
        `Claimed language(s) [${unverifiedLangMatches.join(', ').toUpperCase()}] are UNVERIFIED (no passed assessment on record — blocked from verified assignment)`
      );
    } else {
      reasons.push(`No verified match for target language(s): ${targetLangs.join(', ').toUpperCase()}`);
    }

    if (details.verificationSummary.passedDomainSkills.length > 0) {
      reasons.push(`Passed domain assessments: ${details.verificationSummary.passedDomainSkills.join(', ')}`);
    }
    if (dialectMatches.length > 0) {
      reasons.push(`Dialect match: ${dialectMatches.join(', ')}`);
    }
    reasons.push(
      `Availability: ${details.profile.availability_status} (${details.profile.availability_hours_per_week}h/week)`
    );

    candidates.push({
      userId: details.user.id,
      fullName: details.user.full_name,
      email: details.user.email,
      role: details.user.role,
      headline: details.profile.headline,
      country: details.profile.country,
      matchScore: totalScore,
      eligibleForVerifiedAssignment,
      verifiedLanguages: details.verificationSummary.verifiedLanguages,
      unverifiedClaimedLanguages: details.verificationSummary.unverifiedClaimedLanguages,
      passedDomainSkills: details.verificationSummary.passedDomainSkills,
      explanationReasons: reasons,
    });
  }

  candidates.sort((a, b) => b.matchScore - a.matchScore);
  return {
    projectId: project.id,
    projectTitle: project.title,
    targetLanguages: targetLangs,
    candidates,
  };
}

export async function createAndAssignTask(
  user: AuthenticatedUser | null,
  input: {
    projectId: string;
    title: string;
    instructions: string;
    languageCode: string;
    dialect?: string;
    assignedContributorId: string;
    assignedReviewerId?: string | null;
    sourceFileId?: string | null;
    compensationCents: number;
    currency?: string;
    dueDate?: string;
    requireVerifiedLanguage?: boolean;
  }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'business', 'CREATE_AND_ASSIGN_TASK');
  const db = await ensureDbReady();

  const projRes = await db.query<{ id: string; title: string; status: string }>(
    `SELECT id, title, status FROM business_projects WHERE id = $1`,
    [input.projectId]
  );
  if (projRes.rows.length === 0) {
    throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
  }

  const langCode = input.languageCode.trim().toLowerCase();
  const requireVerified = input.requireVerifiedLanguage !== false;

  // Enforce strict rule: contributor cannot be assigned as verified language talent without passing assessment
  const talentInfo = await getTalentProfileWithVerification(input.assignedContributorId);
  if (!talentInfo.user) {
    throw new AppError('Assigned contributor user does not exist.', 404, 'CONTRIBUTOR_NOT_FOUND');
  }

  if (requireVerified && !talentInfo.verificationSummary.verifiedLanguages.includes(langCode)) {
    await recordAuditEvent({
      actorUserId: actor.id,
      actorRole: actor.role,
      pillar: 'business',
      action: 'TASK_ASSIGNMENT_BLOCKED_UNVERIFIED_LANGUAGE',
      targetType: 'PROJECT',
      targetId: input.projectId,
      status: 'DENIED',
      metadata: {
        contributorUserId: input.assignedContributorId,
        requiredLanguage: langCode,
        verifiedLanguages: talentInfo.verificationSummary.verifiedLanguages,
        unverifiedClaimedLanguages: talentInfo.verificationSummary.unverifiedClaimedLanguages,
      },
    });
    throw new AppError(
      `Contributor '${talentInfo.user.full_name}' has NOT passed a verified proficiency assessment for language '${langCode}'. SOLOB+ forbids assigning contributors to language-specific tasks without a passed assessment.`,
      400,
      'UNVERIFIED_LANGUAGE_PROFICIENCY'
    );
  }

  // Ensure project team exists and register team member
  let teamId: string;
  const teamRes = await db.query<{ id: string }>(
    `SELECT id FROM project_teams WHERE project_id = $1`,
    [input.projectId]
  );
  if (teamRes.rows.length > 0) {
    teamId = teamRes.rows[0].id;
  } else {
    teamId = createId('tem');
    await db.query(
      `INSERT INTO project_teams (id, project_id, name, lead_operator_id)
       VALUES ($1, $2, $3, $4)`,
      [teamId, input.projectId, `Équipe ${projRes.rows[0].title}`, actor.id]
    );
  }

  const memberId = createId('ptm');
  await db.query(
    `INSERT INTO project_team_members (
      id, team_id, project_id, user_id, member_role, match_score, match_explanation_json, assigned_by_user_id
    ) VALUES ($1, $2, $3, $4, 'CONTRIBUTOR', 92.0, $5::jsonb, $6)
    ON CONFLICT (project_id, user_id, member_role) DO NOTHING`,
    [
      memberId,
      teamId,
      input.projectId,
      input.assignedContributorId,
      JSON.stringify({
        verifiedLanguage: langCode,
        verifiedLanguagesList: talentInfo.verificationSummary.verifiedLanguages,
      }),
      actor.id,
    ]
  );

  const taskId = createId('tsk');
  await db.query(
    `INSERT INTO business_tasks (
      id, project_id, assigned_contributor_id, assigned_reviewer_id, title, instructions,
      language_code, dialect, source_file_id, status, compensation_cents, currency, due_date, created_by_user_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ASSIGNED', $10, $11, $12, $13)`,
    [
      taskId,
      input.projectId,
      input.assignedContributorId,
      input.assignedReviewerId ?? null,
      input.title.trim(),
      input.instructions.trim(),
      langCode,
      input.dialect?.trim() || null,
      input.sourceFileId ?? null,
      input.compensationCents,
      input.currency || 'USD',
      input.dueDate || null,
      actor.id,
    ]
  );

  // If a source file was attached, bind it to this task with 'assigned_task' visibility
  if (input.sourceFileId) {
    await db.query(
      `UPDATE stored_files
       SET visibility = 'assigned_task', project_id = $2, task_id = $3
       WHERE id = $1`,
      [input.sourceFileId, input.projectId, taskId]
    );
  }

  // Create initial auditable compensation record in PENDING status
  const compId = createId('cmp');
  await db.query(
    `INSERT INTO compensation_records (
      id, project_id, task_id, contributor_user_id, amount_cents, currency,
      payment_status, provider_mode, audit_note
    ) VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', 'DISABLED_NO_LIVE_TRANSFER', $7)`,
    [
      compId,
      input.projectId,
      taskId,
      input.assignedContributorId,
      input.compensationCents,
      input.currency || 'USD',
      'Task assigned; compensation escrowed in PENDING status (no live money transfer configured).',
    ]
  );

  // Advance project status to IN_EXECUTION if currently SUBMITTED/UNDER_REVIEW/APPROVED_ACTIVE
  await db.query(
    `UPDATE business_projects
     SET status = 'IN_EXECUTION', updated_at = NOW()
     WHERE id = $1 AND status IN ('SUBMITTED', 'UNDER_REVIEW', 'APPROVED_ACTIVE')`,
    [input.projectId]
  );

  await createNotification({
    userId: input.assignedContributorId,
    category: 'TASK_ASSIGNED',
    title: `Nouvelle tâche assignée : ${input.title.trim()}`,
    message: `Une tâche vérifiée (${langCode.toUpperCase()}) vous a été attribuée.`,
    linkPath: `/business`,
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'TASK_CREATED_AND_ASSIGNED',
    targetType: 'TASK',
    targetId: taskId,
    status: 'SUCCESS',
    metadata: {
      projectId: input.projectId,
      assignedContributorId: input.assignedContributorId,
      languageCode: langCode,
      compensationCents: input.compensationCents,
    },
  });

  const savedTask = await db.query(`SELECT * FROM business_tasks WHERE id = $1`, [taskId]);
  const savedComp = await db.query(`SELECT * FROM compensation_records WHERE id = $1`, [compId]);
  return {
    task: savedTask.rows[0],
    compensation: savedComp.rows[0],
  };
}

export async function getAuthorizedTaskForUser(
  user: AuthenticatedUser | null,
  taskId: string
) {
  const actor = await enforceRole(user, BUSINESS_ROLES, 'business', 'VIEW_TASK_DETAIL');
  const db = await ensureDbReady();

  const res = await db.query<{
    id: string;
    project_id: string;
    assigned_contributor_id: string | null;
    assigned_reviewer_id: string | null;
    title: string;
    instructions: string;
    language_code: string;
    dialect: string | null;
    source_file_id: string | null;
    status: string;
    compensation_cents: string;
    currency: string;
  }>(`SELECT * FROM business_tasks WHERE id = $1`, [taskId]);

  if (res.rows.length === 0) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = res.rows[0];

  const isAuthorized =
    actor.role === 'operator' ||
    actor.role === 'admin' ||
    (actor.role === 'contributor' && task.assigned_contributor_id === actor.id) ||
    (actor.role === 'reviewer' &&
      (task.assigned_reviewer_id === actor.id || task.assigned_reviewer_id === null));

  if (!isAuthorized) {
    await recordAuditEvent({
      actorUserId: actor.id,
      actorRole: actor.role,
      pillar: 'business',
      action: 'UNAUTHORIZED_TASK_ACCESS_ATTEMPT',
      targetType: 'TASK',
      targetId: taskId,
      status: 'DENIED',
      metadata: {
        assignedContributorId: task.assigned_contributor_id,
        requestingUserId: actor.id,
      },
    });
    throw new AppError(
      'You are not authorized to view or access this task. Contributors may only access tasks explicitly assigned to them.',
      403,
      'FORBIDDEN_TASK_ACCESS'
    );
  }

  const submissions = await db.query(
    `SELECT * FROM task_submissions WHERE task_id = $1 ORDER BY revision_number DESC`,
    [taskId]
  );
  const reviews = await db.query(
    `SELECT * FROM task_reviews WHERE task_id = $1 ORDER BY reviewed_at DESC`,
    [taskId]
  );

  return {
    task,
    submissions: submissions.rows,
    reviews: reviews.rows,
  };
}

export async function submitTaskWork(
  user: AuthenticatedUser | null,
  input: {
    taskId: string;
    contentText: string;
    structuredPayload?: Record<string, unknown>;
    dialect?: string;
    contributorNotes?: string;
    attachmentFileId?: string | null;
  }
) {
  const actor = await enforceRole(
    user,
    ['contributor', 'operator', 'admin'],
    'business',
    'SUBMIT_TASK_WORK'
  );
  const db = await ensureDbReady();

  const taskRes = await db.query<{
    id: string;
    project_id: string;
    assigned_contributor_id: string | null;
    language_code: string;
    dialect: string | null;
    status: string;
    title: string;
  }>(`SELECT * FROM business_tasks WHERE id = $1`, [input.taskId]);

  if (taskRes.rows.length === 0) {
    throw new AppError('Task not found.', 404, 'TASK_NOT_FOUND');
  }
  const task = taskRes.rows[0];

  if (actor.role === 'contributor' && task.assigned_contributor_id !== actor.id) {
    await recordAuditEvent({
      actorUserId: actor.id,
      actorRole: actor.role,
      pillar: 'business',
      action: 'UNAUTHORIZED_TASK_SUBMISSION_ATTEMPT',
      targetType: 'TASK',
      targetId: input.taskId,
      status: 'DENIED',
      metadata: { assignedContributorId: task.assigned_contributor_id },
    });
    throw new AppError('You cannot submit work for a task not assigned to you.', 403, 'FORBIDDEN_TASK_SUBMISSION');
  }

  if (!input.contentText || input.contentText.trim().length < 5) {
    throw new AppError('Submission content is required (min 5 characters).', 400, 'INVALID_SUBMISSION_CONTENT');
  }

  const revRes = await db.query<{ max_rev: number | null }>(
    `SELECT MAX(revision_number) AS max_rev FROM task_submissions WHERE task_id = $1`,
    [input.taskId]
  );
  const nextRevision = Number(revRes.rows[0]?.max_rev || 0) + 1;
  const submissionId = createId('tsb');

  await db.query(
    `INSERT INTO task_submissions (
      id, task_id, project_id, contributor_user_id, revision_number,
      content_text, structured_payload_json, language_code, dialect, attachment_file_id, contributor_notes
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      submissionId,
      task.id,
      task.project_id,
      actor.id,
      nextRevision,
      input.contentText.trim(),
      JSON.stringify(input.structuredPayload || {}),
      task.language_code,
      input.dialect?.trim() || task.dialect,
      input.attachmentFileId ?? null,
      input.contributorNotes?.trim() || null,
    ]
  );

  await db.query(
    `UPDATE business_tasks SET status = 'SUBMITTED', updated_at = NOW() WHERE id = $1`,
    [task.id]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'TASK_WORK_SUBMITTED',
    targetType: 'TASK_SUBMISSION',
    targetId: submissionId,
    status: 'SUCCESS',
    metadata: {
      taskId: task.id,
      projectId: task.project_id,
      revisionNumber: nextRevision,
      languageCode: task.language_code,
    },
  });

  const saved = await db.query(`SELECT * FROM task_submissions WHERE id = $1`, [submissionId]);
  return saved.rows[0];
}

export async function reviewTaskSubmission(
  user: AuthenticatedUser | null,
  input: {
    submissionId: string;
    decision: 'APPROVE' | 'REQUEST_REVISION' | 'REJECT';
    qualityScore: number;
    accuracyScore?: number;
    linguisticFidelityScore?: number;
    disagreementFlag?: boolean;
    disagreementResolutionNotes?: string;
    feedback: string;
  }
) {
  const actor = await enforceRole(
    user,
    ['reviewer', 'operator', 'admin'],
    'business',
    'REVIEW_TASK_SUBMISSION'
  );
  const db = await ensureDbReady();

  const subRes = await db.query<{
    id: string;
    task_id: string;
    project_id: string;
    contributor_user_id: string;
    revision_number: number;
  }>(`SELECT * FROM task_submissions WHERE id = $1`, [input.submissionId]);

  if (subRes.rows.length === 0) {
    throw new AppError('Task submission not found.', 404, 'SUBMISSION_NOT_FOUND');
  }
  const submission = subRes.rows[0];

  if (input.qualityScore < 0 || input.qualityScore > 100) {
    throw new AppError('Quality score must be between 0 and 100.', 400, 'INVALID_QUALITY_SCORE');
  }
  if (!input.feedback || input.feedback.trim().length < 3) {
    throw new AppError('Reviewer feedback is required.', 400, 'MISSING_REVIEW_FEEDBACK');
  }

  const reviewId = createId('rev');
  await db.query(
    `INSERT INTO task_reviews (
      id, submission_id, task_id, reviewer_user_id, decision,
      quality_score, accuracy_score, linguistic_fidelity_score,
      disagreement_flag, disagreement_resolution_notes, feedback
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      reviewId,
      submission.id,
      submission.task_id,
      actor.id,
      input.decision,
      input.qualityScore,
      input.accuracyScore ?? input.qualityScore,
      input.linguisticFidelityScore ?? input.qualityScore,
      Boolean(input.disagreementFlag),
      input.disagreementResolutionNotes?.trim() || null,
      input.feedback.trim(),
    ]
  );

  const newTaskStatus =
    input.decision === 'APPROVE'
      ? 'APPROVED'
      : input.decision === 'REQUEST_REVISION'
        ? 'REVISION_REQUESTED'
        : 'REJECTED';

  await db.query(
    `UPDATE business_tasks SET status = $2, updated_at = NOW() WHERE id = $1`,
    [submission.task_id, newTaskStatus]
  );

  // Update compensation status if approved
  if (input.decision === 'APPROVE') {
    await db.query(
      `UPDATE compensation_records
       SET payment_status = 'APPROVED',
           approved_by_user_id = $2,
           audit_note = $3,
           updated_at = NOW()
       WHERE task_id = $1`,
      [
        submission.task_id,
        actor.id,
        `Approved after QA review (${reviewId}) with quality score ${input.qualityScore}/100.`,
      ]
    );
  } else if (input.decision === 'REJECT') {
    await db.query(
      `UPDATE compensation_records
       SET payment_status = 'HELD',
           audit_note = $2,
           updated_at = NOW()
       WHERE task_id = $1`,
      [submission.task_id, `Held due to submission rejection (${reviewId}).`]
    );
  }

  await createNotification({
    userId: submission.contributor_user_id,
    category: 'TASK_REVIEWED',
    title: `Révision QA terminée : ${input.decision}`,
    message: `Votre soumission (rév. #${submission.revision_number}) a reçu la décision ${input.decision} (Score qualité : ${input.qualityScore}/100).`,
    linkPath: `/business`,
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'TASK_SUBMISSION_REVIEWED',
    targetType: 'TASK_REVIEW',
    targetId: reviewId,
    status: 'SUCCESS',
    metadata: {
      submissionId: submission.id,
      taskId: submission.task_id,
      decision: input.decision,
      qualityScore: input.qualityScore,
      newTaskStatus,
    },
  });

  const savedReview = await db.query(`SELECT * FROM task_reviews WHERE id = $1`, [reviewId]);
  const updatedTask = await db.query(`SELECT * FROM business_tasks WHERE id = $1`, [submission.task_id]);
  const updatedComp = await db.query(`SELECT * FROM compensation_records WHERE task_id = $1`, [submission.task_id]);

  return {
    review: savedReview.rows[0],
    task: updatedTask.rows[0],
    compensation: updatedComp.rows[0] || null,
  };
}

export async function finalizeProjectDeliverables(
  user: AuthenticatedUser | null,
  input: {
    projectId: string;
    title: string;
    executiveSummary: string;
  }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'business', 'FINALIZE_PROJECT_DELIVERABLES');
  const db = await ensureDbReady();

  const projRes = await db.query<{
    id: string;
    client_user_id: string;
    title: string;
    service_mode: string;
    service_category: string;
  }>(`SELECT * FROM business_projects WHERE id = $1`, [input.projectId]);

  if (projRes.rows.length === 0) {
    throw new AppError('Project not found.', 404, 'PROJECT_NOT_FOUND');
  }
  const project = projRes.rows[0];

  const approvedTasksRes = await db.query<{
    id: string;
    title: string;
    language_code: string;
    dialect: string | null;
    assigned_contributor_id: string;
  }>(
    `SELECT id, title, language_code, dialect, assigned_contributor_id
     FROM business_tasks
     WHERE project_id = $1 AND status = 'APPROVED'`,
    [input.projectId]
  );

  if (approvedTasksRes.rows.length === 0) {
    throw new AppError(
      'Cannot finalize project delivery before at least one task is QA-approved.',
      400,
      'NO_APPROVED_TASKS'
    );
  }

  const reviewsRes = await db.query<{
    quality_score: string;
    accuracy_score: string;
    linguistic_fidelity_score: string;
  }>(
    `SELECT r.quality_score, r.accuracy_score, r.linguistic_fidelity_score
     FROM task_reviews r
     JOIN business_tasks t ON t.id = r.task_id
     WHERE t.project_id = $1 AND r.decision = 'APPROVE'`,
    [input.projectId]
  );

  const avgQuality =
    reviewsRes.rows.length > 0
      ? Number(
          (
            reviewsRes.rows.reduce((sum, r) => sum + Number(r.quality_score || 0), 0) /
            reviewsRes.rows.length
          ).toFixed(2)
        )
      : 90.0;

  const avgFidelity =
    reviewsRes.rows.length > 0
      ? Number(
          (
            reviewsRes.rows.reduce((sum, r) => sum + Number(r.linguistic_fidelity_score || 0), 0) /
            reviewsRes.rows.length
          ).toFixed(2)
        )
      : 90.0;

  const deliverablesSummary = [];
  for (const t of approvedTasksRes.rows) {
    const latestSub = await db.query<{
      id: string;
      revision_number: number;
      content_text: string;
      language_code: string;
      dialect: string | null;
      submitted_at: string;
    }>(
      `SELECT id, revision_number, content_text, language_code, dialect, submitted_at
       FROM task_submissions
       WHERE task_id = $1
       ORDER BY revision_number DESC
       LIMIT 1`,
      [t.id]
    );
    deliverablesSummary.push({
      taskId: t.id,
      taskTitle: t.title,
      languageCode: t.language_code,
      dialect: t.dialect,
      latestSubmission: latestSub.rows[0] || null,
    });
  }

  const reportId = createId('dlv');
  await db.query(
    `INSERT INTO delivery_reports (
      id, project_id, prepared_by_user_id, title, executive_summary,
      deliverables_summary_json, quality_metrics_json, total_tasks_approved,
      average_quality_score, client_authorized
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, TRUE)`,
    [
      reportId,
      input.projectId,
      actor.id,
      input.title.trim(),
      input.executiveSummary.trim(),
      JSON.stringify(deliverablesSummary),
      JSON.stringify({
        averageQualityScore: avgQuality,
        averageLinguisticFidelityScore: avgFidelity,
        approvedTasksCount: approvedTasksRes.rows.length,
        qaVerified: true,
      }),
      approvedTasksRes.rows.length,
      avgQuality,
    ]
  );

  await db.query(
    `UPDATE business_projects SET status = 'DELIVERED', updated_at = NOW() WHERE id = $1`,
    [input.projectId]
  );

  // Transition approved compensations to READY_FOR_PAYOUT (no automatic real-money transfer)
  await db.query(
    `UPDATE compensation_records
     SET payment_status = 'READY_FOR_PAYOUT',
         audit_note = COALESCE(audit_note, '') || ' | Project delivered (' || $2 || '); ready for payout once payment provider is enabled.',
         updated_at = NOW()
     WHERE project_id = $1 AND payment_status = 'APPROVED'`,
    [input.projectId, reportId]
  );

  await createNotification({
    userId: project.client_user_id,
    category: 'PROJECT_DELIVERED',
    title: `Livrable final disponible : ${input.title.trim()}`,
    message: `Le rapport de livraison officiel pour "${project.title}" est prêt pour consultation.`,
    linkPath: `/business`,
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'PROJECT_DELIVERABLES_FINALIZED',
    targetType: 'DELIVERY_REPORT',
    targetId: reportId,
    status: 'SUCCESS',
    metadata: {
      projectId: input.projectId,
      totalTasksApproved: approvedTasksRes.rows.length,
      averageQualityScore: avgQuality,
    },
  });

  const saved = await db.query(`SELECT * FROM delivery_reports WHERE id = $1`, [reportId]);
  return saved.rows[0];
}

export async function getAuthorizedDeliveryReport(
  user: AuthenticatedUser | null,
  reportId: string
) {
  const actor = await enforceRole(
    user,
    ['org_client', 'operator', 'admin'],
    'business',
    'VIEW_DELIVERY_REPORT'
  );
  const db = await ensureDbReady();

  const res = await db.query<{
    id: string;
    project_id: string;
    prepared_by_user_id: string;
    title: string;
    executive_summary: string;
    deliverables_summary_json: any[];
    quality_metrics_json: Record<string, any>;
    total_tasks_approved: number;
    average_quality_score: string;
    client_authorized: boolean;
    finalized_at: string;
    client_user_id: string;
    project_title: string;
    service_mode: string;
  }>(
    `SELECT dr.*, p.client_user_id, p.title AS project_title, p.service_mode
     FROM delivery_reports dr
     JOIN business_projects p ON p.id = dr.project_id
     WHERE dr.id = $1`,
    [reportId]
  );

  if (res.rows.length === 0) {
    throw new AppError('Delivery report not found.', 404, 'DELIVERY_REPORT_NOT_FOUND');
  }
  const report = res.rows[0];

  if (actor.role === 'org_client' && report.client_user_id !== actor.id) {
    await recordAuditEvent({
      actorUserId: actor.id,
      actorRole: actor.role,
      pillar: 'business',
      action: 'DELIVERY_REPORT_ACCESS_DENIED',
      targetType: 'DELIVERY_REPORT',
      targetId: reportId,
      status: 'DENIED',
      metadata: {
        reportProjectClientId: report.client_user_id,
        requestingUserId: actor.id,
      },
    });
    throw new AppError(
      'You are not authorized to view another organization’s delivery report.',
      403,
      'FORBIDDEN_DELIVERY_REPORT'
    );
  }

  return report;
}

export async function updateCompensationStatus(
  user: AuthenticatedUser | null,
  input: {
    compensationId: string;
    newStatus: 'PENDING' | 'APPROVED' | 'READY_FOR_PAYOUT' | 'PAID_SIMULATED' | 'HELD';
    attemptLiveTransfer?: boolean;
    auditNote?: string;
  }
) {
  const actor = await enforceRole(user, OPERATOR_ROLES, 'business', 'UPDATE_COMPENSATION_STATUS');
  const db = await ensureDbReady();

  // Explicit guard against real-money transfers when payment provider is disabled/untested
  const paymentProvider = process.env.PAYMENT_PROVIDER || 'disabled';
  if (input.attemptLiveTransfer && paymentProvider === 'disabled') {
    await recordAuditEvent({
      actorUserId: actor.id,
      actorRole: actor.role,
      pillar: 'business',
      action: 'LIVE_MONEY_TRANSFER_BLOCKED',
      targetType: 'COMPENSATION',
      targetId: input.compensationId,
      status: 'DENIED',
      metadata: {
        reason: 'PAYMENT_PROVIDER_DISABLED_BY_POLICY',
        paymentProvider,
      },
    });
    throw new AppError(
      'Live real-money transfers are disabled until a payment provider is configured, legally verified, and tested in sandbox.',
      400,
      'LIVE_TRANSFER_DISABLED'
    );
  }

  const compRes = await db.query<{
    id: string;
    payment_status: string;
    contributor_user_id: string;
    amount_cents: string;
  }>(`SELECT * FROM compensation_records WHERE id = $1`, [input.compensationId]);

  if (compRes.rows.length === 0) {
    throw new AppError('Compensation record not found.', 404, 'COMPENSATION_NOT_FOUND');
  }
  const current = compRes.rows[0];

  const providerMode =
    input.newStatus === 'PAID_SIMULATED' ? 'SANDBOX_SIMULATED' : 'DISABLED_NO_LIVE_TRANSFER';

  await db.query(
    `UPDATE compensation_records
     SET payment_status = $2,
         provider_mode = $3,
         approved_by_user_id = $4,
         audit_note = COALESCE($5, audit_note),
         updated_at = NOW()
     WHERE id = $1`,
    [
      input.compensationId,
      input.newStatus,
      providerMode,
      actor.id,
      input.auditNote || `Status updated from ${current.payment_status} to ${input.newStatus} (Simulated/Audited).`,
    ]
  );

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'business',
    action: 'COMPENSATION_STATUS_UPDATED',
    targetType: 'COMPENSATION',
    targetId: input.compensationId,
    status: 'SUCCESS',
    metadata: {
      previousStatus: current.payment_status,
      newStatus: input.newStatus,
      providerMode,
      amountCents: Number(current.amount_cents),
    },
  });

  const updated = await db.query(`SELECT * FROM compensation_records WHERE id = $1`, [input.compensationId]);
  return updated.rows[0];
}

export async function getBusinessWorkspaceData(user: AuthenticatedUser | null) {
  const actor = await enforceRole(user, BUSINESS_ROLES, 'business', 'VIEW_BUSINESS_WORKSPACE');
  const db = await ensureDbReady();

  // Role-filtered views enforcing strict isolation
  let projects: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin') {
    const res = await db.query(
      `SELECT p.*, o.name AS organization_name
       FROM business_projects p
       JOIN organizations o ON o.id = p.organization_id
       ORDER BY p.created_at DESC`
    );
    projects = res.rows;
  } else if (actor.role === 'org_client') {
    const res = await db.query(
      `SELECT p.*, o.name AS organization_name
       FROM business_projects p
       JOIN organizations o ON o.id = p.organization_id
       WHERE p.client_user_id = $1
       ORDER BY p.created_at DESC`,
      [actor.id]
    );
    projects = res.rows;
  } else {
    // Contributors and reviewers only see projects where they have an assigned task
    const res = await db.query(
      `SELECT DISTINCT p.id, p.title, p.service_mode, p.service_category, p.status,
              p.target_languages_json, p.deadline_date, o.name AS organization_name
       FROM business_projects p
       JOIN organizations o ON o.id = p.organization_id
       JOIN business_tasks t ON t.project_id = p.id
       WHERE t.assigned_contributor_id = $1 OR t.assigned_reviewer_id = $1`,
      [actor.id]
    );
    projects = res.rows;
  }

  let tasks: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin' || actor.role === 'reviewer') {
    const res = await db.query(
      `SELECT t.*, p.title AS project_title, u.full_name AS contributor_name
       FROM business_tasks t
       JOIN business_projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assigned_contributor_id
       ORDER BY t.created_at DESC`
    );
    tasks = res.rows;
  } else if (actor.role === 'contributor') {
    // Strict enforcement: contributor ONLY receives tasks assigned to them
    const res = await db.query(
      `SELECT t.*, p.title AS project_title
       FROM business_tasks t
       JOIN business_projects p ON p.id = t.project_id
       WHERE t.assigned_contributor_id = $1
       ORDER BY t.created_at DESC`,
      [actor.id]
    );
    tasks = res.rows;
  } else if (actor.role === 'org_client') {
    const res = await db.query(
      `SELECT t.id, t.project_id, t.title, t.language_code, t.dialect, t.status, t.due_date, p.title AS project_title
       FROM business_tasks t
       JOIN business_projects p ON p.id = t.project_id
       WHERE p.client_user_id = $1
       ORDER BY t.created_at DESC`,
      [actor.id]
    );
    tasks = res.rows;
  }

  let submissions: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin' || actor.role === 'reviewer') {
    const res = await db.query(
      `SELECT s.*, t.title AS task_title, u.full_name AS contributor_name
       FROM task_submissions s
       JOIN business_tasks t ON t.id = s.task_id
       JOIN users u ON u.id = s.contributor_user_id
       ORDER BY s.submitted_at DESC`
    );
    submissions = res.rows;
  } else if (actor.role === 'contributor') {
    const res = await db.query(
      `SELECT s.*, t.title AS task_title
       FROM task_submissions s
       JOIN business_tasks t ON t.id = s.task_id
       WHERE s.contributor_user_id = $1
       ORDER BY s.submitted_at DESC`,
      [actor.id]
    );
    submissions = res.rows;
  }

  let deliveryReports: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin') {
    const res = await db.query(
      `SELECT dr.*, p.title AS project_title
       FROM delivery_reports dr
       JOIN business_projects p ON p.id = dr.project_id
       ORDER BY dr.finalized_at DESC`
    );
    deliveryReports = res.rows;
  } else if (actor.role === 'org_client') {
    const res = await db.query(
      `SELECT dr.*, p.title AS project_title
       FROM delivery_reports dr
       JOIN business_projects p ON p.id = dr.project_id
       WHERE p.client_user_id = $1
       ORDER BY dr.finalized_at DESC`,
      [actor.id]
    );
    deliveryReports = res.rows;
  }

  let compensations: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin') {
    const res = await db.query(
      `SELECT c.*, t.title AS task_title, p.title AS project_title, u.full_name AS contributor_name
       FROM compensation_records c
       JOIN business_tasks t ON t.id = c.task_id
       JOIN business_projects p ON p.id = c.project_id
       JOIN users u ON u.id = c.contributor_user_id
       ORDER BY c.created_at DESC`
    );
    compensations = res.rows;
  } else if (actor.role === 'contributor') {
    const res = await db.query(
      `SELECT c.*, t.title AS task_title, p.title AS project_title
       FROM compensation_records c
       JOIN business_tasks t ON t.id = c.task_id
       JOIN business_projects p ON p.id = c.project_id
       WHERE c.contributor_user_id = $1
       ORDER BY c.created_at DESC`,
      [actor.id]
    );
    compensations = res.rows;
  }

  let talentDirectory: any[] = [];
  if (actor.role === 'operator' || actor.role === 'admin') {
    const tUsers = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE role IN ('contributor', 'reviewer') ORDER BY created_at ASC`
    );
    for (const u of tUsers.rows) {
      talentDirectory.push(await getTalentProfileWithVerification(u.id));
    }
  } else if (actor.role === 'contributor' || actor.role === 'reviewer') {
    talentDirectory = [await getTalentProfileWithVerification(actor.id)];
  }

  return {
    projects,
    tasks,
    submissions,
    deliveryReports,
    compensations,
    talentDirectory,
  };
}
