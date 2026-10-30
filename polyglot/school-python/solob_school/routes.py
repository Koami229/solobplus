"""SOLOB School academic features (port of src/lib/school/service.ts): documents, grounded explanations,
revision + exercise generation (deterministic MOCK_DEMO), exercise submission graded by the C++ engine."""
from __future__ import annotations
import base64, binascii, json, math, os, secrets, time
from typing import Any, Callable, Optional
import psycopg
from fastapi import Depends, FastAPI
from pydantic import BaseModel, Field
from . import grader, grounding, storage
from .errors import AppError

RATE_SQL = """
INSERT INTO rate_limit_buckets AS b (bucket_key, hit_count, window_start, window_ms, updated_at)
VALUES (%(k)s, 1, clock_timestamp(), %(w)s, clock_timestamp())
ON CONFLICT (bucket_key) DO UPDATE SET
  hit_count = CASE WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN 1
                   ELSE LEAST(b.hit_count + 1, %(m)s::integer + 1) END,
  window_start = CASE WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN clock_timestamp() ELSE b.window_start END,
  window_ms = CASE WHEN b.window_start + (b.window_ms * INTERVAL '1 millisecond') <= clock_timestamp() THEN EXCLUDED.window_ms ELSE b.window_ms END,
  updated_at = clock_timestamp()
RETURNING hit_count,
  GREATEST(0, CEIL(EXTRACT(EPOCH FROM (window_start + (window_ms * INTERVAL '1 millisecond') - clock_timestamp())) * 1000))::bigint AS retry"""

MATERIAL_TYPES = {"SUMMARY", "FLASHCARDS", "QUIZ", "EXAM_PREP", "FACT_CHECK", "TEACHER_ASSESSMENT"}
DIFFICULTIES = {"FOUNDATION", "INTERMEDIATE", "EXAM_LEVEL"}
MODEL = "solob-grounded-tutor-v1"

def nid(p: str) -> str: return f"{p}_{secrets.token_hex(12)}"
def jfix(x: float) -> float:  # Number(x.toFixed(2)) for non-negative values
    return math.floor(x * 100 + 0.5) / 100

class DocumentIn(BaseModel):
    title: str = Field(default="", max_length=200)
    originalFileName: str = Field(default="", max_length=400)
    mimeType: Optional[str] = Field(default=None, max_length=100)
    content: Optional[str] = None          # plain text body
    contentBase64: Optional[str] = None    # binary body (PDF, audio)
    curriculumId: Optional[str] = Field(default=None, max_length=64)
    subjectId: Optional[str] = Field(default=None, max_length=64)
    isTeacherResource: bool = False

class ExplainIn(BaseModel):
    question: str = ""
    documentId: Optional[str] = Field(default=None, max_length=64)
    subjectId: Optional[str] = Field(default=None, max_length=64)
    simulateProviderFailure: bool = False
    strictLiveRequired: bool = False

class GenerateIn(BaseModel):
    title: str = Field(default="", max_length=200)
    documentId: Optional[str] = Field(default=None, max_length=64)
    subjectId: Optional[str] = Field(default=None, max_length=64)
    difficulty: Optional[str] = None
    materialType: Optional[str] = None

class SubmitIn(BaseModel):
    exerciseId: str = Field(default="", max_length=64)
    answers: dict[str, str] = Field(default_factory=dict)

def activity(c, uid, typ, subject, ref, summary, progress, meta):
    c.execute("""INSERT INTO school_learning_activities (id,user_id,activity_type,subject_id,reference_id,summary,progress_delta,metadata_json)
                 VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)""", (nid("act"), uid, typ, subject, ref, summary[:500], progress, json.dumps(meta)))

def audit(c, a, action, ttype, tid, status, meta):
    c.execute("""INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json)
                 VALUES (%s,%s,%s,'school',%s,%s,%s,%s,%s::jsonb)""", (nid("aud"), a.id, a.role, action, ttype, tid, status, json.dumps(meta)))

