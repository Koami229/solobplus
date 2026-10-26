import { ensureDbReady } from '@/lib/db';
import { createId } from '@/lib/core/crypto';
import {
  AppError,
  AuthenticatedUser,
  enforceRole,
  SCHOOL_ROLES,
} from '@/lib/core/rbac';
import { uploadAndStoreFile } from '@/lib/core/storage';
import { recordAuditEvent } from '@/lib/core/audit';
import { executeGroundedAI } from '@/lib/ai/provider';

export async function ensureDefaultSchoolCatalog(): Promise<void> {
  const db = await ensureDbReady();
  const countRes = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM academic_curricula`);
  if (Number(countRes.rows[0]?.count || 0) > 0) {
    return;
  }

  // Configurable African & regional curricula with explicit verified/unverified flags
  await db.query(
    `INSERT INTO academic_curricula (id, code, name, country, education_system, verified, description)
     VALUES
       ('cur_bj_bac', 'BJ-BAC-GENERAL', 'Programme National Bénin — Enseignement Secondaire Général (BAC/BEPC)', 'BJ', 'Francophone West Africa', TRUE, 'Verified core syllabus outlines for Terminale C/D and 3ème in Benin.'),
       ('cur_waec_sss', 'WAEC-WASSCE', 'WAEC West African Senior School Certificate Examination', 'NG', 'Anglophone West Africa', TRUE, 'Verified core STEM and Humanities modules for WASSCE candidates.'),
       ('cur_sn_bac', 'SN-BAC-UEMOA', 'Programme Sénégal & Harmonisé UEMOA (Lycée)', 'SN', 'Francophone West Africa', FALSE, 'Community-contributed curriculum structure — awaiting official ministry verification.')
     ON CONFLICT (code) DO NOTHING`
  );

  await db.query(
    `INSERT INTO academic_levels (id, curriculum_id, code, name, stage_order, verified)
     VALUES
       ('lvl_bj_3e', 'cur_bj_bac', '3EME', 'Troisième (BEPC)', 1, TRUE),
       ('lvl_bj_tle_cd', 'cur_bj_bac', 'TLE-CD', 'Terminale C & D (Scientifique)', 2, TRUE),
       ('lvl_waec_ss3', 'cur_waec_sss', 'SS3', 'Senior Secondary 3 (SS3)', 3, TRUE),
       ('lvl_sn_tle', 'cur_sn_bac', 'TLE-S', 'Terminale S (Non vérifié)', 4, FALSE)
     ON CONFLICT (curriculum_id, code) DO NOTHING`
  );

  await db.query(
    `INSERT INTO academic_subjects (id, curriculum_id, level_id, code, name, category, verified)
     VALUES
       ('sub_bj_svt', 'cur_bj_bac', 'lvl_bj_tle_cd', 'SVT-TLE', 'Sciences de la Vie et de la Terre (Génétique & Écologie)', 'STEM', TRUE),
       ('sub_bj_math', 'cur_bj_bac', 'lvl_bj_tle_cd', 'MATH-TLE', 'Mathématiques (Analyse, Suites & Probabilités)', 'STEM', TRUE),
       ('sub_bj_pct', 'cur_bj_bac', 'lvl_bj_tle_cd', 'PCT-TLE', 'Physique, Chimie et Technologie', 'STEM', TRUE),
       ('sub_bj_hist', 'cur_bj_bac', 'lvl_bj_3e', 'HIST-GEO-3E', 'Histoire-Géographie (Royaumes du Danxomè & Afrique de l''Ouest)', 'HUMANITIES', TRUE),
       ('sub_waec_bio', 'cur_waec_sss', 'lvl_waec_ss3', 'WAEC-BIO', 'WASSCE Biology (Cell Physiology & Genetics)', 'STEM', TRUE),
       ('sub_sn_philo', 'cur_sn_bac', 'lvl_sn_tle', 'SN-PHILO', 'Philosophie Africaine & Épistémologie (Couverture partielle non vérifiée)', 'HUMANITIES', FALSE)
     ON CONFLICT (curriculum_id, code) DO NOTHING`
  );

  // Language registry with honest verification flags
  await db.query(
    `INSERT INTO languages_registry (code, name, native_name, region, dialects_json, school_verified, business_verified, notes)
     VALUES
       ('fra', 'French', 'Français', 'West & Central Africa', '["Standard", "Français d''Afrique de l''Ouest"]'::jsonb, TRUE, TRUE, 'Primary instructional and operational language.'),
       ('eng', 'English', 'English', 'West, East & Southern Africa', '["Standard", "West African English"]'::jsonb, TRUE, TRUE, 'Primary instructional and operational language.'),
       ('fon', 'Fon', 'Fɔngbè', 'Benin / Togo', '["Agbome", "Kpassè (Ouidah)", "Cotonou", "Porto-Novo (Gungbe border)"]'::jsonb, FALSE, TRUE, 'Business transcription/translation assessment active; School curriculum translation still unverified.'),
       ('yor', 'Yoruba', 'Èdè Yorùbá', 'Nigeria / Benin / Togo', '["Oyo/Ibadan", "Lagos", "Idatcha (Benin)", "Ijebu"]'::jsonb, FALSE, TRUE, 'Business annotation & validation supported with verified assessors.'),
       ('wol', 'Wolof', 'Wolof', 'Senegal / Gambia', '["Dakar Urban", "Cayor", "Baol"]'::jsonb, FALSE, FALSE, 'Linguistic schema configured; awaiting verified assessor cohort.'),
       ('hau', 'Hausa', 'Harshen Hausa', 'Nigeria / Niger / Ghana', '["Kano (Standard)", "Sokoto", "Zinder"]'::jsonb, FALSE, FALSE, 'Linguistic schema configured; awaiting verified dataset benchmarks.')
     ON CONFLICT (code) DO NOTHING`
  );
}

export async function getSchoolCatalog() {
  await ensureDefaultSchoolCatalog();
  const db = await ensureDbReady();
  const curricula = await db.query(`SELECT * FROM academic_curricula ORDER BY verified DESC, name ASC`);
  const levels = await db.query(`SELECT * FROM academic_levels ORDER BY stage_order ASC`);
  const subjects = await db.query(`SELECT * FROM academic_subjects ORDER BY verified DESC, name ASC`);
  const languages = await db.query(`SELECT * FROM languages_registry ORDER BY school_verified DESC, name ASC`);
  return {
    curricula: curricula.rows,
    levels: levels.rows,
    subjects: subjects.rows,
    languages: languages.rows,
  };
}

export async function upsertAcademicProfile(
  user: AuthenticatedUser | null,
  input: {
    country: string;
    curriculumId: string;
    levelId: string;
    primarySubjectId: string;
    institutionName?: string;
    learningGoals?: string;
  }
) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'UPSERT_ACADEMIC_PROFILE');
  await ensureDefaultSchoolCatalog();
  const db = await ensureDbReady();

  if (!input.country || !input.curriculumId || !input.levelId || !input.primarySubjectId) {
    throw new AppError('Country, curriculum, level, and primary subject are required.', 400, 'MISSING_PROFILE_FIELDS');
  }

  const curCheck = await db.query<{ id: string; verified: boolean; name: string }>(
    `SELECT id, verified, name FROM academic_curricula WHERE id = $1`,
    [input.curriculumId]
  );
  if (curCheck.rows.length === 0) {
    throw new AppError('Selected curriculum does not exist.', 404, 'CURRICULUM_NOT_FOUND');
  }

  const profileType = actor.role === 'teacher' ? 'teacher' : 'student';
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM academic_profiles WHERE user_id = $1`,
    [actor.id]
  );

  let profileId: string;
  if (existing.rows.length > 0) {
    profileId = existing.rows[0].id;
    await db.query(
      `UPDATE academic_profiles
       SET country = $2, curriculum_id = $3, level_id = $4, primary_subject_id = $5,
           institution_name = $6, learning_goals = $7, updated_at = NOW()
       WHERE user_id = $1`,
      [
        actor.id,
        input.country.trim(),
        input.curriculumId,
        input.levelId,
        input.primarySubjectId,
        input.institutionName?.trim() || null,
        input.learningGoals?.trim() || null,
      ]
    );
  } else {
    profileId = createId('acp');
    await db.query(
      `INSERT INTO academic_profiles (
        id, user_id, profile_type, country, curriculum_id, level_id, primary_subject_id,
        institution_name, learning_goals
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        profileId,
        actor.id,
        profileType,
        input.country.trim(),
        input.curriculumId,
        input.levelId,
        input.primarySubjectId,
        input.institutionName?.trim() || null,
        input.learningGoals?.trim() || null,
      ]
    );
  }

  await logLearningActivity({
    userId: actor.id,
    activityType: 'PROFILE_CONFIGURED',
    subjectId: input.primarySubjectId,
    referenceId: profileId,
    summary: `Academic profile configured (${curCheck.rows[0].name})`,
    progressDelta: 5,
    metadata: {
      curriculumVerified: curCheck.rows[0].verified,
      profileType,
    },
  });

  await recordAuditEvent({
    actorUserId: actor.id,
    actorRole: actor.role,
    pillar: 'school',
    action: 'ACADEMIC_PROFILE_SAVED',
    targetType: 'ACADEMIC_PROFILE',
    targetId: profileId,
    status: 'SUCCESS',
    metadata: {
      curriculumId: input.curriculumId,
      levelId: input.levelId,
      primarySubjectId: input.primarySubjectId,
    },
  });

  const saved = await db.query(
    `SELECT ap.*, c.name AS curriculum_name, c.verified AS curriculum_verified,
            l.name AS level_name, s.name AS subject_name, s.verified AS subject_verified
     FROM academic_profiles ap
     LEFT JOIN academic_curricula c ON c.id = ap.curriculum_id
     LEFT JOIN academic_levels l ON l.id = ap.level_id
     LEFT JOIN academic_subjects s ON s.id = ap.primary_subject_id
     WHERE ap.id = $1`,
    [profileId]
  );

  return saved.rows[0];
}

export async function uploadSchoolDocument(
  user: AuthenticatedUser | null,
  input: {
    title: string;
    originalFileName: string;
    mimeType: string;
    content: string | Buffer;
    curriculumId?: string | null;
    subjectId?: string | null;
    isTeacherResource?: boolean;
  }
) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'UPLOAD_SCHOOL_DOCUMENT');
  await ensureDefaultSchoolCatalog();
  if (!input.title || input.title.trim().length < 2) {
    throw new AppError('Document title is required.', 400, 'INVALID_DOCUMENT_TITLE');
  }

  const isTeacherResource = Boolean(input.isTeacherResource && (actor.role === 'teacher' || actor.role === 'admin'));
  const visibility = isTeacherResource ? 'curriculum_resource' : 'private';

  const storedFile = await uploadAndStoreFile({
    user: actor,
    pillar: 'school',
    originalName: input.originalFileName,
    mimeType: input.mimeType,
    content: input.content,
    visibility,
  });

  const rawText =
    typeof input.content === 'string'
      ? input.content
      : input.content.toString('utf8');

  const extractedText = rawText.replace(/\0/g, '').trim();
  if (extractedText.length < 10) {
    throw new AppError('Document text content is too short for academic extraction (min 10 chars).', 400, 'CONTENT_TOO_SHORT');
  }

  const wordCount = extractedText.split(/\s+/).filter(Boolean).length;
  const docId = createId('doc');
  const db = await ensureDbReady();

  await db.query(
    `INSERT INTO school_documents (
      id, user_id, file_id, curriculum_id, subject_id, title, extracted_text,
      processing_status, word_count, is_teacher_resource, verified_source
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROCESSED', $8, $9, $10)`,
    [
      docId,
      actor.id,
      storedFile.id,
      input.curriculumId ?? null,
      input.subjectId ?? null,
      input.title.trim(),
      extractedText,
      wordCount,
      isTeacherResource,
      isTeacherResource,
    ]
  );

  await logLearningActivity({
    userId: actor.id,
    activityType: 'DOCUMENT_UPLOADED',
    subjectId: input.subjectId ?? null,
    referenceId: docId,
    summary: `Uploaded and extracted academic document: "${input.title.trim()}" (${wordCount} words)`,
    progressDelta: 10,
    metadata: { fileId: storedFile.id, wordCount, isTeacherResource },
  });

  const docRes = await db.query(`SELECT * FROM school_documents WHERE id = $1`, [docId]);
  return {
    document: docRes.rows[0],
    storedFile,
  };
}

export async function requestGroundedExplanation(
  user: AuthenticatedUser | null,
  input: {
    documentId?: string | null;
    subjectId?: string | null;
    question: string;
    simulateProviderFailure?: boolean;
    strictLiveRequired?: boolean;
  }
) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'REQUEST_AI_EXPLANATION');
  await ensureDefaultSchoolCatalog();
  const db = await ensureDbReady();

  let sourceDoc: { id: string; title: string; extractedText: string; verifiedSource: boolean } | null = null;
  if (input.documentId) {
    const docRes = await db.query<{
      id: string;
      user_id: string;
      title: string;
      extracted_text: string;
      is_teacher_resource: boolean;
      verified_source: boolean;
    }>(`SELECT * FROM school_documents WHERE id = $1`, [input.documentId]);

    if (docRes.rows.length === 0) {
      throw new AppError('Referenced academic document not found.', 404, 'DOCUMENT_NOT_FOUND');
    }
    const row = docRes.rows[0];
    if (row.user_id !== actor.id && !row.is_teacher_resource && actor.role !== 'admin') {
      throw new AppError('You do not have permission to analyze another student’s private document.', 403, 'FORBIDDEN_DOCUMENT_ACCESS');
    }
    sourceDoc = {
      id: row.id,
      title: row.title,
      extractedText: row.extracted_text,
      verifiedSource: row.verified_source,
    };
  }

  const aiResult = await executeGroundedAI(
    {
      user: actor,
      pillar: 'school',
      operation: 'ACADEMIC_EXPLANATION',
      prompt: input.question,
      sourceDocument: sourceDoc,
      simulateProviderFailure: input.simulateProviderFailure,
      strictLiveRequired: input.strictLiveRequired,
    },
    ({ citations, uncertaintyLevel, epistemicNotice }) => {
      const hasGrounding = citations.length > 0;
      const primaryExcerpt = citations[0]?.excerpt || 'No uploaded document provided; answering from general academic framework with elevated uncertainty.';
      return {
        question: input.question,
        explanation: hasGrounding
          ? `Grounded Academic Explanation based on "${sourceDoc?.title}":\n\n1. Key Concept Analysis: The source document directly states: "${primaryExcerpt}".\n2. Pedagogical Breakdown: When studying this topic for examinations, focus on the causal mechanisms and definitions explicitly present in your course material.\n3. Epistemic Caution: ${epistemicNotice}`
          : `Unanchored Academic Explanation (No source document attached):\n\n1. General Principle: Your question "${input.question}" relates to core secondary/university concepts, but no verified reference document was provided.\n2. Epistemic Caution: ${epistemicNotice}`,
        keyTakeaways: citations.length > 0
          ? citations.map((c, idx) => `Source Excerpt #${idx + 1} (${c.sourceTitle}): "${c.excerpt}"`)
          : ['Upload an official course document or textbook excerpt to obtain source-grounded citations.'],
        uncertaintyLevel,
        epistemicNotice,
      };
    }
  );

  const materialId = createId('mat');
  await db.query(
    `INSERT INTO school_study_materials (
      id, user_id, document_id, subject_id, material_type, title, prompt_text,
      content_json, grounding_sources_json, uncertainty_level, ai_mode
    ) VALUES ($1, $2, $3, $4, 'EXPLANATION', $5, $6, $7::jsonb, $8::jsonb, $9, $10)`,
    [
      materialId,
      actor.id,
      sourceDoc?.id ?? null,
      input.subjectId ?? null,
      `Explication: ${input.question.slice(0, 60)}`,
      input.question,
      JSON.stringify(aiResult.data),
      JSON.stringify(aiResult.groundingCitations),
      aiResult.uncertaintyLevel,
      aiResult.aiMode,
    ]
  );

  await logLearningActivity({
    userId: actor.id,
    activityType: 'AI_EXPLANATION_GENERATED',
    subjectId: input.subjectId ?? null,
    referenceId: materialId,
    summary: `Requested grounded AI explanation: "${input.question.slice(0, 70)}"`,
    progressDelta: 8,
    metadata: {
      aiMode: aiResult.aiMode,
      uncertaintyLevel: aiResult.uncertaintyLevel,
      citationsCount: aiResult.groundingCitations.length,
    },
  });

  const saved = await db.query(`SELECT * FROM school_study_materials WHERE id = $1`, [materialId]);
  return {
    material: saved.rows[0],
    aiResult,
  };
}

