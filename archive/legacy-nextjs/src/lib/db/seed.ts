import { ensureDbReady } from './index';
import { createNonProductionInternalUser } from '@/lib/core/auth';
import { AppError } from '@/lib/core/http';
import { recordAuditEvent } from '@/lib/core/audit';
import { resetAllRateLimits } from '@/lib/core/rate-limit';
import {
  generateRevisionAndExercise,
  requestGroundedExplanation,
  submitExerciseAnswers,
  uploadSchoolDocument,
  upsertAcademicProfile,
} from '@/lib/school/service';
import {
  createAndAssignTask,
  createProjectRequest,
  finalizeProjectDeliverables,
  recordTalentAssessment,
  reviewProjectRequest,
  reviewTaskSubmission,
  submitTaskWork,
  upsertTalentProfile,
} from '@/lib/business/service';

/**
 * Seeds clearly labeled SYNTHETIC development/test records across SOLOB School, SOLOB Business, and SOLOB Core.
 * Strictly forbidden when `NODE_ENV === 'production'`.
 * Idempotent: if synthetic accounts already exist, returns summary without duplicating.
 */
export async function runSyntheticSeed(): Promise<{
  seeded: boolean;
  alreadySeeded: boolean;
  syntheticAccounts: { role: string; email: string; passwordHint: string }[];
}> {
  if (process.env.NODE_ENV === 'production') {
    await recordAuditEvent({
      actorUserId: null,
      actorRole: null,
      pillar: 'core',
      action: 'SYNTHETIC_SEED_BLOCKED_IN_PRODUCTION',
      targetType: 'system',
      status: 'DENIED',
    });
    throw new AppError(
      'Synthetic account and data seeding is strictly forbidden in production.',
      403,
      'SEED_FORBIDDEN_IN_PRODUCTION'
    );
  }

  const db = await ensureDbReady();
  await resetAllRateLimits();

  const existing = await db.query<{ id: string }>(
    `SELECT id FROM users WHERE email = 'student.amina@synthetic.solob.local'`
  );

  const defaultPass = 'SolobSynthetic#2026';
  const accountSummary = [
    { role: 'student', email: 'student.amina@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'teacher', email: 'teacher.mensah@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'org_client', email: 'client.waxangari@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'contributor', email: 'talent.fifame@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'contributor', email: 'talent.adebayo@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'reviewer', email: 'reviewer.kossi@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'operator', email: 'operator.solob@synthetic.solob.local', passwordHint: defaultPass },
    { role: 'admin', email: 'admin@synthetic.solob.local', passwordHint: defaultPass },
  ];

  if (existing.rows.length > 0) {
    return {
      seeded: true,
      alreadySeeded: true,
      syntheticAccounts: accountSummary,
    };
  }

  // 1. Create Synthetic Users via non-production internal helper
  const studentAmina = await createNonProductionInternalUser({
    email: 'student.amina@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Amina Dossou (Terminale D — Cotonou)',
    role: 'student',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const teacherMensah = await createNonProductionInternalUser({
    email: 'teacher.mensah@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Prof. Coovi Mensah (Enseignant SVT & PCT)',
    role: 'teacher',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const clientOrg = await createNonProductionInternalUser({
    email: 'client.waxangari@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Waxangari Health AI Lab (Client Organization)',
    role: 'org_client',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const talentFifame = await createNonProductionInternalUser({
    email: 'talent.fifame@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Fifamè Hounkpatin (Linguiste Fɔngbè & Français)',
    role: 'contributor',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
    voiceDataConsent: true,
    linguisticDataConsent: true,
  });

  const talentAdebayo = await createNonProductionInternalUser({
    email: 'talent.adebayo@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Adebayo Ogunleye (Spécialiste Yorùbá & NLP)',
    role: 'contributor',
    preferredUiLang: 'en',
    countryCode: 'NG',
    voiceDataConsent: true,
    linguisticDataConsent: true,
  });

  const reviewerKossi = await createNonProductionInternalUser({
    email: 'reviewer.kossi@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Dr. Kossi Agbodjan (QA Linguistique Senior)',
    role: 'reviewer',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const operatorSolob = await createNonProductionInternalUser({
    email: 'operator.solob@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] Sèdjro Akplogan (SOLOB Business Operations Lead)',
    role: 'operator',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  await createNonProductionInternalUser({
    email: 'admin@synthetic.solob.local',
    password: defaultPass,
    fullName: '[SYNTHETIC] SOLOB+ Platform Administrator',
    role: 'admin',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  // 2. Seed SOLOB School Workflow
  await upsertAcademicProfile(studentAmina.user, {
    country: 'BJ',
    curriculumId: 'cur_bj_bac',
    levelId: 'lvl_bj_tle_cd',
    primarySubjectId: 'sub_bj_svt',
    institutionName: 'Collège Père Aupiais (Cotonou) [SYNTHETIC]',
    learningGoals: 'Réussir l’épreuve de SVT et Mathématiques au BAC Série D avec mention.',
  });

  await upsertAcademicProfile(teacherMensah.user, {
    country: 'BJ',
    curriculumId: 'cur_bj_bac',
    levelId: 'lvl_bj_tle_cd',
    primarySubjectId: 'sub_bj_svt',
    institutionName: 'Lycée Béhanzin (Porto-Novo) [SYNTHETIC]',
    learningGoals: 'Conception de séquences pédagogiques et barèmes BAC.',
  });

  const docResult = await uploadSchoolDocument(teacherMensah.user, {
    title: '[SYNTHETIC] Cours SVT Terminale D : Transmission de l’information génétique et synthèse des protéines',
    originalFileName: 'svt_tle_d_genetique_synthese_proteines.txt',
    mimeType: 'text/plain',
    curriculumId: 'cur_bj_bac',
    subjectId: 'sub_bj_svt',
    isTeacherResource: true,
    content: `CHAPITRE : LA SYNTHÈSE DES PROTÉINES ET LE CODE GÉNÉTIQUE (PROGRAMME NATIONAL BÉNIN - TERMINALE D)
1. La transcription se déroule dans le noyau chez les eucaryotes. L'enzyme ARN polymérase synthétise un brin d'ARN messager (ARNm) complémentaire du brin transcrit de l'ADN. Dans l'ARN, l'uracile (U) remplace la thymine (T).
2. Le code génétique est universel, redondant (dégénéré) et non chevauchant. Chaque triplet de nucléotides de l'ARNm forme un codon qui correspond à un acide aminé précis ou à un codon stop (UAA, UAG, UGA). Le codon initiateur est AUG (Méthionine).
3. La traduction a lieu dans le cytoplasme au niveau des ribosomes. Elle comporte trois étapes : l'initiation (fixation sur AUG), l'élongation (intervention des ARNt porteurs d'anticodons et formation de liaisons peptidiques) et la terminaison (rencontre d'un codon stop).
4. Une mutation ponctuelle par substitution, délétion ou insertion sur le gène peut modifier la séquence polypeptidique (exemple : la drépanocytose où l'acide glutamique est remplacé par la valine sur la chaîne bêta de l'hémoglobine).`,
  });

  await requestGroundedExplanation(studentAmina.user, {
    documentId: docResult.document.id,
    subjectId: 'sub_bj_svt',
    question: 'Quelles sont les étapes de la synthèse des protéines et comment une mutation provoque-t-elle la drépanocytose ?',
  });

  const exResult = await generateRevisionAndExercise(studentAmina.user, {
    documentId: docResult.document.id,
    subjectId: 'sub_bj_svt',
    title: '[SYNTHETIC] Évaluation BAC Série D : Transcription, Traduction & Drépanocytose',
    difficulty: 'EXAM_LEVEL',
    materialType: 'EXAM_PREP',
  });

  await submitExerciseAnswers(studentAmina.user, {
    exerciseId: exResult.exercise.id,
    answers: {
      q1: 'La transcription a lieu dans le noyau grâce à l’ARN polymérase qui produit un ARNm où l’uracile remplace la thymine. Le code génétique associe chaque codon de trois nucléotides à un acide aminé.',
      q2: 'La traduction se fait dans le cytoplasme par les ribosomes (initiation sur AUG, élongation avec les ARNt et liaisons peptidiques, terminaison sur un codon stop). Dans la drépanocytose, une mutation remplace l’acide glutamique par la valine sur l’hémoglobine.',
    },
  });

  // 3. Seed SOLOB Business Workflow
  await upsertTalentProfile(talentFifame.user, {
    headline: 'Linguiste certifiée Fɔngbè / Français — Transcription médicale & corpus IA',
    country: 'BJ',
    nativeLanguages: ['fon', 'fra'],
    dialects: ['Agbome', 'Cotonou', 'Porto-Novo (Gungbe-adjacent)'],
    skills: ['Transcription', 'Medical Terminology', 'RLHF Evaluation', 'Audio Alignment'],
    workSamples: [{ title: 'Corpus Santé Maternelle Fɔngbè (500 énoncés)', description: 'Healthcare', language: 'fon' }],
    availabilityHoursPerWeek: 30,
    availabilityStatus: 'AVAILABLE',
    consentVoiceDataset: true,
    consentLinguisticCorpus: true,
  });

  await upsertTalentProfile(talentAdebayo.user, {
    headline: 'Yorùbá Computational Linguist & Tonal Diacritics QA Specialist',
    country: 'NG',
    nativeLanguages: ['yor', 'eng'],
    dialects: ['Standard Yoruba', 'Idatcha', 'Oyo/Ibadan'],
    skills: ['Translation', 'Tonal Orthography', 'LLM Red-Teaming', 'NER Annotation'],
    workSamples: [{ title: 'Yoruba-English Financial Inclusion Dataset', description: 'FinTech', language: 'yor' }],
    availabilityHoursPerWeek: 25,
    availabilityStatus: 'AVAILABLE',
    consentVoiceDataset: true,
    consentLinguisticCorpus: true,
  });

  await recordTalentAssessment(operatorSolob.user, {
    talentUserId: talentFifame.user.id,
    assessmentType: 'LANGUAGE_PROFICIENCY',
    languageCode: 'fon',
    dialect: 'Cotonou',
    skillName: 'Orthographe tonale Fɔngbè & Transcription clinique C1',
    score: 94.5,
    passingScore: 80,
    notes: 'Maîtrise parfaite des tons et des caractères ɔ, ɖ, ɛ en Fɔngbè.',
  });

  await recordTalentAssessment(operatorSolob.user, {
    talentUserId: talentFifame.user.id,
    assessmentType: 'LANGUAGE_PROFICIENCY',
    languageCode: 'fra',
    dialect: 'Standard',
    skillName: 'Français médical & traduction bilingue',
    score: 96.0,
    passingScore: 80,
    notes: 'Excellence rédactionnelle.',
  });

  await recordTalentAssessment(operatorSolob.user, {
    talentUserId: talentAdebayo.user.id,
    assessmentType: 'LANGUAGE_PROFICIENCY',
    languageCode: 'yor',
    dialect: 'Standard Yoruba',
    skillName: 'Yorùbá Tonal Marking & Corpus Validation C1',
    score: 92.0,
    passingScore: 80,
    notes: 'Verified full diacritic accuracy.',
  });

  const projectManaged = await createProjectRequest(clientOrg.user, {
    organizationName: '[SYNTHETIC] Waxangari Health AI Lab',
    organizationCountry: 'BJ',
    organizationIndustry: 'Healthcare AI & Triage',
    title: '[SYNTHETIC] Corpus Bilingue Fɔngbè–Français : Triage Pédiatrique & Symptômes',
    serviceMode: 'MANAGED_PROJECT',
    serviceCategory: 'AFRICAN_LANG_TRANSCRIPTION_ANNOTATION',
    description:
      'Production et validation linguistique d’un corpus de 250 dialogues cliniques mère-soignant en Fɔngbè (dialectes Cotonou et Agbome) avec traduction française alignée.',
    deliverablesSpec: 'Fichier JSONL structuré avec transcription tonale Fɔngbè, traduction française et étiquettes de sévérité.',
    acceptanceCriteria: 'Score qualité QA >= 90/100, validation par réviseur linguiste senior, respect strict des diacritiques Fɔngbè.',
    targetLanguages: ['fon', 'fra'],
    targetDialects: ['Cotonou', 'Agbome'],
    budgetAmountCents: 450000,
    currency: 'USD',
    deadlineDate: '2026-12-15',
  });

  await createProjectRequest(clientOrg.user, {
    organizationName: '[SYNTHETIC] Waxangari Health AI Lab',
    organizationCountry: 'BJ',
    organizationIndustry: 'Healthcare AI & Triage',
    title: '[SYNTHETIC] Mise à disposition d’évaluateurs RLHF Yorùbá & Anglais',
    serviceMode: 'QUALIFIED_TALENT_PROVISION',
    serviceCategory: 'AI_EVALUATION_MODEL_TESTING',
    description: 'Allocation dédiée de 2 linguistes Yorùbá certifiés pour tester la sécurité des réponses médicales d’un LLM.',
    deliverablesSpec: '25h/semaine d’évaluation contradictoire et grilles de préférence RLHF.',
    acceptanceCriteria: 'Talents ayant validé l’évaluation Yorùbá C1 >= 85%.',
    targetLanguages: ['yor', 'eng'],
    targetDialects: ['Standard Yoruba'],
    budgetAmountCents: 380000,
    currency: 'USD',
    deadlineDate: '2026-12-30',
  });

  await reviewProjectRequest(operatorSolob.user, {
    projectId: projectManaged.id,
    newStatus: 'IN_EXECUTION',
    estimatedCostCents: 420000,
    operatorNotes: 'Projet approuvé par SOLOB Operations. Équipe Fɔngbè qualifiée mobilisée.',
  });

  const taskCreated = await createAndAssignTask(operatorSolob.user, {
    projectId: projectManaged.id,
    title: '[SYNTHETIC] Lot #01 — Transcription & Traduction Triage Fièvre Pédiatrique (Fɔngbè -> Français)',
    instructions:
      'Transcrire fidèlement l’énoncé en Fɔngbè avec les tons et caractères spéciaux (ɔ, ɖ, ɛ), puis fournir la traduction française médicale exacte et l’annotation d’urgence.',
    languageCode: 'fon',
    dialect: 'Cotonou',
    assignedContributorId: talentFifame.user.id,
    assignedReviewerId: reviewerKossi.user.id,
    compensationCents: 45000,
    currency: 'USD',
    dueDate: '2026-11-20',
  });

  const submission = await submitTaskWork(talentFifame.user, {
    taskId: taskCreated.task.id,
    contentText:
      'Fɔngbè: "Vǐ ceኮ ɖò zozo jí sín نخзан, é nɔ́ ɖu nǔ ǎ bɔ lanmɛ tɔn gbɔjɛ." | Français: "Mon enfant a une forte fièvre depuis hier soir, il refuse de s’alimenter et présente une asthénie marquée."',
    structuredPayload: {
      utteranceId: 'utt_bj_fon_001',
      sourceLang: 'fon',
      dialect: 'Cotonou',
      triageUrgency: 'HIGH_PRIORITY_PEDIATRIC',
      verifiedDiacritics: true,
    },
    contributorNotes: 'Vérification tonale effectuée selon le standard orthographique national du Bénin.',
  });

  await reviewTaskSubmission(reviewerKossi.user, {
    submissionId: submission.id,
    decision: 'APPROVE',
    qualityScore: 96.5,
    accuracyScore: 98.0,
    linguisticFidelityScore: 95.0,
    feedback:
      'Excellente précision terminologique et respect rigoureux de la syntaxe Fɔngbè de Cotonou. Lot #01 approuvé pour livraison.',
  });

  await finalizeProjectDeliverables(operatorSolob.user, {
    projectId: projectManaged.id,
    title: '[SYNTHETIC] Rapport de Livraison Qualité #1 — Corpus Triage Pédiatrique Fɔngbè–Français',
    executiveSummary:
      'Le Lot #01 du corpus bilingue Fɔngbè–Français a été produit par un linguiste certifié (score évaluation 94.5%) et validé en assurance qualité avec un score de 96.5/100.',
  });

  await resetAllRateLimits();

  return {
    seeded: true,
    alreadySeeded: false,
    syntheticAccounts: accountSummary,
  };
}
