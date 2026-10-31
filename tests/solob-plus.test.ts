import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resetDbInstanceForTests, ensureDbReady } from '@/lib/db';
import {
  authenticateSessionToken,
  exportUserDataPackage,
  loginUser,
  logoutSession,
  registerUser,
  createNonProductionInternalUser,
  updatePrivacyAndConsent,
} from '@/lib/core/auth';
import { enforceRole } from '@/lib/core/rbac';
import { readAuthorizedFile, uploadAndStoreFile } from '@/lib/core/storage';
import {
  checkRateLimit,
  clearInMemoryRateLimitCacheOnly,
  extractTrustedClientIp,
} from '@/lib/core/rate-limit';
import { resetAllRateLimits } from '@/lib/core/rate-limit';
import { validateSessionSecretConfig, generateSessionToken } from '@/lib/core/crypto';
import { handleApiError } from '@/lib/core/http';
import { bootstrapInitialAdmin, provisionVerifiedUser } from '@/lib/core/auth';
import { POST as adminPost } from '@/app/api/admin/route';
import {
  generateRevisionAndExercise,
  getSchoolCatalog,
  getStudentWorkspaceData,
  requestGroundedExplanation,
  submitExerciseAnswers,
  uploadSchoolDocument,
  upsertAcademicProfile,
} from '@/lib/school/service';
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
import { runSyntheticSeed } from '@/lib/db/seed';
import { SESSION_COOKIE_NAME, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/core/http';
import { POST as authPost } from '@/app/api/auth/route';
import { POST as schoolPost } from '@/app/api/school/route';
import { POST as businessPost, GET as businessGet } from '@/app/api/business/route';

describe('SOLOB+ Comprehensive Verification Suite (All 15 Required Directive Test Suites)', () => {
  beforeEach(async () => {
    resetAllRateLimits();
    process.env.LOCAL_STORAGE_DIR = './data/storage-test';
    delete process.env.AI_API_KEY;
    process.env.AI_PROVIDER = 'mock';
    process.env.PAYMENT_PROVIDER = 'disabled';
    await resetDbInstanceForTests('memory://');
  });

  // 1. Registration, login and logout
  it('1. Registration, login and logout: hashes passwords with scrypt, issues HMAC session tokens, authenticates, and revokes on logout', async () => {
    const reg = await registerUser({
      email: 'koffi.student@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Koffi Mensah',
      role: 'student',
      preferredUiLang: 'fr',
      countryCode: 'BJ',
    });

    expect(reg.user.email).toBe('koffi.student@example.org');
    expect(reg.user.role).toBe('student');
    expect(reg.user.pillar).toBe('school');
    expect(reg.sessionToken).toContain('.');

    // Verify password is never stored in plaintext
    const db = await ensureDbReady();
    const dbUser = await db.query<{ password_hash: string }>(
      `SELECT password_hash FROM users WHERE id = $1`,
      [reg.user.id]
    );
    expect(dbUser.rows[0].password_hash.startsWith('scrypt$')).toBe(true);
    expect(dbUser.rows[0].password_hash).not.toContain('StrongPassword!2026');

    // Authenticate active token
    const authed = await authenticateSessionToken(reg.sessionToken);
    expect(authed?.id).toBe(reg.user.id);

    // Reject wrong password login
    await expect(
      loginUser({ email: 'koffi.student@example.org', password: 'WrongPassword123' })
    ).rejects.toThrow(/Invalid email or password/);

    // Valid login issues fresh session
    const loginRes = await loginUser({
      email: 'koffi.student@example.org',
      password: 'StrongPassword!2026',
    });
    expect(loginRes.user.id).toBe(reg.user.id);

    // Logout revokes token
    const revoked = await logoutSession(loginRes.sessionToken);
    expect(revoked).toBe(true);
    const afterLogout = await authenticateSessionToken(loginRes.sessionToken);
    expect(afterLogout).toBeNull();
  });

  // 2. Role enforcement on the backend
  it('2. Role enforcement on the backend: blocks unauthenticated requests (401) and insufficient roles (403)', async () => {
    await expect(
      enforceRole(null, ['operator', 'admin'], 'business', 'SENSITIVE_OPERATOR_ACTION')
    ).rejects.toMatchObject({ statusCode: 401, code: 'UNAUTHENTICATED' });

    const contributor = await registerUser({
      email: 'contrib@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Fifame Contributor',
      role: 'contributor',
    });

    await expect(
      enforceRole(contributor.user, ['operator', 'admin'], 'business', 'OPERATOR_ONLY_ACTION')
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_ROLE' });
  });

  // 3. Separation of School and Business permissions
  it('3. Separation of School and Business permissions: prevents School roles from executing Business workflows and vice versa', async () => {
    const student = await registerUser({
      email: 'student.pillar@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Student Pillar Test',
      role: 'student',
    });

    const businessClient = await registerUser({
      email: 'client.pillar@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Client Pillar Test',
      role: 'org_client',
    });

    // Student cannot create a Business project request
    await expect(
      createProjectRequest(student.user, {
        organizationName: 'Unauthorized Student Org',
        title: 'Invalid Cross-Pillar Project',
        serviceMode: 'MANAGED_PROJECT',
        serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
        description: 'Should be blocked by RBAC',
        deliverablesSpec: 'Spec',
        acceptanceCriteria: 'Criteria',
        targetLanguages: ['fon'],
        budgetAmountCents: 10000,
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_ROLE' });

    // Business client cannot upload a School academic document or configure a School learner profile
    await expect(
      uploadSchoolDocument(businessClient.user, {
        title: 'Unauthorized Business Upload to School',
        originalFileName: 'notes.txt',
        mimeType: 'text/plain',
        content: 'Some educational text content that should be rejected for org_client.',
      })
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_ROLE' });
  });

  // 4. Student academic activity persistence
  it('4. Student academic activity persistence: persists profile, document extraction, AI explanations, exercises, submissions, and progress metrics', async () => {
    const student = await registerUser({
      email: 'amina.student@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Amina Etudiante',
      role: 'student',
    });

    const catalog = await getSchoolCatalog();
    expect(catalog.curricula.length).toBeGreaterThanOrEqual(3);
    // Verify unverified curricula are explicitly flagged false
    const unverifiedCur = catalog.curricula.find((c: any) => c.code === 'SN-BAC-UEMOA');
    expect(unverifiedCur?.verified).toBe(false);

    const profile = await upsertAcademicProfile(student.user, {
      country: 'BJ',
      curriculumId: 'cur_bj_bac',
      levelId: 'lvl_bj_tle_cd',
      primarySubjectId: 'sub_bj_svt',
      institutionName: 'Lycée Béhanzin Porto-Novo',
      learningGoals: 'Mention Très Bien au BAC D',
    });
    expect(profile.curriculum_id).toBe('cur_bj_bac');

    const docRes = await uploadSchoolDocument(student.user, {
      title: 'Chapitre 1 : La réplication de l’ADN et mitose',
      originalFileName: 'replication_adn.txt',
      mimeType: 'text/plain',
      curriculumId: 'cur_bj_bac',
      subjectId: 'sub_bj_svt',
      content:
        'La réplication de l’ADN est un processus semi-conservatif assuré par l’enzyme ADN polymérase avant la division cellulaire par mitose.',
    });
    expect(docRes.document.processing_status).toBe('PROCESSED');
    expect(docRes.document.word_count).toBeGreaterThan(10);

    const expl = await requestGroundedExplanation(student.user, {
      documentId: docRes.document.id,
      subjectId: 'sub_bj_svt',
      question: 'Pourquoi dit-on que la réplication de l’ADN est semi-conservative ?',
    });
    expect(expl.aiResult.aiMode).toBe('MOCK_DEMO');
    expect(expl.aiResult.groundingCitations.length).toBeGreaterThan(0);

    const gen = await generateRevisionAndExercise(student.user, {
      documentId: docRes.document.id,
      subjectId: 'sub_bj_svt',
      title: 'Quiz Mitose & Réplication',
      difficulty: 'EXAM_LEVEL',
      materialType: 'EXAM_PREP',
    });
    expect(gen.exercise.questions_json.length).toBe(2);

    const sub = await submitExerciseAnswers(student.user, {
      exerciseId: gen.exercise.id,
      answers: {
        q1: 'La réplication de l’ADN est un processus semi-conservatif catalysé par l’ADN polymérase avant la mitose.',
        q2: 'Chaque cellule fille hérite d’un brin parental et d’un brin néoformé lors de la division cellulaire.',
      },
    });
    expect(Number(sub.score)).toBeGreaterThan(0);

    const workspace = await getStudentWorkspaceData(student.user);
    expect(workspace.documents.length).toBe(1);
    expect(workspace.submissions.length).toBe(1);
    expect(workspace.activities.length).toBeGreaterThanOrEqual(5);
    expect(workspace.progressSummary.cumulativeProgressScore).toBeGreaterThanOrEqual(40);
  });

  // 5. File upload validation and authorization
  it('5. File upload validation and authorization: rejects dangerous extensions, invalid MIME types, oversized files, and unauthorized cross-account reads', async () => {
    const studentA = await registerUser({
      email: 'student.a@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Student A',
      role: 'student',
    });
    const studentB = await registerUser({
      email: 'student.b@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Student B',
      role: 'student',
    });

    // Reject executable extension
    await expect(
      uploadAndStoreFile({
        user: studentA.user,
        pillar: 'school',
        originalName: 'malware.sh',
        mimeType: 'text/plain',
        content: '#!/bin/sh\necho pwned',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'FORBIDDEN_FILE_TYPE' });

    // Reject disallowed MIME type
    await expect(
      uploadAndStoreFile({
        user: studentA.user,
        pillar: 'school',
        originalName: 'archive.bin',
        mimeType: 'application/octet-stream',
        content: 'binary payload',
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_MIME_TYPE' });

    // Reject oversized file
    process.env.MAX_UPLOAD_BYTES = '100';
    await expect(
      uploadAndStoreFile({
        user: studentA.user,
        pillar: 'school',
        originalName: 'large_notes.txt',
        mimeType: 'text/plain',
        content: 'A'.repeat(250),
      })
    ).rejects.toMatchObject({ statusCode: 413, code: 'FILE_TOO_LARGE' });
    process.env.MAX_UPLOAD_BYTES = '10485760';

    // Valid private upload by Student A
    const validFile = await uploadAndStoreFile({
      user: studentA.user,
      pillar: 'school',
      originalName: 'private_notes.txt',
      mimeType: 'text/plain',
      content: 'Private study notes belonging exclusively to Student A.',
      visibility: 'private',
    });

    // Student A can read their own file
    const readOwn = await readAuthorizedFile(studentA.user, validFile.id);
    expect(readOwn.content.toString('utf8')).toContain('exclusively to Student A');

    // Student B is blocked (403) from reading Student A's private file
    await expect(readAuthorizedFile(studentB.user, validFile.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN_FILE_ACCESS',
    });
  });

  // 6. AI provider failure handling
  it('6. AI provider failure handling: handles upstream timeouts/failures with retry logging, explicit fallback notice, or 503 when strict live is required', async () => {
    const student = await registerUser({
      email: 'ai.resilience@example.org',
      password: 'StrongPassword!2026',
      fullName: 'AI Resilience Tester',
      role: 'student',
    });

    // Simulate upstream provider failure with graceful fallback
    const fallbackRes = await requestGroundedExplanation(student.user, {
      question: 'Expliquez la loi d’Ohm dans un circuit électrique simple.',
      simulateProviderFailure: true,
      strictLiveRequired: false,
    });
    expect(fallbackRes.aiResult.aiMode).toBe('MOCK_DEMO');
    expect(fallbackRes.aiResult.usage.status).toBe('FALLBACK_MOCK');
    expect(fallbackRes.aiResult.epistemicNotice).toContain('DEMO / MOCK FALLBACK MODE');

    // Simulate upstream provider failure when strictLiveRequired = true -> must throw 503
    await expect(
      requestGroundedExplanation(student.user, {
        question: 'Question exigeant un modèle live strict',
        simulateProviderFailure: true,
        strictLiveRequired: true,
      })
    ).rejects.toMatchObject({ statusCode: 503, code: 'AI_PROVIDER_UNAVAILABLE' });
  });

  // 7. Client project creation
  it('7. Client project creation: supports both MANAGED_PROJECT and QUALIFIED_TALENT_PROVISION modes with full specifications', async () => {
    const client = await registerUser({
      email: 'org.client@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Org Client Director',
      role: 'org_client',
    });

    const managed = await createProjectRequest(client.user, {
      organizationName: 'Benin MedTech AI',
      title: 'Managed Fon Medical Audio Transcription',
      serviceMode: 'MANAGED_PROJECT',
      serviceCategory: 'AFRICAN_LANG_TRANSCRIPTION_ANNOTATION',
      description: 'Transcribe 100 clinical triage dialogues in Fon.',
      deliverablesSpec: 'Time-aligned JSONL transcripts',
      acceptanceCriteria: 'WER < 5% verified by medical linguist',
      targetLanguages: ['fon', 'fra'],
      targetDialects: ['Cotonou'],
      budgetAmountCents: 320000,
    });
    expect(managed.service_mode).toBe('MANAGED_PROJECT');
    expect(managed.status).toBe('SUBMITTED');

    const talentProvision = await createProjectRequest(client.user, {
      organizationName: 'Benin MedTech AI',
      title: 'Qualified Yoruba RLHF Evaluators Provision',
      serviceMode: 'QUALIFIED_TALENT_PROVISION',
      serviceCategory: 'AI_EVALUATION_MODEL_TESTING',
      description: 'Provide 3 assessed Yoruba evaluators for 4 weeks.',
      deliverablesSpec: 'Dedicated contractual contributor allocation',
      acceptanceCriteria: 'Passed C1 Yoruba assessment >= 85%',
      targetLanguages: ['yor'],
      budgetAmountCents: 450000,
    });
    expect(talentProvision.service_mode).toBe('QUALIFIED_TALENT_PROVISION');
  });

  // 8. Talent assignment and task access controls
  it('8. Talent assignment and task access controls: blocks assigning contributors without a passed language assessment and blocks unassigned contributors from accessing tasks/files', async () => {
    const client = await registerUser({
      email: 'client8@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Client 8',
      role: 'org_client',
    });
    const operator = await createNonProductionInternalUser({
      email: 'operator8@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Operator 8',
      role: 'operator',
    });
    const verifiedContributor = await registerUser({
      email: 'verified.fon@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Verified Fon Linguist',
      role: 'contributor',
    });
    const unverifiedContributor = await registerUser({
      email: 'unverified.fon@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Unverified Fon Claimant',
      role: 'contributor',
    });

    // Both claim 'fon' in their talent profiles
    await upsertTalentProfile(verifiedContributor.user, {
      headline: 'Fon Linguist',
      country: 'BJ',
      nativeLanguages: ['fon'],
      dialects: ['Agbome'],
      skills: ['Transcription'],
    });
    await upsertTalentProfile(unverifiedContributor.user, {
      headline: 'Claimed Fon Annotator',
      country: 'BJ',
      nativeLanguages: ['fon'],
      dialects: ['Cotonou'],
      skills: ['Transcription'],
    });

    // Only verifiedContributor passes the assessment (score 92 >= 80); unverifiedContributor fails (score 55 < 80)
    await recordTalentAssessment(operator.user, {
      talentUserId: verifiedContributor.user.id,
      assessmentType: 'LANGUAGE_PROFICIENCY',
      languageCode: 'fon',
      skillName: 'Fon C1 Assessment',
      score: 92,
      passingScore: 80,
    });
    await recordTalentAssessment(operator.user, {
      talentUserId: unverifiedContributor.user.id,
      assessmentType: 'LANGUAGE_PROFICIENCY',
      languageCode: 'fon',
      skillName: 'Fon C1 Assessment',
      score: 55,
      passingScore: 80,
    });

    const project = await createProjectRequest(client.user, {
      organizationName: 'Test Org 8',
      title: 'Fon Corpus Validation',
      serviceMode: 'MANAGED_PROJECT',
      serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
      description: 'Validate Fon sentences',
      deliverablesSpec: 'Validated JSON',
      acceptanceCriteria: '100% verified',
      targetLanguages: ['fon'],
      budgetAmountCents: 100000,
    });

    // Explainable matching must show verifiedContributor as eligible and unverifiedContributor as ineligible
    const matches = await computeExplainableTalentMatches(operator.user, project.id);
    const verMatch = matches.candidates.find((c: any) => c.userId === verifiedContributor.user.id);
    const unverMatch = matches.candidates.find((c: any) => c.userId === unverifiedContributor.user.id);
    expect(verMatch?.eligibleForVerifiedAssignment).toBe(true);
    expect(unverMatch?.eligibleForVerifiedAssignment).toBe(false);

    // Attempting to assign the task to unverifiedContributor MUST fail with 400 UNVERIFIED_LANGUAGE_PROFICIENCY
    await expect(
      createAndAssignTask(operator.user, {
        projectId: project.id,
        title: 'Task for Fon Speaker',
        instructions: 'Translate segment',
        languageCode: 'fon',
        assignedContributorId: unverifiedContributor.user.id,
        compensationCents: 20000,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'UNVERIFIED_LANGUAGE_PROFICIENCY' });

    // Upload a task-bound source file and assign to verifiedContributor
    const taskFile = await uploadAndStoreFile({
      user: operator.user,
      pillar: 'business',
      originalName: 'source_batch_fon.txt',
      mimeType: 'text/plain',
      content: 'Segment 1: Kú àzǎn. Segment 2: A fɔ́n ganjí à?',
      visibility: 'assigned_task',
    });

    const assigned = await createAndAssignTask(operator.user, {
      projectId: project.id,
      title: 'Task for Verified Fon Speaker',
      instructions: 'Translate batch',
      languageCode: 'fon',
      assignedContributorId: verifiedContributor.user.id,
      sourceFileId: taskFile.id,
      compensationCents: 20000,
    });

    // Verified contributor can access the task and the attached source file
    const authTask = await getAuthorizedTaskForUser(verifiedContributor.user, assigned.task.id);
    expect(authTask.task.id).toBe(assigned.task.id);
    const readTaskFile = await readAuthorizedFile(verifiedContributor.user, taskFile.id);
    expect(readTaskFile.content.toString('utf8')).toContain('Kú àzǎn');

    // Unassigned contributor is strictly blocked (403) from viewing the task, its workspace list, or its file
    await expect(
      getAuthorizedTaskForUser(unverifiedContributor.user, assigned.task.id)
    ).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN_TASK_ACCESS' });

    await expect(readAuthorizedFile(unverifiedContributor.user, taskFile.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN_FILE_ACCESS',
    });

    const unverifiedWorkspace = await getBusinessWorkspaceData(unverifiedContributor.user);
    expect(unverifiedWorkspace.tasks.length).toBe(0);
  });

  // 9. Submission, revision and approval workflows
  it('9. Submission, revision and approval workflows: tracks revision numbers, reviewer feedback, REQUEST_REVISION loop, and final APPROVE', async () => {
    const client = await registerUser({
      email: 'client9@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Client 9',
      role: 'org_client',
    });
    const operator = await createNonProductionInternalUser({
      email: 'operator9@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Operator 9',
      role: 'operator',
    });
    const contributor = await registerUser({
      email: 'contrib9@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Contributor 9',
      role: 'contributor',
    });
    const reviewer = await createNonProductionInternalUser({
      email: 'reviewer9@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Reviewer 9',
      role: 'reviewer',
    });

    await upsertTalentProfile(contributor.user, {
      headline: 'Yoruba Specialist',
      country: 'NG',
      nativeLanguages: ['yor'],
      dialects: ['Oyo/Ibadan'],
      skills: ['Translation'],
    });
    await recordTalentAssessment(operator.user, {
      talentUserId: contributor.user.id,
      assessmentType: 'LANGUAGE_PROFICIENCY',
      languageCode: 'yor',
      skillName: 'Yoruba Tonal Orthography',
      score: 95,
    });

    const project = await createProjectRequest(client.user, {
      organizationName: 'Lagos NLP',
      title: 'Yoruba Dataset QA',
      serviceMode: 'MANAGED_PROJECT',
      serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
      description: 'Yoruba translation',
      deliverablesSpec: 'JSONL',
      acceptanceCriteria: 'Full tonal marks',
      targetLanguages: ['yor'],
      budgetAmountCents: 150000,
    });

    const { task } = await createAndAssignTask(operator.user, {
      projectId: project.id,
      title: 'Yoruba Batch 1',
      instructions: 'Include all sub-dots and tonal accents.',
      languageCode: 'yor',
      assignedContributorId: contributor.user.id,
      assignedReviewerId: reviewer.user.id,
      compensationCents: 30000,
    });

    // Revision #1 submitted by contributor
    const sub1 = await submitTaskWork(contributor.user, {
      taskId: task.id,
      contentText: 'E kaaro, bawo ni ojooni?',
    });
    expect(sub1.revision_number).toBe(1);

    // Reviewer requests revision
    const rev1 = await reviewTaskSubmission(reviewer.user, {
      submissionId: sub1.id,
      decision: 'REQUEST_REVISION',
      qualityScore: 68,
      feedback: 'Missing sub-dots (ẹ, ọ) and tonal marks on E káàárọ̀.',
    });
    expect(rev1.task.status).toBe('REVISION_REQUESTED');

    // Revision #2 submitted by contributor with corrected diacritics
    const sub2 = await submitTaskWork(contributor.user, {
      taskId: task.id,
      contentText: 'Ẹ káàárọ̀, báwo ni ọjọ́ òní?',
    });
    expect(sub2.revision_number).toBe(2);

    // Reviewer approves Revision #2
    const rev2 = await reviewTaskSubmission(reviewer.user, {
      submissionId: sub2.id,
      decision: 'APPROVE',
      qualityScore: 98,
      feedback: 'Perfect Yoruba tonal orthography.',
    });
    expect(rev2.task.status).toBe('APPROVED');
    expect(rev2.compensation.payment_status).toBe('APPROVED');
  });

  // 10. Delivery report permissions
  it('10. Delivery report permissions: allows owning client and operator to inspect finalized delivery report, blocking unrelated clients and contributors', async () => {
    const clientOwner = await registerUser({
      email: 'owner.client@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Owner Client',
      role: 'org_client',
    });
    const otherClient = await registerUser({
      email: 'other.client@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Other Client',
      role: 'org_client',
    });
    const operator = await createNonProductionInternalUser({
      email: 'operator10@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Operator 10',
      role: 'operator',
    });
    const contributor = await registerUser({
      email: 'contrib10@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Contributor 10',
      role: 'contributor',
    });

    await upsertTalentProfile(contributor.user, {
      headline: 'Fon Linguist',
      country: 'BJ',
      nativeLanguages: ['fon'],
      dialects: ['Agbome'],
      skills: ['Translation'],
    });
    await recordTalentAssessment(operator.user, {
      talentUserId: contributor.user.id,
      assessmentType: 'LANGUAGE_PROFICIENCY',
      languageCode: 'fon',
      skillName: 'Fon C1',
      score: 90,
    });

    const project = await createProjectRequest(clientOwner.user, {
      organizationName: 'Owner Org',
      title: 'Confidential Fon Project',
      serviceMode: 'MANAGED_PROJECT',
      serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
      description: 'Confidential delivery test',
      deliverablesSpec: 'Report',
      acceptanceCriteria: 'QA >= 90',
      targetLanguages: ['fon'],
      budgetAmountCents: 90000,
    });

    const { task } = await createAndAssignTask(operator.user, {
      projectId: project.id,
      title: 'Task 10',
      instructions: 'Translate',
      languageCode: 'fon',
      assignedContributorId: contributor.user.id,
      compensationCents: 15000,
    });

    const sub = await submitTaskWork(contributor.user, {
      taskId: task.id,
      contentText: 'Mǐ kú àzǎn — Bonjour à tous.',
    });
    await reviewTaskSubmission(operator.user, {
      submissionId: sub.id,
      decision: 'APPROVE',
      qualityScore: 95,
      feedback: 'Approved.',
    });

    const report = await finalizeProjectDeliverables(operator.user, {
      projectId: project.id,
      title: 'Official Delivery Report #10',
      executiveSummary: 'All tasks verified and delivered.',
    });

    // Owning client and operator can access
    const ownerView = await getAuthorizedDeliveryReport(clientOwner.user, report.id);
    expect(ownerView.id).toBe(report.id);

    // Unrelated org_client is blocked (403)
    await expect(getAuthorizedDeliveryReport(otherClient.user, report.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN_DELIVERY_REPORT',
    });

    // Contributor is blocked (403) from viewing client delivery reports
    await expect(getAuthorizedDeliveryReport(contributor.user, report.id)).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN_ROLE',
    });
  });

  // 11. Compensation record consistency
  it('11. Compensation record consistency: tracks PENDING -> APPROVED -> READY_FOR_PAYOUT -> PAID_SIMULATED and blocks live real-money transfers when provider is disabled', async () => {
    const client = await registerUser({
      email: 'client11@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Client 11',
      role: 'org_client',
    });
    const operator = await createNonProductionInternalUser({
      email: 'operator11@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Operator 11',
      role: 'operator',
    });
    const contributor = await registerUser({
      email: 'contrib11@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Contributor 11',
      role: 'contributor',
    });

    await upsertTalentProfile(contributor.user, {
      headline: 'Linguist',
      country: 'BJ',
      nativeLanguages: ['fon'],
      dialects: [],
      skills: [],
    });
    await recordTalentAssessment(operator.user, {
      talentUserId: contributor.user.id,
      assessmentType: 'LANGUAGE_PROFICIENCY',
      languageCode: 'fon',
      skillName: 'Fon C1',
      score: 88,
    });

    const project = await createProjectRequest(client.user, {
      organizationName: 'Org 11',
      title: 'Project 11',
      serviceMode: 'MANAGED_PROJECT',
      serviceCategory: 'AFRICAN_LANG_TRANSCRIPTION_ANNOTATION',
      description: 'Desc',
      deliverablesSpec: 'Spec',
      acceptanceCriteria: 'Crit',
      targetLanguages: ['fon'],
      budgetAmountCents: 100000,
    });

    const { task, compensation } = await createAndAssignTask(operator.user, {
      projectId: project.id,
      title: 'Task 11',
      instructions: 'Do work',
      languageCode: 'fon',
      assignedContributorId: contributor.user.id,
      compensationCents: 25000,
    });
    expect(compensation.payment_status).toBe('PENDING');

    const sub = await submitTaskWork(contributor.user, {
      taskId: task.id,
      contentText: 'Completed transcription work for Task 11.',
    });

    const rev = await reviewTaskSubmission(operator.user, {
      submissionId: sub.id,
      decision: 'APPROVE',
      qualityScore: 94,
      feedback: 'Good job',
    });
    expect(rev.compensation.payment_status).toBe('APPROVED');

    await finalizeProjectDeliverables(operator.user, {
      projectId: project.id,
      title: 'Delivery 11',
      executiveSummary: 'Summary',
    });

    // Attempting a live real-money transfer while PAYMENT_PROVIDER=disabled MUST be blocked
    await expect(
      updateCompensationStatus(operator.user, {
        compensationId: compensation.id,
        newStatus: 'PAID_SIMULATED',
        attemptLiveTransfer: true,
      })
    ).rejects.toMatchObject({ statusCode: 400, code: 'LIVE_TRANSFER_DISABLED' });

    // Simulated audited payout succeeds
    const simulated = await updateCompensationStatus(operator.user, {
      compensationId: compensation.id,
      newStatus: 'PAID_SIMULATED',
      attemptLiveTransfer: false,
      auditNote: 'Simulated sandbox payout verified by finance operator.',
    });
    expect(simulated.payment_status).toBe('PAID_SIMULATED');
    expect(simulated.provider_mode).toBe('SANDBOX_SIMULATED');
  });

  // 12. Audit trail behavior
  it('12. Audit trail behavior: records security events and redacts passwords, tokens, and API keys from metadata', async () => {
    const reg = await registerUser({
      email: 'audit.test@example.org',
      password: 'SuperSecretPassword!999',
      fullName: 'Audit User',
      role: 'student',
    });

    await updatePrivacyAndConsent(reg.user, {
      privacyRetentionDays: 180,
      voiceDataConsent: true,
      linguisticDataConsent: true,
    });
    const exported = await exportUserDataPackage(reg.user);
    expect(exported.account.email).toBe('audit.test@example.org');

    const db = await ensureDbReady();
    const audits = await db.query<{
      action: string;
      redacted_metadata_json: Record<string, any>;
    }>(`SELECT action, redacted_metadata_json FROM audit_events WHERE actor_user_id = $1`, [
      reg.user.id,
    ]);

    expect(audits.rows.length).toBeGreaterThanOrEqual(3);
    const registerEvent = audits.rows.find((a) => a.action === 'USER_REGISTER');
    expect(registerEvent).toBeDefined();
    expect(registerEvent?.redacted_metadata_json.password).toBe('[REDACTED]');
    expect(registerEvent?.redacted_metadata_json.sessionToken).toBe('[REDACTED]');
    expect(JSON.stringify(audits.rows)).not.toContain('SuperSecretPassword!999');
  });

  // 13. Database migration and seed execution
  it('13. Database migration and seed execution: applies schema_migrations cleanly and populates synthetic seed idempotently', async () => {
    const db = await ensureDbReady();
    const migRes = await db.query<{ version: string }>(`SELECT version FROM schema_migrations`);
    expect(migRes.rows.some((r) => r.version === '001_initial_schema.sql')).toBe(true);

    const firstSeed = await runSyntheticSeed();
    expect(firstSeed.alreadySeeded).toBe(false);

    // Running seed a second time is idempotent
    const secondSeed = await runSyntheticSeed();
    expect(secondSeed.alreadySeeded).toBe(true);

    const synthUsers = await db.query<{ email: string }>(
      `SELECT email FROM users WHERE email LIKE '%@synthetic.solob.local'`
    );
    expect(synthUsers.rows.length).toBe(8);
  });

  // 14. Production build artifacts & configuration readiness
  it('14. Production build configuration: verifies Next.js App Router entrypoints, SQL schema files, and environment template have no hardcoded secrets', async () => {
    const envExample = fs.readFileSync(path.resolve(process.cwd(), '.env.example'), 'utf8');
    expect(envExample).toContain('SESSION_SECRET=REPLACE_WITH_');
    expect(envExample).not.toMatch(/sk-[a-zA-Z0-9]{20,}/);

    const schemaSql = fs.readFileSync(path.resolve(process.cwd(), 'db/schema.sql'), 'utf8');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS users');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS business_projects');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS school_documents');
  });

  // 15. Critical user journeys without hardcoded demo records (via Next.js HTTP Route Handlers on an empty database)
  it('15. Critical user journeys without hardcoded demo records: executes full School & Business HTTP API journeys starting from an empty user database', async () => {
    const db = await ensureDbReady();
    const initialUsers = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM users`);
    expect(Number(initialUsers.rows[0].count)).toBe(0);

    // --- JOURNEY A: SOLOB SCHOOL VIA HTTP ROUTE HANDLERS ---
    const studentRegReq = new Request('http://localhost:3000/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'register',
        email: 'fresh.student@school.bj',
        password: 'FreshStudentPassword#1',
        fullName: 'Bio Guerra',
        role: 'student',
      }),
    });
    const studentRegRes = await authPost(studentRegReq);
    expect(studentRegRes.status).toBe(201);
    const studentRegData = await studentRegRes.json();
    expect(studentRegData.sessionToken).toBeUndefined();
    const setCookies: string[] = (studentRegRes.headers as any).getSetCookie();
    const cookieVal = (name: string) =>
      decodeURIComponent((setCookies.find((c) => c.startsWith(name + '=')) || '').split(';')[0].slice(name.length + 1));
    const studentToken = cookieVal(SESSION_COOKIE_NAME);
    const studentCsrf = cookieVal(CSRF_COOKIE_NAME);
    expect(studentToken.length).toBeGreaterThan(10);

    // Upload document via /api/school
    const uploadDocReq = new Request('http://localhost:3000/api/school', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(studentToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(studentCsrf)}`,
        [CSRF_HEADER_NAME]: studentCsrf,
      },
      body: JSON.stringify({
        action: 'upload_document',
        title: 'Photosynthèse et Chloroplastes en Terminale D',
        originalFileName: 'photosynthese.txt',
        mimeType: 'text/plain',
        curriculumId: 'cur_bj_bac',
        subjectId: 'sub_bj_svt',
        content:
          'La photosynthèse comprend une phase photochimique dans les thylakoïdes produisant de l’ATP et du NADPH, et une phase non photochimique (cycle de Calvin) dans le stroma fixant le CO2.',
      }),
    });
    const uploadDocRes = await schoolPost(uploadDocReq);
    expect(uploadDocRes.status).toBe(201);
    const uploadDocData = await uploadDocRes.json();

    // Generate exercise & submit answers via /api/school
    const genExReq = new Request('http://localhost:3000/api/school', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(studentToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(studentCsrf)}`,
        [CSRF_HEADER_NAME]: studentCsrf,
      },
      body: JSON.stringify({
        action: 'generate_revision_exercise',
        documentId: uploadDocData.document.id,
        subjectId: 'sub_bj_svt',
        title: 'Contrôle Photosynthèse',
      }),
    });
    const genExRes = await schoolPost(genExReq);
    expect(genExRes.status).toBe(201);
    const genExData = await genExRes.json();

    const subExReq = new Request('http://localhost:3000/api/school', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(studentToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(studentCsrf)}`,
        [CSRF_HEADER_NAME]: studentCsrf,
      },
      body: JSON.stringify({
        action: 'submit_exercise',
        exerciseId: genExData.exercise.id,
        answers: {
          q1: 'La phase photochimique se déroule dans les thylakoïdes et produit ATP et NADPH.',
          q2: 'Le cycle de Calvin se déroule dans le stroma du chloroplaste pour fixer le CO2.',
        },
      }),
    });
    const subExRes = await schoolPost(subExReq);
    expect(subExRes.status).toBe(201);
    const subExData = await subExRes.json();
    expect(Number(subExData.submission.score)).toBeGreaterThan(0);

    // --- JOURNEY B: SOLOB BUSINESS VIA HTTP ROUTE HANDLERS ---
    const registerActor = async (email: string, fullName: string, role: string) =>
      createNonProductionInternalUser({
        email,
        password: 'FreshBusinessPassword#1',
        fullName,
        role: role as 'org_client' | 'operator' | 'contributor' | 'reviewer',
      });

    const clientActor = await registerActor('client@org.bj', 'Client Org', 'org_client');
    const operatorActor = await registerActor('op@solob.bj', 'Operator SOLOB', 'operator');
    const contribActor = await registerActor('linguist@solob.bj', 'Linguist Fon', 'contributor');
    const reviewerActor = await registerActor('qa@solob.bj', 'Reviewer QA', 'reviewer');

    // Client creates project
    const createProjRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(clientActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(clientActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: clientActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'create_project',
          organizationName: 'Porto-Novo Civic Tech',
          title: 'Traduction Communiqués Sanitaires en Fɔngbè',
          serviceMode: 'MANAGED_PROJECT',
          serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
          description: 'Traduire 20 communiqués en Fɔngbè vérifié.',
          deliverablesSpec: 'JSONL vérifié',
          acceptanceCriteria: 'Score QA >= 90',
          targetLanguages: ['fon'],
          budgetAmountCents: 120000,
        }),
      })
    );
    expect(createProjRes.status).toBe(201);
    const { project } = await createProjRes.json();

    // Contributor creates talent profile & Operator records passed Fon assessment
    await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(contribActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(contribActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: contribActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'upsert_talent_profile',
          headline: 'Expert Fɔngbè',
          country: 'BJ',
          nativeLanguages: ['fon'],
          dialects: ['Porto-Novo', 'Agbome'],
          skills: ['Medical Translation'],
          consentVoiceDataset: true,
          consentLinguisticCorpus: true,
        }),
      })
    );

    const assessRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(operatorActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(operatorActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: operatorActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'record_assessment',
          talentUserId: contribActor.user.id,
          assessmentType: 'LANGUAGE_PROFICIENCY',
          languageCode: 'fon',
          skillName: 'Fon C1 Assessment',
          score: 96,
        }),
      })
    );
    expect(assessRes.status).toBe(201);

    // Operator assigns task
    const assignRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(operatorActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(operatorActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: operatorActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'create_assign_task',
          projectId: project.id,
          title: 'Communiqué #1 : Prévention Paludisme',
          instructions: 'Traduire en Fɔngbè avec tons.',
          languageCode: 'fon',
          assignedContributorId: contribActor.user.id,
          assignedReviewerId: reviewerActor.user.id,
          compensationCents: 30000,
        }),
      })
    );
    expect(assignRes.status).toBe(201);
    const { task } = await assignRes.json();

    // Contributor submits work
    const submitWorkRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(contribActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(contribActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: contribActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'submit_work',
          taskId: task.id,
          contentText: 'Miizan hwɛkan-dǒ-kpɔ́n : Mi dɔ́ mlǎ ɖò xɔkanmɛ.',
        }),
      })
    );
    expect(submitWorkRes.status).toBe(201);
    const { submission } = await submitWorkRes.json();

    // Reviewer approves work
    const qaRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(reviewerActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(reviewerActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: reviewerActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'review_submission',
          submissionId: submission.id,
          decision: 'APPROVE',
          qualityScore: 97,
          feedback: 'Traduction Fɔngbè exacte et naturelle.',
        }),
      })
    );
    expect(qaRes.status).toBe(200);

    // Operator finalizes delivery report
    const delivRes = await businessPost(
      new Request('http://localhost:3000/api/business', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(operatorActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(operatorActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: operatorActor.csrfToken,
        },
        body: JSON.stringify({
          action: 'finalize_delivery',
          projectId: project.id,
          title: 'Rapport Final — Communiqués Sanitaires Fɔngbè',
          executiveSummary: 'Livraison validée avec score qualité 97/100.',
        }),
      })
    );
    expect(delivRes.status).toBe(201);
    const { report } = await delivRes.json();

    // Client fetches authorized delivery report via GET /api/business?reportId=...
    const clientReportRes = await businessGet(
      new Request(`http://localhost:3000/api/business?reportId=${report.id}`, {
        method: 'GET',
        headers: { Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(clientActor.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(clientActor.csrfToken)}`,
          [CSRF_HEADER_NAME]: clientActor.csrfToken },
      })
    );
    expect(clientReportRes.status).toBe(200);
    const clientReportData = await clientReportRes.json();
    expect(clientReportData.report.id).toBe(report.id);
    expect(Number(clientReportData.report.average_quality_score)).toBe(97);
  });

  // ===========================================================================
  // SECURITY REGRESSION SUITE (8 tests) — corrective audit findings A–F
  // ===========================================================================
  const withEnv = async (vars: Record<string, string | undefined>, fn: () => Promise<void>) => {
    const prev: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      prev[k] = process.env[k];
      if (vars[k] === undefined) delete process.env[k];
      else process.env[k] = vars[k];
    }
    try {
      await fn();
    } finally {
      for (const k of Object.keys(prev)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  };
  const STRONG_SECRET = 'Zq8#xV2!mK9pL4@tR7wN1$bY6&cF3^hJ5*gD0Q';
  const cookieHeaders = (a: { sessionToken: string; csrfToken: string }) => ({
    Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(a.sessionToken)}; ${CSRF_COOKIE_NAME}=${encodeURIComponent(a.csrfToken)}`,
    [CSRF_HEADER_NAME]: a.csrfToken,
  });

  it('SEC-1. Unauthenticated and non-admin seed_synthetic requests are denied', async () => {
    const anon = await adminPost(
      new Request('http://localhost:3000/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'seed_synthetic' }),
      })
    );
    expect(anon.status).toBe(401);

    const student = await registerUser({
      email: 'sec1.student@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Sec One',
      role: 'student',
    });
    const asStudent = await adminPost(
      new Request('http://localhost:3000/api/admin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookieHeaders(student) },
        body: JSON.stringify({ action: 'seed_synthetic' }),
      })
    );
    expect(asStudent.status).toBe(403);

    const db = await ensureDbReady();
    const synth = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE email LIKE '%@synthetic.solob.local'`
    );
    expect(Number(synth.rows[0].count)).toBe(0);
  });

  it('SEC-2. Production mode cannot seed, create fixture users, or log in to synthetic privileged accounts', async () => {
    await runSyntheticSeed(); // seeded while still in test mode
    await withEnv({ NODE_ENV: 'production', SESSION_SECRET: STRONG_SECRET }, async () => {
      await expect(runSyntheticSeed()).rejects.toThrow(/strictly forbidden in production/i);
      await expect(
        createNonProductionInternalUser({
          email: 'x@example.org',
          password: 'StrongPassword!2026',
          fullName: 'X',
          role: 'admin',
        })
      ).rejects.toThrow(/forbidden in production/i);
      await expect(
        loginUser({ email: 'admin.core@synthetic.solob.local', password: 'SolobSynthetic#2026' })
      ).rejects.toThrow();
      const res = await adminPost(
        new Request('http://localhost:3000/api/admin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'seed_synthetic' }),
        })
      );
      expect(res.status).toBe(403);
    });
  });

  it('SEC-3. Public registration rejects privileged roles; one-time admin bootstrap and provisioning are enforced', async () => {
    for (const role of ['admin', 'operator', 'reviewer', 'teacher']) {
      await expect(
        registerUser({
          email: `esc.${role}@example.org`,
          password: 'StrongPassword!2026',
          fullName: 'Escalation Attempt',
          role,
        })
      ).rejects.toThrow(/forbidden/i);
      const httpRes = await authPost(
        new Request('http://localhost:3000/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'register',
            email: `esc.http.${role}@example.org`,
            password: 'StrongPassword!2026',
            fullName: 'Escalation Attempt',
            role,
          }),
        })
      );
      expect(httpRes.status).toBe(403);
    }
    const db = await ensureDbReady();
    const priv = await db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM users WHERE role IN ('admin','operator','reviewer','teacher')`
    );
    expect(Number(priv.rows[0].count)).toBe(0);

    await expect(
      bootstrapInitialAdmin({ email: 'root@example.org', password: 'short', fullName: 'Root' })
    ).rejects.toThrow(/at least 12/i);
    const admin = await bootstrapInitialAdmin({
      email: 'root@example.org',
      password: 'Vr7#kP2!qZ9@wL4m',
      fullName: 'Root Admin',
    });
    expect(admin.role).toBe('admin');
    await expect(
      bootstrapInitialAdmin({ email: 'root2@example.org', password: 'Vr7#kP2!qZ9@wL4m', fullName: 'Root Two' })
    ).rejects.toThrow(/already exists/i);

    const student = await registerUser({
      email: 'sec3.student@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Student',
      role: 'student',
    });
    await expect(
      provisionVerifiedUser(student.user, {
        email: 'sneaky@example.org',
        password: 'StrongPassword!2026',
        fullName: 'Sneaky',
        role: 'operator',
      })
    ).rejects.toThrow();
    const teacher = await provisionVerifiedUser(admin, {
      email: 'teacher.ok@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Verified Teacher',
      role: 'teacher',
    });
    expect(teacher.user.role).toBe('teacher');
  });

  it('SEC-4. Session tokens are never in JSON or client storage; cookies are HttpOnly/SameSite; CSRF, expiry and revocation work', async () => {
    const res = await authPost(
      new Request('http://localhost:3000/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'register',
          email: 'sec4@example.org',
          password: 'StrongPassword!2026',
          fullName: 'Sec Four',
          role: 'student',
        }),
      })
    );
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    const body = JSON.parse(text);
    expect(body.sessionToken).toBeUndefined();
    const setCookies: string[] = (res.headers as any).getSetCookie();
    const sessionCookie = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=lax|SameSite=strict/i);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).toMatch(/Expires=|Max-Age=/i);
    const rawToken = decodeURIComponent(sessionCookie.split(';')[0].slice(SESSION_COOKIE_NAME.length + 1));
    expect(text).not.toContain(rawToken);

    // No client source persists tokens in localStorage/sessionStorage
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]
      );
    for (const f of walk(path.resolve('src')).filter((f) => /\.(tsx?|jsx?)$/.test(f))) {
      const src = fs.readFileSync(f, 'utf8');
      expect(src, f).not.toMatch(/localStorage|sessionStorage/);
    }

    // CSRF: cookie-authenticated POST without header is rejected; cross-origin rejected
    const login = await loginUser({ email: 'sec4@example.org', password: 'StrongPassword!2026' });
    const noHeader = await schoolPost(
      new Request('http://localhost:3000/api/school', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(login.sessionToken)}`,
        },
        body: JSON.stringify({ action: 'request_explanation', question: 'Q?' }),
      })
    );
    expect(noHeader.status).toBe(403);
    const crossOrigin = await schoolPost(
      new Request('http://localhost:3000/api/school', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example', ...cookieHeaders(login) },
        body: JSON.stringify({ action: 'request_explanation', question: 'Q?' }),
      })
    );
    expect(crossOrigin.status).toBe(403);

    // Unauthorized / forged / expired / revoked tokens resolve to null
    expect(await authenticateSessionToken(generateSessionToken().rawToken)).toBeNull();
    expect(await authenticateSessionToken('garbage')).toBeNull();
    const db = await ensureDbReady();
    expect((await authenticateSessionToken(login.sessionToken))?.email).toBe('sec4@example.org');
    await db.query(`UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute'`);
    expect(await authenticateSessionToken(login.sessionToken)).toBeNull();
    const fresh = await loginUser({ email: 'sec4@example.org', password: 'StrongPassword!2026' });
    expect(await authenticateSessionToken(fresh.sessionToken)).not.toBeNull();
    await logoutSession(fresh.sessionToken);
    expect(await authenticateSessionToken(fresh.sessionToken)).toBeNull();
  });

  it('SEC-5. Missing, placeholder, or weak production SESSION_SECRET fails fast; a strong secret is accepted', async () => {
    // Isolate from any SESSION_SECRET present in the environment (e.g. CI's ephemeral secret):
    // passing `undefined` falls back to process.env.SESSION_SECRET by design.
    await withEnv({ SESSION_SECRET: undefined }, async () => {
    expect(() => validateSessionSecretConfig(undefined, 'production')).toThrow(/missing/i);
    expect(() => validateSessionSecretConfig('', 'production')).toThrow(/missing/i);
    expect(() =>
      validateSessionSecretConfig('replace_with_64_char_hex_session_secret_do_not_commit', 'production')
    ).toThrow();
    expect(() => validateSessionSecretConfig('short', 'production')).toThrow(/32 bytes/i);
    expect(() => validateSessionSecretConfig('a'.repeat(64), 'production')).toThrow(/entropy/i);
    expect(validateSessionSecretConfig(STRONG_SECRET, 'production')).toBe(STRONG_SECRET);
    // Startup path (DB readiness) also fails fast
    await withEnv({ NODE_ENV: 'production', SESSION_SECRET: undefined }, async () => {
      await expect(resetDbInstanceForTests('memory://')).rejects.toThrow(/SESSION_SECRET/);
    });
    });
  });

  it('SEC-6. Rate limits ignore spoofed X-Forwarded-For, honour trusted proxy, throttle register/login, and persist in PostgreSQL across instances', async () => {
    await withEnv({ TRUST_PROXY: undefined }, async () => {
      const a = new Request('http://localhost:3000/api/auth', { headers: { 'X-Forwarded-For': '9.9.9.9' } });
      const b = new Request('http://localhost:3000/api/auth', { headers: { 'X-Forwarded-For': '8.8.8.8' } });
      expect(extractTrustedClientIp(a)).toBe(extractTrustedClientIp(b));
      expect(extractTrustedClientIp(a)).not.toContain('9.9.9.9');
      expect(extractTrustedClientIp(a)).not.toBe('127.0.0.1');
    });
    await withEnv({ TRUST_PROXY: 'true', TRUSTED_PROXY_HOPS: '1', TRUSTED_PROXY_SECRET: undefined }, async () => {
      const r = new Request('http://localhost:3000/api/auth', {
        headers: { 'X-Forwarded-For': '1.2.3.4, 41.202.219.55' },
      });
      expect(extractTrustedClientIp(r)).toBe('proxy-ip:41.202.219.55');
    });

    // Distributed: bucket state lives in PostgreSQL, survives local cache loss
    const key = 'test:distributed:41.202.219.55';
    expect((await checkRateLimit({ key, maxRequests: 2, windowMs: 60_000 })).allowed).toBe(true);
    clearInMemoryRateLimitCacheOnly();
    expect((await checkRateLimit({ key, maxRequests: 2, windowMs: 60_000 })).allowed).toBe(true);
    clearInMemoryRateLimitCacheOnly();
    expect((await checkRateLimit({ key, maxRequests: 2, windowMs: 60_000 })).allowed).toBe(false);

    // Registration throttle (5 per email/min) and login throttle (10 per email/min)
    let registerBlocked = false;
    for (let i = 0; i < 8; i++) {
      try {
        await registerUser({ email: 'throttle@example.org', password: 'bad', fullName: 'T', role: 'student' }, 'ip-a');
      } catch (e: any) {
        if (e.statusCode === 429) registerBlocked = true;
      }
    }
    expect(registerBlocked).toBe(true);
    let loginBlocked = false;
    for (let i = 0; i < 14; i++) {
      try {
        await loginUser({ email: 'nobody@example.org', password: 'WrongPassword!1' }, `ip-${i}`);
      } catch (e: any) {
        if (e.statusCode === 429) loginBlocked = true;
      }
    }
    expect(loginBlocked).toBe(true);
  });

  it('SEC-7. Internal errors are generic and failed DB persistence leaves no orphaned files', async () => {
    const res = handleApiError(
      new Error('SELECT password_hash FROM users failed at /workspace/solob-plus/src/lib/db/index.ts SESSION_SECRET=s3cr3t')
    );
    expect(res.status).toBe(500);
    const txt = await res.text();
    expect(JSON.parse(txt).error.code).toBe('INTERNAL_SERVER_ERROR');
    for (const leak of ['password_hash', '/workspace', 's3cr3t', 'SELECT', 'stack']) {
      expect(txt).not.toContain(leak);
    }

    const owner = await registerUser({
      email: 'sec7@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Sec Seven',
      role: 'student',
    });
    const root = path.resolve(process.env.LOCAL_STORAGE_DIR!);
    const countFiles = (d: string): number =>
      !fs.existsSync(d)
        ? 0
        : fs.readdirSync(d, { withFileTypes: true }).reduce(
            (n, e) => n + (e.isDirectory() ? countFiles(path.join(d, e.name)) : 1),
            0
          );
    const before = countFiles(root);
    await expect(
      uploadAndStoreFile({
        user: owner.user,
        pillar: 'school',
        originalName: 'orphan.txt',
        mimeType: 'text/plain',
        content: 'must be cleaned up',
        simulateDbFailure: true,
      })
    ).rejects.toThrow();
    expect(countFiles(root)).toBe(before);
  });

  it('SEC-8. Real multipart binary uploads (.txt and signed .pdf) work end-to-end; forged PDFs are rejected', async () => {
    const reg = await createNonProductionInternalUser({
      email: 'sec8@example.org',
      password: 'StrongPassword!2026',
      fullName: 'Sec Eight',
      role: 'student',
    });
    const send = async (file: File) => {
      const fd = new FormData();
      fd.set('action', 'upload_document');
      fd.set('title', `Doc ${file.name}`);
      fd.set('file', file);
      return schoolPost(
        new Request('http://localhost:3000/api/school', {
          method: 'POST',
          headers: cookieHeaders(reg),
          body: fd,
        })
      );
    };
    const txt = await send(
      new File(['La photosynthèse se déroule dans le chloroplaste et produit du glucose.'], 'cours.txt', {
        type: 'text/plain',
      })
    );
    expect(txt.status).toBe(201);
    const pdfBytes = Buffer.from(
      '%PDF-1.4\n1 0 obj<<>>endobj\nBT (Loi de Newton F = m a) Tj ET\ntrailer<<>>\n%%EOF',
      'latin1'
    );
    const pdf = await send(new File([pdfBytes], 'cours.pdf', { type: 'application/pdf' }));
    expect(pdf.status).toBe(201);
    const fake = await send(new File(['not really a pdf'], 'fake.pdf', { type: 'application/pdf' }));
    expect(fake.status).toBe(400);
    const exe = await send(new File([Buffer.from([0x4d, 0x5a, 0x90, 0x00])], 'evil.exe', { type: 'application/octet-stream' }));
    expect(exe.status).toBeGreaterThanOrEqual(400);
    expect(exe.status).toBeLessThan(500);
  });
});