export async function generateRevisionAndExercise(
  user: AuthenticatedUser | null,
  input: {
    documentId?: string | null;
    subjectId?: string | null;
    title: string;
    difficulty?: 'FOUNDATION' | 'INTERMEDIATE' | 'EXAM_LEVEL';
    materialType?: 'SUMMARY' | 'FLASHCARDS' | 'QUIZ' | 'EXAM_PREP' | 'FACT_CHECK' | 'TEACHER_ASSESSMENT';
  }
) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'GENERATE_REVISION_AND_EXERCISES');
  const db = await ensureDbReady();

  let sourceDoc: { id: string; title: string; extractedText: string; verifiedSource: boolean } | null = null;
  if (input.documentId) {
    const docRes = await db.query<{
      id: string;
      user_id: string;
      title: string;
      extracted_text: string;
      is_teacher_resource: boolean;
      verified_source: boolean;
    }>(`SELECT * FROM school_documents WHERE id = $1`, [input.documentId]);
    if (docRes.rows.length === 0) {
      throw new AppError('Academic document not found.', 404, 'DOCUMENT_NOT_FOUND');
    }
    const row = docRes.rows[0];
    if (row.user_id !== actor.id && !row.is_teacher_resource && actor.role !== 'admin') {
      throw new AppError('Unauthorized access to private document.', 403, 'FORBIDDEN_DOCUMENT_ACCESS');
    }
    sourceDoc = {
      id: row.id,
      title: row.title,
      extractedText: row.extracted_text,
      verifiedSource: row.verified_source,
    };
  }

  const materialType = input.materialType || 'SUMMARY';
  const difficulty = input.difficulty || 'INTERMEDIATE';

  const aiResult = await executeGroundedAI(
    {
      user: actor,
      pillar: 'school',
      operation: 'EXERCISE_GENERATION',
      prompt: `Generate ${materialType} and ${difficulty} exercise for: ${input.title}`,
      sourceDocument: sourceDoc,
    },
    ({ citations, uncertaintyLevel, epistemicNotice }) => {
      const refSnippet = citations[0]?.excerpt || input.title;
      const secondSnippet = citations[1]?.excerpt || refSnippet;

      const flashcards = [
        {
          front: `Concept fondamental dans "${sourceDoc?.title || input.title}"`,
          back: refSnippet,
        },
        {
          front: 'Application analytique & vérification des sources',
          back: secondSnippet,
        },
      ];

      const questions = [
        {
          id: 'q1',
          prompt: `Question 1 (Compréhension directe) : Expliquez le principe central présenté dans l'extrait : "${refSnippet.slice(0, 120)}..."`,
          expectedKeywords: extractTopKeywords(refSnippet, 4),
          maxPoints: 10,
          criterion: 'Clarté de la définition et fidélité aux termes clés du document source.',
        },
        {
          id: 'q2',
          prompt: `Question 2 (Analyse & Synthèse) : Comment ce mécanisme s'applique-t-il dans un contexte d'examen (${difficulty}) ?`,
          expectedKeywords: extractTopKeywords(secondSnippet, 4),
          maxPoints: 10,
          criterion: 'Rigueur du raisonnement logique et mobilisation pertinente des concepts du cours.',
        },
      ];

      const markingCriteria = [
        {
          id: 'crit_1',
          label: 'Exactitude conceptuelle et terminologique',
          weightPoints: 10,
          description: 'Utilisation exacte des termes scientifiques/académiques présents dans le support de cours.',
        },
        {
          id: 'crit_2',
          label: 'Argumentation structurée et justification par les sources',
          weightPoints: 10,
          description: 'Capacité à relier la réponse aux preuves textuelles sans inventer de faits non vérifiés.',
        },
      ];

      return {
        summary: `Fiche de révision structurée (${materialType}) basée sur "${sourceDoc?.title || input.title}". Extrait clé : ${refSnippet}`,
        flashcards,
        factCheckNotes: {
          sourceVerified: Boolean(sourceDoc?.verifiedSource),
          uncertaintyLevel,
          epistemicNotice,
        },
        questions,
        markingCriteria,
      };
    }
  );

  const materialId = createId('mat');
  await db.query(
    `INSERT INTO school_study_materials (
      id, user_id, document_id, subject_id, material_type, title, prompt_text,
      content_json, grounding_sources_json, uncertainty_level, ai_mode
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11)`,
    [
      materialId,
      actor.id,
      sourceDoc?.id ?? null,
      input.subjectId ?? null,
      materialType,
      input.title.trim(),
      `Generate ${materialType}`,
      JSON.stringify({
        summary: aiResult.data.summary,
        flashcards: aiResult.data.flashcards,
        factCheckNotes: aiResult.data.factCheckNotes,
      }),
      JSON.stringify(aiResult.groundingCitations),
      aiResult.uncertaintyLevel,
      aiResult.aiMode,
    ]
  );

  const exerciseId = createId('exr');
  await db.query(
    `INSERT INTO school_exercises (
      id, creator_user_id, document_id, subject_id, title, difficulty,
      questions_json, marking_criteria_json, max_score, ai_mode
    ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 20.00, $9)`,
    [
      exerciseId,
      actor.id,
      sourceDoc?.id ?? null,
      input.subjectId ?? null,
      `Exercice d'application : ${input.title.trim()}`,
      difficulty,
      JSON.stringify(aiResult.data.questions),
      JSON.stringify(aiResult.data.markingCriteria),
      aiResult.aiMode,
    ]
  );

  await logLearningActivity({
    userId: actor.id,
    activityType: 'REVISION_AND_EXERCISE_GENERATED',
    subjectId: input.subjectId ?? null,
    referenceId: exerciseId,
    summary: `Generated ${materialType} & practice exercise "${input.title.trim()}" (${difficulty})`,
    progressDelta: 12,
    metadata: { materialId, exerciseId, aiMode: aiResult.aiMode },
  });

  const materialRow = await db.query(`SELECT * FROM school_study_materials WHERE id = $1`, [materialId]);
  const exerciseRow = await db.query(`SELECT * FROM school_exercises WHERE id = $1`, [exerciseId]);

  return {
    studyMaterial: materialRow.rows[0],
    exercise: exerciseRow.rows[0],
    aiMode: aiResult.aiMode,
  };
}

