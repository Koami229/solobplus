import { ensureDbReady } from './index';
import { registerUser } from '@/lib/core/auth';
import {
  ensureDefaultSchoolCatalog,
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
import { ensureDefaultFeatureFlags } from '@/lib/core/admin';
import { resetAllRateLimits } from '@/lib/core/rate-limit';

export async function runSyntheticSeed() {
  resetAllRateLimits();
  const db = await ensureDbReady();
  await ensureDefaultSchoolCatalog();
  await ensureDefaultFeatureFlags();

  const existing = await db.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM users WHERE email LIKE '%@synthetic.solob.local'`
  );
  if (Number(existing.rows[0]?.count || 0) > 0) {
    return {
      alreadySeeded: true,
      message: 'Synthetic seed accounts already exist in the database.',
    };
  }

  // 1. Register Synthetic Users across all roles (Clearly marked @synthetic.solob.local)
  const SEED_PASSWORD = 'SolobSynthetic#2026';

  const adminSession = await registerUser({
    email: 'admin@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Amina Soglo (SOLOB Core Admin)',
    role: 'admin',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const studentSession = await registerUser({
    email: 'student@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Koffi Mensah (Élève Terminale D)',
    role: 'student',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const teacherSession = await registerUser({
    email: 'teacher@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Prof. Clarisse Houngbédji (Enseignante SVT)',
    role: 'teacher',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const clientSession = await registerUser({
    email: 'client@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Dr. Tunde Adeyemi (Client Organisation NLP)',
    role: 'org_client',
    preferredUiLang: 'en',
    countryCode: 'NG',
  });

  const operatorSession = await registerUser({
    email: 'operator@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Sènakpon Dossou (SOLOB Operations Lead)',
    role: 'operator',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
  });

  const contributorFonSession = await registerUser({
    email: 'contributor.fon@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Fifamè Agbossou (Linguiste Fɔngbè & Yorùbá)',
    role: 'contributor',
    preferredUiLang: 'fr',
    countryCode: 'BJ',
    voiceDataConsent: true,
    linguisticDataConsent: true,
  });

  const contributorUnverifiedSession = await registerUser({
    email: 'contributor.unverified@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Moussa Diop (Contributeur Wolof Non-Vérifié)',
    role: 'contributor',
    preferredUiLang: 'fr',
    countryCode: 'SN',
  });

  const reviewerSession = await registerUser({
    email: 'reviewer@synthetic.solob.local',
    password: SEED_PASSWORD,
    fullName: '[SYNTHETIC] Chidinma Okafor (QA Linguistic Reviewer)',
    role: 'reviewer',
    preferredUiLang: 'en',
    countryCode: 'NG',
  });

  // 2. Seed SOLOB School Synthetic Workflow
  await upsertAcademicProfile(studentSession.user, {
    country: 'BJ',
    curriculumId: 'cur_bj_bac',
    levelId: 'lvl_bj_tle_cd',
    primarySubjectId: 'sub_bj_svt',
    institutionName: '[SYNTHETIC] Collège d’Enseignement Général Cotonou',
    learningGoals: 'Préparer l’épreuve de SVT du Baccalauréat série D (Génétique et synthèse des protéines).',
  });

  const uploadedDoc = await uploadSchoolDocument(studentSession.user, {
    title: '[SYNTHETIC COURSE] Génétique Moléculaire : De l’ADN à la Synthèse des Protéines (Terminale D)',
    originalFileName: 'synthese_proteines_tle_d.txt',
    mimeType: 'text/plain',
    curriculumId: 'cur_bj_bac',
    subjectId: 'sub_bj_svt',
    content: [
      'SYNTHETIC EDUCATIONAL SOURCE DOCUMENT — PROGRAMME NATIONAL BÉNIN TERMINALE D.',
      'La synthèse des protéines s’effectue en deux étapes complémentaires : la transcription dans le noyau et la traduction dans le cytoplasme au niveau des ribosomes.',
      'Lors de la transcription, l’ARN polymérase copie le brin transcrit de l’ADN en un brin d’ARN messager (ARNm) en respectant la complémentarité des bases azotées (Adénine-Uracile, Guanine-Cytosine).',
      'Lors de la traduction, chaque triplet de nucléotides de l’ARNm, appelé codon, correspond à un acide aminé spécifique apporté par un ARN de transfert (ARNt) portant l’anticodon complémentaire.',
      'Une mutation ponctuelle par substitution, délétion ou insertion sur le gène peut modifier la séquence polypeptidique et altérer la fonction biologique de la protéine, comme dans le cas de la drépanocytose (hémoglobine HbS).',
    ].join('\n\n'),
  });

  await requestGroundedExplanation(studentSession.user, {
    documentId: uploadedDoc.document.id,
    subjectId: 'sub_bj_svt',
    question: 'Quel est le rôle de l’ARN messager et des ribosomes entre la transcription et la traduction ?',
  });

  const revAndEx = await generateRevisionAndExercise(studentSession.user, {
    documentId: uploadedDoc.document.id,
    subjectId: 'sub_bj_svt',
    title: '[SYNTHETIC] Révision BAC : Transcription, Traduction et Drépanocytose',
    difficulty: 'EXAM_LEVEL',
    materialType: 'EXAM_PREP',
  });

  await submitExerciseAnswers(studentSession.user, {
    exerciseId: revAndEx.exercise.id,
    answers: {
      q1: 'La synthèse des protéines comprend la transcription dans le noyau par l’ARN polymérase produisant l’ARNm, suivie de la traduction par les ribosomes dans le cytoplasme.',
      q2: 'Une mutation ponctuelle sur le brin d’ADN modifie le codon de l’ARNm et la séquence d’acides aminés, ce qui explique l’apparition de l’hémoglobine HbS dans la drépanocytose.',
    },
  });

  // 3. Seed SOLOB Business Synthetic Workflow
  await upsertTalentProfile(contributorFonSession.user, {
    headline: '[SYNTHETIC] Spécialiste Transcription & Validation Linguistique Fɔngbè / Français',
    country: 'BJ',
    nativeLanguages: ['fon', 'yor', 'fra'],
    dialects: ['Agbome', 'Cotonou', 'Idatcha (Benin)'],
    skills: ['Phonetic Transcription', 'Medical & Agricultural Terminology Translation', 'RLHF Evaluation'],
    workSamples: [
      {
        title: '[SYNTHETIC SAMPLE] Corpus Audio-Texte Fɔngbè Santé Communautaire',
        description: 'Transcription orthographique normalisée avec tons marqués.',
        language: 'fon',
      },
    ],
    availabilityHoursPerWeek: 30,
    availabilityStatus: 'AVAILABLE',
    consentVoiceDataset: true,
    consentLinguisticCorpus: true,
  });

  await upsertTalentProfile(contributorUnverifiedSession.user, {
    headline: '[SYNTHETIC] Annotateur Multilingue (Évaluation en attente)',
    country: 'SN',
    nativeLanguages: ['wol', 'fon'],
    dialects: ['Dakar Urban'],
    skills: ['Text Classification'],
    availabilityHoursPerWeek: 15,
    availabilityStatus: 'PARTIALLY_AVAILABLE',
    consentVoiceDataset: false,
    consentLinguisticCorpus: true,
  });

  // Record verified assessments for Fifamè (passes Fon and Domain Skill) and failed assessment for Moussa
  await recordTalentAssessment(operatorSession.user, {
    talentUserId: contributorFonSession.user.id,
    assessmentType: 'LANGUAGE_PROFICIENCY',
    languageCode: 'fon',
    dialect: 'Agbome / Cotonou',
    skillName: 'Orthographe tonale et traduction Fɔngbè C1',
    score: 94,
    passingScore: 80,
    notes: '[SYNTHETIC ASSESSMENT] Maîtrise vérifiée des diacritiques tonals et de la syntaxe Fɔngbè.',
  });

  await recordTalentAssessment(operatorSession.user, {
    talentUserId: contributorFonSession.user.id,
    assessmentType: 'DOMAIN_SKILL',
    languageCode: 'fon',
    skillName: 'Annotation & Évaluation de réponses IA (RLHF)',
    score: 91,
    passingScore: 75,
    notes: '[SYNTHETIC ASSESSMENT] Excellente précision sur le protocole d’assurance qualité.',
  });

  await recordTalentAssessment(operatorSession.user, {
    talentUserId: contributorUnverifiedSession.user.id,
    assessmentType: 'LANGUAGE_PROFICIENCY',
    languageCode: 'fon',
    skillName: 'Orthographe tonale et traduction Fɔngbè C1',
    score: 48,
    passingScore: 80,
    notes: '[SYNTHETIC ASSESSMENT] Score insuffisant ; statut Fɔngbè maintenu NON-VÉRIFIÉ.',
  });

  const managedProject = await createProjectRequest(clientSession.user, {
    organizationName: '[SYNTHETIC ORG] WestAfrica AgriTech AI Lab',
    organizationCountry: 'NG',
    organizationIndustry: 'Agricultural Advisory AI',
    title: '[SYNTHETIC PROJECT] Corpus de Validation Linguistique Fɔngbè — Conseils Agricoles Vocaux',
    serviceMode: 'MANAGED_PROJECT',
    serviceCategory: 'TRANSLATION_LINGUISTIC_VALIDATION',
    description:
      'Données synthétiques de démonstration : Validation et transcription de 50 segments d’instructions agricoles en Fɔngbè (dialectes Agbome & Cotonou) avec équivalents français.',
    deliverablesSpec: 'Fichier JSONL vérifié contenant la transcription tonale Fɔngbè, la glose française et les métadonnées dialectales.',
    acceptanceCriteria: 'Score qualité QA >= 90/100, exactitude tonale vérifiée par un réviseur senior, zéro traduction automatique brute non relue.',
    targetLanguages: ['fon', 'fra'],
    targetDialects: ['Agbome', 'Cotonou'],
    budgetAmountCents: 240000,
    currency: 'USD',
    deadlineDate: '2026-12-15',
  });

  await reviewProjectRequest(operatorSession.user, {
    projectId: managedProject.id,
    newStatus: 'APPROVED_ACTIVE',
    operatorNotes: '[SYNTHETIC OPERATOR REVIEW] Cahier des charges validé et critères d’acceptation confirmés.',
  });

  const assigned = await createAndAssignTask(operatorSession.user, {
    projectId: managedProject.id,
    title: '[SYNTHETIC TASK #1] Validation & Transcription Segment Agro-Climatique (Fɔngbè -> Français)',
    instructions:
      'Traduire et annoter les consignes de semis du maïs en période de pluie irrégulière en Fɔngbè standardisé (Agbome/Cotonou) avec notation tonale.',
    languageCode: 'fon',
    dialect: 'Agbome',
    assignedContributorId: contributorFonSession.user.id,
    assignedReviewerId: reviewerSession.user.id,
    compensationCents: 45000,
    currency: 'USD',
    dueDate: '2026-11-20',
  });

  const submission1 = await submitTaskWork(contributorFonSession.user, {
    taskId: assigned.task.id,
    contentText:
      'Fɔngbè: Ényí jǐ ɖò jijɛ wɛ gbɛ̌dɛ́gbɛ̌dɛ́ ǎ ɔ, mi ná dó gbade ɔ́ ɖò ayikúngban e mɛ sin nɔ́ cí é. | Français: Lorsque les pluies sont irrégulières, semez le maïs dans les parcelles retenant l’humidité.',
    structuredPayload: {
      segmentId: 'SYN-FON-001',
      tonalDiacriticsChecked: true,
      register: 'Agricultural Extension Advisory',
    },
    dialect: 'Agbome',
    contributorNotes: '[SYNTHETIC SUBMISSION] Vérification tonale effectuée selon le guide orthographique.',
  });

  await reviewTaskSubmission(reviewerSession.user, {
    submissionId: submission1.id,
    decision: 'APPROVE',
    qualityScore: 96,
    accuracyScore: 97,
    linguisticFidelityScore: 95,
    disagreementFlag: false,
    feedback: '[SYNTHETIC QA REVIEW] Transcription tonale Fɔngbè irréprochable et fidélité sémantique complète.',
  });

  await finalizeProjectDeliverables(operatorSession.user, {
    projectId: managedProject.id,
    title: '[SYNTHETIC DELIVERY REPORT] Rapport de Livraison Final — Corpus Fɔngbè Conseils Agricoles',
    executiveSummary:
      'Ce rapport synthétique atteste que les segments Fɔngbè ont été produits par des linguistes ayant réussi l’évaluation de compétence vérifiée et validés par l’équipe QA SOLOB Business.',
  });

  return {
    alreadySeeded: false,
    message: 'Synthetic seed completed successfully with clearly labeled non-production data.',
    credentialsNote: `All synthetic accounts use password: ${SEED_PASSWORD} (for local testing/inspection only).`,
    accounts: [
      'admin@synthetic.solob.local (admin)',
      'student@synthetic.solob.local (student)',
      'teacher@synthetic.solob.local (teacher)',
      'client@synthetic.solob.local (org_client)',
      'operator@synthetic.solob.local (operator)',
      'contributor.fon@synthetic.solob.local (contributor - verified Fon)',
      'contributor.unverified@synthetic.solob.local (contributor - unverified)',
      'reviewer@synthetic.solob.local (reviewer)',
    ],
  };
}