def register(app: FastAPI, db_url_fn: Callable[[], str], actor_dep, any_role_actor_dep) -> None:
    def conn(autocommit=False):
        url = db_url_fn()
        if not url: raise AppError(503, "DATABASE_UNAVAILABLE", "School database is not configured.")
        return psycopg.connect(url, autocommit=autocommit, row_factory=psycopg.rows.dict_row)

    def rate_limit(key: str, maximum: int, window_ms: int = 60_000):
        try:
            with conn(autocommit=True) as c:  # committed independently: a failing request still consumes a hit
                r = c.execute(RATE_SQL, {"k": key, "w": window_ms, "m": maximum}).fetchone()
        except psycopg.Error:
            raise AppError(503, "RATE_LIMIT_UNAVAILABLE", "Rate limiting service is temporarily unavailable. Please retry later.")
        if r["hit_count"] > maximum:
            raise AppError(429, "RATE_LIMITED", f"Rate limit exceeded. Please retry after {math.ceil(r['retry'] / 1000)}s.")

    def load_doc(c, a, doc_id):
        if not doc_id: return None
        d = c.execute("SELECT * FROM school_documents WHERE id=%s", (doc_id,)).fetchone()
        if not d: raise AppError(404, "DOCUMENT_NOT_FOUND", "Academic document not found.")
        if d["user_id"] != a.id and not d["is_teacher_resource"] and a.role != "admin":
            audit(c, a, "DOCUMENT_ACCESS_DENIED", "SCHOOL_DOCUMENT", doc_id, "DENIED", {})
            c.commit()
            raise AppError(403, "FORBIDDEN_DOCUMENT_ACCESS", "You do not have permission to analyze another student’s private document.")
        return d

    def grounded_ai(c, a, operation: str, prompt: str, doc, build, simulate_failure=False, strict_live=False):
        """executeGroundedAI port. MOCK_DEMO only: the live provider path is intentionally not ported (no paid service)."""
        start = time.monotonic()
        rate_limit(f"ai:{a.id}", int(os.environ.get("AI_RATE_LIMIT_PER_MINUTE", "30") or 30))
        p = (prompt or "").strip()
        if len(p) < 3: raise AppError(400, "INVALID_AI_PROMPT", "AI prompt must contain at least 3 characters.")
        if len(p) > 12_000: raise AppError(400, "AI_PROMPT_TOO_LONG", "AI prompt exceeds maximum allowed length (12,000 characters).")
        citations, unc = grounding.extract_citations(doc, p)
        if simulate_failure:
            attempts = int(os.environ.get("AI_MAX_RETRIES", "2") or 2) + 1
            err = f"Upstream AI provider timeout on attempt {attempts}/{attempts}"
            uid = nid("aiu"); latency = max(1, int((time.monotonic() - start) * 1000))
            status = "ERROR" if strict_live else "FALLBACK_MOCK"
            c.execute("""INSERT INTO ai_usage_records (id,user_id,pillar,operation,provider,model,is_mock,prompt_tokens,completion_tokens,
                         estimated_cost_usd,latency_ms,status,error_code) VALUES (%s,%s,'school',%s,'mock',%s,TRUE,%s,0,0,%s,%s,'UPSTREAM_PROVIDER_FAILURE')""",
                      (uid, a.id, operation, MODEL, math.ceil(len(p) / 4), latency, status))
            audit(c, a, "AI_PROVIDER_FAILURE_HANDLED", "AI_SERVICE", uid, "ERROR" if strict_live else "SUCCESS",
                  {"operation": operation, "provider": "mock", "attempts": attempts, "errorMessage": err, "fallbackApplied": not strict_live})
            if strict_live:
                c.commit()
                raise AppError(503, "AI_PROVIDER_UNAVAILABLE", f"AI provider failed after {attempts} attempts: {err}")
            notice = (f"[DEMO / MOCK FALLBACK MODE — Upstream provider failed after {attempts} attempts ({err}). Output below is deterministic "
                      "source-grounded mock output and MUST NOT be treated as a live model inference. Verify all claims against primary academic sources.]")
            data = build(citations, "HIGH", notice)
            return {"aiMode": "MOCK_DEMO", "provider": "mock", "model": MODEL, "uncertaintyLevel": "HIGH", "epistemicNotice": notice,
                    "groundingCitations": citations, "data": data,
                    "usage": {"promptTokens": math.ceil(len(p) / 4), "completionTokens": 120, "estimatedCostUsd": 0, "latencyMs": latency, "status": "FALLBACK_MOCK"}}
        data = build(citations, unc, grounding.MOCK_NOTICE)
        pt, ct = math.ceil(len(p) / 4), math.ceil(len(json.dumps(data, ensure_ascii=False, separators=(",", ":"))) / 4)
        latency = max(1, int((time.monotonic() - start) * 1000))
        c.execute("""INSERT INTO ai_usage_records (id,user_id,pillar,operation,provider,model,is_mock,prompt_tokens,completion_tokens,
                     estimated_cost_usd,latency_ms,status) VALUES (%s,%s,'school',%s,'mock',%s,TRUE,%s,%s,0,%s,'SUCCESS')""",
                  (nid("aiu"), a.id, operation, MODEL, pt, ct, latency))
        return {"aiMode": "MOCK_DEMO", "provider": "mock", "model": MODEL, "uncertaintyLevel": unc, "epistemicNotice": grounding.MOCK_NOTICE,
                "groundingCitations": citations, "data": data,
                "usage": {"promptTokens": pt, "completionTokens": ct, "estimatedCostUsd": 0, "latencyMs": latency, "status": "SUCCESS"}}

    @app.post("/documents", status_code=201)
    def upload_document(body: DocumentIn, a=Depends(actor_dep)):
        title = body.title.strip()
        if len(title) < 2: raise AppError(400, "INVALID_DOCUMENT_TITLE", "Document title must contain at least 2 characters.")
        if body.contentBase64 is not None:
            # Reject before decoding anything absurdly large (base64 ≈ 4/3 of the payload).
            if len(body.contentBase64) > storage.max_upload_bytes() * 4 // 3 + 8:
                raise AppError(413, "FILE_TOO_LARGE", f"File exceeds maximum allowed size of {storage.max_upload_bytes()} bytes.")
            try: data = base64.b64decode(body.contentBase64, validate=True)
            except (binascii.Error, ValueError): raise AppError(400, "INVALID_FILE_CONTENT", "contentBase64 is not valid base64.")
        else:
            data = (body.content or "").encode("utf-8")
        teacher = bool(body.isTeacherResource) and a.role in ("teacher", "admin")
        name = body.originalFileName.strip() or f"{title}.txt"
        path = None
        try:
            with conn() as c:
                try:
                    f, path = storage.store(c, a, name, body.mimeType, data, "curriculum_resource" if teacher else "private")
                except AppError as e:
                    if e.code in ("FORBIDDEN_FILE_TYPE", "INVALID_MIME_TYPE"):
                        c.rollback()
                        audit(c, a, "FILE_UPLOAD_BLOCKED_EXTENSION" if e.code == "FORBIDDEN_FILE_TYPE" else "FILE_UPLOAD_BLOCKED_MIME",
                              "STORED_FILE", None, "DENIED", {"originalName": name[:200], "mimeType": body.mimeType})
                        c.commit()
                    raise
                text = grounding.extract_text(data, f["mime_type"]).strip()
                if len(text) < 10:
                    raise AppError(400, "CONTENT_TOO_SHORT", "Document content must contain at least 10 characters of readable text.")
                did = nid("doc")
                c.execute("""INSERT INTO school_documents (id,user_id,file_id,curriculum_id,subject_id,title,extracted_text,processing_status,
                             word_count,is_teacher_resource,verified_source) VALUES (%s,%s,%s,%s,%s,%s,%s,'PROCESSED',%s,%s,%s)""",
                          (did, a.id, f["id"], body.curriculumId or None, body.subjectId or None, title, text, len(text.split()), teacher, teacher))
                activity(c, a.id, "DOCUMENT_UPLOADED", body.subjectId or None, did, f'Uploaded academic document "{title}"', 10,
                         {"fileId": f["id"], "wordCount": len(text.split()), "isTeacherResource": teacher})
                doc = c.execute("SELECT * FROM school_documents WHERE id=%s", (did,)).fetchone()
        except Exception:
            if path is not None: path.unlink(missing_ok=True)  # compensate: no orphan object on disk
            raise
        return {"ok": True, "document": doc, "storedFile": f}

    @app.get("/files/{file_id}")
    def read_file(file_id: str, a=Depends(any_role_actor_dep)):
        with conn() as c:
            f, data = storage.read_authorized(c, a, file_id)
        text = data.decode("utf-8", errors="replace") if f["mime_type"] in storage.TEXT_MIME else None
        if f["mime_type"] == "application/pdf": text = grounding.extract_text(data, "application/pdf")
        f.pop("storage_key", None)
        return {"ok": True, "metadata": f, "textContent": text}

    @app.post("/explanations")
    def explain(body: ExplainIn, a=Depends(actor_dep)):
        with conn() as c:
            doc = load_doc(c, a, body.documentId)
            q = body.question
            def build(cits, unc, notice):
                ex = cits[0]["excerpt"] if cits else ""
                return {"question": q,
                        "explanation": (f'Grounded Academic Explanation based on "{doc["title"] if doc else None}":\n\n1. Key Concept Analysis: The source document directly states: "{ex}".\n2. Pedagogical Breakdown: When studying this topic for examinations, focus on the causal mechanisms and definitions explicitly present in your course material.\n3. Epistemic Caution: {notice}'
                                        if cits else f'Unanchored Academic Explanation (No source document attached):\n\n1. General Principle: Your question "{q}" relates to core secondary/university concepts, but no verified reference document was provided.\n2. Epistemic Caution: {notice}'),
                        "keyTakeaways": [f'Source Excerpt #{i + 1} ({x["sourceTitle"]}): "{x["excerpt"]}"' for i, x in enumerate(cits)]
                                        or ["Upload an official course document or textbook excerpt to obtain source-grounded citations."],
                        "uncertaintyLevel": unc, "epistemicNotice": notice}
            r = grounded_ai(c, a, "ACADEMIC_EXPLANATION", q, doc, build, body.simulateProviderFailure, body.strictLiveRequired)
            mid = nid("mat")
            c.execute("""INSERT INTO school_study_materials (id,user_id,document_id,subject_id,material_type,title,prompt_text,content_json,
                         grounding_sources_json,uncertainty_level,ai_mode) VALUES (%s,%s,%s,%s,'EXPLANATION',%s,%s,%s::jsonb,%s::jsonb,%s,%s)""",
                      (mid, a.id, doc["id"] if doc else None, body.subjectId or None, f"Explication: {q[:60]}", q,
                       json.dumps(r["data"]), json.dumps(r["groundingCitations"]), r["uncertaintyLevel"], r["aiMode"]))
            activity(c, a.id, "AI_EXPLANATION_GENERATED", body.subjectId or None, mid, f'Requested grounded AI explanation: "{q[:70]}"', 8,
                     {"aiMode": r["aiMode"], "uncertaintyLevel": r["uncertaintyLevel"], "citationsCount": len(r["groundingCitations"])})
            m = c.execute("SELECT * FROM school_study_materials WHERE id=%s", (mid,)).fetchone()
        return {"ok": True, "material": m, "aiResult": r}

    @app.post("/revisions", status_code=201)
    def generate(body: GenerateIn, a=Depends(actor_dep)):
        title = body.title.strip()
        if len(title) < 2: raise AppError(400, "INVALID_TITLE", "Title must contain at least 2 characters.")
        mt = body.materialType or "SUMMARY"; diff = body.difficulty or "INTERMEDIATE"
        if mt not in MATERIAL_TYPES: raise AppError(400, "INVALID_MATERIAL_TYPE", "Unsupported material type.")
        if diff not in DIFFICULTIES: raise AppError(400, "INVALID_DIFFICULTY", "Unsupported difficulty.")
        with conn() as c:
            doc = load_doc(c, a, body.documentId)
            src_title = doc["title"] if doc else title
            def build(cits, unc, notice):
                ref = cits[0]["excerpt"] if cits else title
                second = cits[1]["excerpt"] if len(cits) > 1 else ref
                return {"summary": f'Fiche de révision structurée ({mt}) basée sur "{src_title}". Extrait clé : {ref}',
                        "flashcards": [{"front": f'Concept fondamental dans "{src_title}"', "back": ref},
                                       {"front": "Application analytique & vérification des sources", "back": second}],
                        "factCheckNotes": {"sourceVerified": bool(doc and doc["verified_source"]), "uncertaintyLevel": unc, "epistemicNotice": notice},
                        "questions": [
                            {"id": "q1", "prompt": f"Question 1 (Compréhension directe) : Expliquez le principe central présenté dans l'extrait : \"{ref[:120]}...\"",
                             "expectedKeywords": grounding.top_keywords(ref), "maxPoints": 10,
                             "criterion": "Clarté de la définition et fidélité aux termes clés du document source."},
                            {"id": "q2", "prompt": f"Question 2 (Analyse & Synthèse) : Comment ce mécanisme s'applique-t-il dans un contexte d'examen ({diff}) ?",
                             "expectedKeywords": grounding.top_keywords(second), "maxPoints": 10,
                             "criterion": "Rigueur du raisonnement logique et mobilisation pertinente des concepts du cours."}],
                        "markingCriteria": [
                            {"id": "crit_1", "label": "Exactitude conceptuelle et terminologique", "weightPoints": 10,
                             "description": "Utilisation exacte des termes scientifiques/académiques présents dans le support de cours."},
                            {"id": "crit_2", "label": "Argumentation structurée et justification par les sources", "weightPoints": 10,
                             "description": "Capacité à relier la réponse aux preuves textuelles sans inventer de faits non vérifiés."}]}
            r = grounded_ai(c, a, "EXERCISE_GENERATION", f"Generate {mt} and {diff} exercise for: {body.title}", doc, build)
            d = r["data"]; mid, eid = nid("mat"), nid("exr")
            c.execute("""INSERT INTO school_study_materials (id,user_id,document_id,subject_id,material_type,title,prompt_text,content_json,
                         grounding_sources_json,uncertainty_level,ai_mode) VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,%s,%s)""",
                      (mid, a.id, doc["id"] if doc else None, body.subjectId or None, mt, title, f"Generate {mt}",
                       json.dumps({k: d[k] for k in ("summary", "flashcards", "factCheckNotes")}), json.dumps(r["groundingCitations"]),
                       r["uncertaintyLevel"], r["aiMode"]))
            c.execute("""INSERT INTO school_exercises (id,creator_user_id,document_id,subject_id,title,difficulty,questions_json,marking_criteria_json,
                         max_score,ai_mode) VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb,20.00,%s)""",
                      (eid, a.id, doc["id"] if doc else None, body.subjectId or None, f"Exercice d'application : {title}", diff,
                       json.dumps(d["questions"]), json.dumps(d["markingCriteria"]), r["aiMode"]))
            activity(c, a.id, "REVISION_AND_EXERCISE_GENERATED", body.subjectId or None, eid,
                     f'Generated {mt} & practice exercise "{title}" ({diff})', 12, {"materialId": mid, "exerciseId": eid, "aiMode": r["aiMode"]})
            sm = c.execute("SELECT * FROM school_study_materials WHERE id=%s", (mid,)).fetchone()
            ex = c.execute("SELECT * FROM school_exercises WHERE id=%s", (eid,)).fetchone()
        return {"ok": True, "studyMaterial": sm, "exercise": ex, "aiMode": r["aiMode"]}

    @app.post("/submissions", status_code=201)
    def submit(body: SubmitIn, a=Depends(actor_dep)):
        if len(body.answers) > 50 or any(len(v) > 20_000 for v in body.answers.values()):
            raise AppError(400, "ANSWERS_TOO_LARGE", "Too many or too long answers.")
        with conn() as c:
            ex = c.execute("SELECT * FROM school_exercises WHERE id=%s", (body.exerciseId,)).fetchone()
            if not ex: raise AppError(404, "EXERCISE_NOT_FOUND", "Exercise not found.")
            # Divergence (hardening): TS let any School user submit to any exercise id. Here the exercise must be
            # visible in the caller's workspace (creator, or attached to an own/teacher-resource document) or caller is admin.
            if a.role != "admin" and ex["creator_user_id"] != a.id:
                vis = ex["document_id"] and c.execute("SELECT 1 FROM school_documents WHERE id=%s AND (user_id=%s OR is_teacher_resource)",
                                                      (ex["document_id"], a.id)).fetchone()
                if not vis:
                    audit(c, a, "EXERCISE_ACCESS_DENIED", "SCHOOL_EXERCISE", ex["id"], "DENIED", {}); c.commit()
                    raise AppError(403, "FORBIDDEN_EXERCISE_ACCESS", "You do not have access to this exercise.")
            qs = ex["questions_json"] or []; max_score = float(ex["max_score"] or 20)
            answers = [(body.answers.get(q["id"]) or "").strip() for q in qs]
            g = grader.grade(qs, answers, max_score)
            corrections = []
            for q, ans, res in zip(qs, answers, g["questions"]):
                kws = q.get("expectedKeywords") or []
                matched = [kws[i] for i in res["matchedIndices"]]
                pts = res["points"]
                corrections.append({"questionId": q["id"], "prompt": q.get("prompt"), "studentAnswer": ans, "awardedPoints": pts,
                                    "maxPoints": q["maxPoints"], "matchedKeywords": matched, "expectedKeywords": kws,
                                    "markingCriterionApplied": q.get("criterion"),
                                    "explanation": (f'Bonne maîtrise du critère "{q.get("criterion")}". Termes clés mobilisés : {", ".join(matched) or "argumentation cohérente"}.'
                                                    if pts >= q["maxPoints"] * 0.7 else
                                                    f'Réponse partielle selon le barème "{q.get("criterion")}". Pour obtenir la note maximale, intégrez explicitement les notions clés : {", ".join(kws)}.')})
            total, pct = g["score"], g["percent"]
            fmt = lambda x: f"{x:g}"
            head = f"({fmt(total)}/{fmt(max_score)} — {fmt(pct)}%)"
            feedback = (f"Excellent travail {head}. Les critères d'évaluation sont bien respectés." if pct >= 75 else
                        f"Résultat encourageant {head}. Approfondissez les notions signalées dans le barème détaillé." if pct >= 50 else
                        f"Résultat à consolider {head}. Relisez les extraits sources du document de cours et reprenez chaque critère du barème.")
            note = "[DEMO / MOCK MODE — Correction algorithmique basée sur le barème explicite et les mots-clés extraits du cours. Faites valider toute copie officielle par votre enseignant.]"
            sid = nid("sub")
            c.execute("""INSERT INTO school_exercise_submissions (id,exercise_id,student_user_id,answers_json,score,max_score,percentage,corrections_json,
                         overall_feedback,uncertainty_note,ai_mode) VALUES (%s,%s,%s,%s::jsonb,%s,%s,%s,%s::jsonb,%s,%s,'MOCK_DEMO')""",
                      (sid, ex["id"], a.id, json.dumps(body.answers), total, max_score, pct, json.dumps(corrections), feedback, note))
            activity(c, a.id, "EXERCISE_SUBMITTED_AND_GRADED", ex["subject_id"], sid,
                     f'Submitted answers for "{ex["title"]}" — Score: {fmt(total)}/{fmt(max_score)} ({fmt(pct)}%)', 15,
                     {"exerciseId": ex["id"], "submissionId": sid, "score": total, "maxScore": max_score, "percentage": pct, "grader": "cpp"})
            s = c.execute("SELECT * FROM school_exercise_submissions WHERE id=%s", (sid,)).fetchone()
        return {"ok": True, "submission": s}

    @app.get("/workspace")
    def workspace(a=Depends(actor_dep)):
        with conn() as c:
            prof = c.execute("""SELECT ap.*, c.name AS curriculum_name, c.verified AS curriculum_verified, l.name AS level_name,
                    s.name AS subject_name, s.verified AS subject_verified FROM academic_profiles ap
                    LEFT JOIN academic_curricula c ON c.id=ap.curriculum_id LEFT JOIN academic_levels l ON l.id=ap.level_id
                    LEFT JOIN academic_subjects s ON s.id=ap.primary_subject_id WHERE ap.user_id=%s""", (a.id,)).fetchone()
            docs = c.execute("""SELECT id,user_id,file_id,curriculum_id,subject_id,title,processing_status,word_count,is_teacher_resource,
                    verified_source,created_at FROM school_documents WHERE user_id=%s OR is_teacher_resource ORDER BY created_at DESC""", (a.id,)).fetchall()
            mats = c.execute("SELECT * FROM school_study_materials WHERE user_id=%s ORDER BY created_at DESC", (a.id,)).fetchall()
            exs = c.execute("""SELECT * FROM school_exercises WHERE creator_user_id=%s OR document_id IN
                    (SELECT id FROM school_documents WHERE user_id=%s OR is_teacher_resource) ORDER BY created_at DESC""", (a.id, a.id)).fetchall()
            subs = c.execute("""SELECT s.*, e.title AS exercise_title FROM school_exercise_submissions s JOIN school_exercises e ON e.id=s.exercise_id
                    WHERE s.student_user_id=%s ORDER BY s.created_at DESC""", (a.id,)).fetchall()
            acts = c.execute("SELECT * FROM school_learning_activities WHERE user_id=%s ORDER BY created_at DESC LIMIT 50", (a.id,)).fetchall()
        total = sum(float(x["progress_delta"] or 0) for x in acts)
        avg = round(sum(float(s["percentage"] or 0) for s in subs) / len(subs) + 1e-9, 1) if subs else 0
        return {"ok": True, "profile": prof, "documents": docs, "studyMaterials": mats, "exercises": exs, "submissions": subs,
                "activities": acts, "progressSummary": {"totalActivities": len(acts),
                "documentsUploaded": sum(1 for d in docs if d["user_id"] == a.id), "exercisesCompleted": len(subs),
                "averageScorePercentage": avg, "cumulativeProgressScore": min(100, int(math.floor(total + 0.5)))}}