function extractTopKeywords(text: string, limit = 4): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9àâçéèêëîïôûùüÿñæœ\s]/gi, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 5);
  const unique = Array.from(new Set(words));
  return unique.slice(0, limit).length > 0 ? unique.slice(0, limit) : ['concept', 'analyse'];
}

export async function submitExerciseAnswers(
  user: AuthenticatedUser | null,
  input: {
    exerciseId: string;
    answers: Record<string, string>;
  }
) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'SUBMIT_EXERCISE_ANSWERS');
  const db = await ensureDbReady();

  const exRes = await db.query<{
    id: string;
    title: string;
    subject_id: string | null;
    questions_json: Array<{
      id: string;
      prompt: string;
      expectedKeywords: string[];
      maxPoints: number;
      criterion: string;
    }>;
    marking_criteria_json: Array<{
      id: string;
      label: string;
      weightPoints: number;
      description: string;
    }>;
    max_score: string;
  }>(`SELECT * FROM school_exercises WHERE id = $1`, [input.exerciseId]);

  if (exRes.rows.length === 0) {
    throw new AppError('Exercise not found.', 404, 'EXERCISE_NOT_FOUND');
  }

  const exercise = exRes.rows[0];
  const questions = exercise.questions_json || [];
  let totalScore = 0;
  const maxScore = Number(exercise.max_score || 20);

  const detailedCorrections = questions.map((q) => {
    const rawAns = (input.answers?.[q.id] || '').trim();
    const lowerAns = rawAns.toLowerCase();
    const matchedKeywords = (q.expectedKeywords || []).filter((kw) =>
      lowerAns.includes(kw.toLowerCase())
    );

    let earned = 0;
    if (rawAns.length >= 40) {
      earned += q.maxPoints * 0.5;
    } else if (rawAns.length >= 15) {
      earned += q.maxPoints * 0.3;
    }

    const kwRatio =
      q.expectedKeywords && q.expectedKeywords.length > 0
        ? matchedKeywords.length / q.expectedKeywords.length
        : 0.5;
    earned += q.maxPoints * 0.5 * kwRatio;
    const roundedPoints = Number(Math.min(q.maxPoints, Math.max(0, earned)).toFixed(2));
    totalScore += roundedPoints;

    return {
      questionId: q.id,
      prompt: q.prompt,
      studentAnswer: rawAns,
      awardedPoints: roundedPoints,
      maxPoints: q.maxPoints,
      matchedKeywords,
      expectedKeywords: q.expectedKeywords,
      markingCriterionApplied: q.criterion,
      explanation:
        roundedPoints >= q.maxPoints * 0.7
          ? `Bonne maîtrise du critère "${q.criterion}". Termes clés mobilisés : ${matchedKeywords.join(', ') || 'argumentation cohérente'}.`
          : `Réponse partielle selon le barème "${q.criterion}". Pour obtenir la note maximale, intégrez explicitement les notions clés : ${(q.expectedKeywords || []).join(', ')}.`,
    };
  });

  totalScore = Number(Math.min(maxScore, totalScore).toFixed(2));
  const percentage = Number(((totalScore / maxScore) * 100).toFixed(2));

  const aiMode = process.env.AI_API_KEY?.trim() ? 'LIVE' : 'MOCK_DEMO';
  const uncertaintyNote =
    aiMode === 'MOCK_DEMO'
      ? '[DEMO / MOCK MODE — Correction algorithmique basée sur le barème explicite et les mots-clés extraits du cours. Faites valider toute copie officielle par votre enseignant.]'
      : '[Barème assisté par IA — Vérifiez toujours les commentaires par rapport au corrigé officiel de votre programme.]';

  const overallFeedback =
    percentage >= 75
      ? `Excellent travail (${totalScore}/${maxScore} — ${percentage}%). Les critères d'évaluation sont bien respectés.`
      : percentage >= 50
        ? `Résultat encourageant (${totalScore}/${maxScore} — ${percentage}%). Approfondissez les notions signalées dans le barème détaillé.`
        : `Résultat à consolider (${totalScore}/${maxScore} — ${percentage}%). Relisez les extraits sources du document de cours et reprenez chaque critère du barème.`;

  const submissionId = createId('sub');
  await db.query(
    `INSERT INTO school_exercise_submissions (
      id, exercise_id, student_user_id, answers_json, score, max_score, percentage,
      corrections_json, overall_feedback, uncertainty_note, ai_mode
    ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [
      submissionId,
      exercise.id,
      actor.id,
      JSON.stringify(input.answers || {}),
      totalScore,
      maxScore,
      percentage,
      JSON.stringify(detailedCorrections),
      overallFeedback,
      uncertaintyNote,
      aiMode,
    ]
  );

  await logLearningActivity({
    userId: actor.id,
    activityType: 'EXERCISE_SUBMITTED_AND_GRADED',
    subjectId: exercise.subject_id,
    referenceId: submissionId,
    summary: `Submitted answers for "${exercise.title}" — Score: ${totalScore}/${maxScore} (${percentage}%)`,
    progressDelta: 15,
    metadata: { exerciseId: exercise.id, submissionId, score: totalScore, maxScore, percentage },
  });

  const saved = await db.query(`SELECT * FROM school_exercise_submissions WHERE id = $1`, [submissionId]);
  return saved.rows[0];
}

export async function logLearningActivity(input: {
  userId: string;
  activityType: string;
  subjectId?: string | null;
  referenceId?: string | null;
  summary: string;
  durationSeconds?: number;
  progressDelta?: number;
  metadata?: Record<string, unknown>;
}) {
  const db = await ensureDbReady();
  const id = createId('act');
  await db.query(
    `INSERT INTO school_learning_activities (
      id, user_id, activity_type, subject_id, reference_id, summary, duration_seconds, progress_delta, metadata_json
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      id,
      input.userId,
      input.activityType,
      input.subjectId ?? null,
      input.referenceId ?? null,
      input.summary,
      input.durationSeconds ?? 120,
      input.progressDelta ?? 5,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return id;
}

export async function getStudentWorkspaceData(user: AuthenticatedUser | null) {
  const actor = await enforceRole(user, SCHOOL_ROLES, 'school', 'VIEW_SCHOOL_WORKSPACE');
  await ensureDefaultSchoolCatalog();
  const db = await ensureDbReady();

  const profileRes = await db.query(
    `SELECT ap.*, c.name AS curriculum_name, c.verified AS curriculum_verified,
            l.name AS level_name, s.name AS subject_name, s.verified AS subject_verified
     FROM academic_profiles ap
     LEFT JOIN academic_curricula c ON c.id = ap.curriculum_id
     LEFT JOIN academic_levels l ON l.id = ap.level_id
     LEFT JOIN academic_subjects s ON s.id = ap.primary_subject_id
     WHERE ap.user_id = $1`,
    [actor.id]
  );

  const documentsRes = await db.query(
    `SELECT * FROM school_documents
     WHERE user_id = $1 OR is_teacher_resource = TRUE
     ORDER BY created_at DESC`,
    [actor.id]
  );

  const materialsRes = await db.query(
    `SELECT * FROM school_study_materials
     WHERE user_id = $1
     ORDER BY created_at DESC`,
    [actor.id]
  );

  const exercisesRes = await db.query(
    `SELECT * FROM school_exercises
     WHERE creator_user_id = $1
        OR document_id IN (SELECT id FROM school_documents WHERE user_id = $1 OR is_teacher_resource = TRUE)
     ORDER BY created_at DESC`,
    [actor.id]
  );

  const submissionsRes = await db.query(
    `SELECT s.*, e.title AS exercise_title
     FROM school_exercise_submissions s
     JOIN school_exercises e ON e.id = s.exercise_id
     WHERE s.student_user_id = $1
     ORDER BY s.created_at DESC`,
    [actor.id]
  );

  const activitiesRes = await db.query(
    `SELECT * FROM school_learning_activities
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [actor.id]
  );

  const totalProgress = activitiesRes.rows.reduce(
    (acc, row) => acc + Number(row.progress_delta || 0),
    0
  );

  return {
    profile: profileRes.rows[0] || null,
    documents: documentsRes.rows,
    studyMaterials: materialsRes.rows,
    exercises: exercisesRes.rows,
    submissions: submissionsRes.rows,
    activities: activitiesRes.rows,
    progressSummary: {
      totalActivities: activitiesRes.rows.length,
      documentsUploaded: documentsRes.rows.filter((d) => d.user_id === actor.id).length,
      exercisesCompleted: submissionsRes.rows.length,
      averageScorePercentage:
        submissionsRes.rows.length > 0
          ? Number(
              (
                submissionsRes.rows.reduce((sum, s) => sum + Number(s.percentage || 0), 0) /
                submissionsRes.rows.length
              ).toFixed(1)
            )
          : 0,
      cumulativeProgressScore: Math.min(100, Number(totalProgress.toFixed(0))),
    },
  };
}
