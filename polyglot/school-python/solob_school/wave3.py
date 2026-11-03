"""Vague 3 — stories School du lancement.
S01 : catalogue filtré par le niveau du profil (l'élève ne voit que les matières de son niveau).
S02 : tuteur IA *expérimental* — cite au moins une source extraite du document, sinon répond « aucune source » sans inventer.
S06 : contenus en langue africaine visibles par les élèves seulement après validation par un spécialiste distinct de l'auteur
      (contraintes et trigger SQL de db/migrations-ai/010)."""
from __future__ import annotations
import json, secrets
from typing import Optional
from fastapi import Depends, FastAPI
from pydantic import BaseModel, Field
from .errors import AppError
from . import db, grounding

TUTOR_LABEL = "Tuteur IA — expérimental : vérifiez toujours la source citée."
NO_SOURCE = ("Aucune source : je ne trouve aucun passage pertinent dans un document de cours. "
             "Je ne réponds pas sans source — ajoutez un document ou demandez à votre enseignant.")
VALIDATORS = {"teacher", "admin"}

class TutorIn(BaseModel):
    question: str = Field(min_length=3, max_length=2000)
    documentId: Optional[str] = Field(default=None, max_length=64)

class LangContentIn(BaseModel):
    language: str = Field(pattern=r"^[a-z]{2,3}$")
    levelId: Optional[str] = Field(default=None, max_length=64)
    title: str = Field(min_length=3, max_length=200)
    body: str = Field(min_length=10, max_length=20000)

class ReviewIn(BaseModel):
    decision: str = Field(pattern=r"^(validated|rejected)$")
    comment: str = Field(default="", max_length=2000)

def nid(p): return f"{p}_{secrets.token_hex(12)}"

def tutor_answer(doc: dict | None, question: str) -> dict:
    """Pure : construit la réponse à partir des seules citations ; jamais de contenu sans source."""
    cits, unc = grounding.extract_citations(doc, question)
    has_kw = any(len(w) > 3 for w in grounding.keywords(question, 1))
    cits = [x for x in cits if x["relevanceScore"] > 0.25] if doc and has_kw else []  # au moins un mot-clé de la question présent
    if not cits:
        return {"experimental": True, "label": TUTOR_LABEL, "hasSource": False, "answer": NO_SOURCE, "citations": [], "uncertaintyLevel": "HIGH"}
    body = "\n".join(f"[{i + 1}] « {x['excerpt']} »" for i, x in enumerate(cits))
    return {"experimental": True, "label": TUTOR_LABEL, "hasSource": True,
            "answer": f"D'après votre document « {cits[0]['sourceTitle']} » :\n{body}", "citations": cits, "uncertaintyLevel": unc}

def register(app: FastAPI, db_url_fn, actor_dep) -> None:
    def conn(): return db.connection(db_url_fn())
    def audit(c, a, action, ttype, tid, status, meta):
        c.execute("""INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json)
                     VALUES (%s,%s,%s,'school',%s,%s,%s,%s,%s::jsonb)""", (nid("aud"), a.id, a.role, action, ttype, tid, status, json.dumps(meta)))
    def table_ok(c, t):
        if not c.execute("SELECT to_regclass(%s) IS NOT NULL AS ok", (f"public.{t}",)).fetchone()["ok"]:
            raise AppError(503, "MODULE_DISABLED", "Module non activé (migration 010 non appliquée).")

    @app.get("/catalog/mine")
    def my_catalog(a=Depends(actor_dep)):
        with conn() as c:
            p = c.execute("SELECT curriculum_id, level_id FROM academic_profiles WHERE user_id=%s", (a.id,)).fetchone()
            if not p or not p["level_id"]:
                raise AppError(409, "PROFILE_REQUIRED", "Configurez d'abord votre profil (pays, programme, niveau).")
            lv = c.execute("SELECT id, name, verified FROM academic_levels WHERE id=%s", (p["level_id"],)).fetchone()
            sb = c.execute("""SELECT id, code, name, category, verified FROM academic_subjects
                              WHERE curriculum_id=%s AND level_id=%s ORDER BY name""", (p["curriculum_id"], p["level_id"])).fetchall()
            lc = []
            if c.execute("SELECT to_regclass('public.school_language_contents') IS NOT NULL AS ok").fetchone()["ok"]:
                lc = c.execute("""SELECT content_id, language, title FROM school_language_contents
                                  WHERE status='validated' AND (level_id IS NULL OR level_id=%s) ORDER BY title""", (p["level_id"],)).fetchall()
        return {"ok": True, "level": lv, "subjects": sb, "languageContents": lc}

    @app.post("/tutor")
    def tutor(body: TutorIn, a=Depends(actor_dep)):
        with conn() as c:
            doc = None
            if body.documentId:
                doc = c.execute("SELECT * FROM school_documents WHERE id=%s", (body.documentId,)).fetchone()
                if not doc: raise AppError(404, "DOCUMENT_NOT_FOUND", "Document introuvable.")
                if doc["user_id"] != a.id and not doc["is_teacher_resource"] and a.role != "admin":
                    audit(c, a, "DOCUMENT_ACCESS_DENIED", "SCHOOL_DOCUMENT", body.documentId, "DENIED", {})
                    c.commit()
                    raise AppError(403, "FORBIDDEN_DOCUMENT_ACCESS", "Ce document ne vous appartient pas.")
            r = tutor_answer(doc, body.question)
            audit(c, a, "AI_TUTOR_ANSWER", "SCHOOL_DOCUMENT", body.documentId, "SUCCESS", {"hasSource": r["hasSource"], "citations": len(r["citations"])})
        return {"ok": True, **r}

    @app.post("/language-contents", status_code=201)
    def create_content(body: LangContentIn, a=Depends(actor_dep)):
        if a.role not in VALIDATORS: raise AppError(403, "FORBIDDEN_ROLE", "Réservé aux enseignants et spécialistes.")
        with conn() as c:
            table_ok(c, "school_language_contents")
            cid = nid("lc")
            c.execute("INSERT INTO school_language_contents(content_id,author_id,language,level_id,title,body) VALUES (%s,%s,%s,%s,%s,%s)",
                      (cid, a.id, body.language, body.levelId, body.title.strip(), body.body.strip()))
            audit(c, a, "LANG_CONTENT_SUBMITTED", "LANG_CONTENT", cid, "SUCCESS", {"language": body.language})
        return {"ok": True, "contentId": cid, "status": "pending"}

    @app.post("/language-contents/{cid}/review")
    def review_content(cid: str, body: ReviewIn, a=Depends(actor_dep)):
        if a.role not in VALIDATORS: raise AppError(403, "FORBIDDEN_ROLE", "Réservé aux spécialistes.")
        if body.decision == "rejected" and not body.comment.strip():
            raise AppError(400, "COMMENT_REQUIRED", "Un rejet doit être motivé.")
        with conn() as c:
            table_ok(c, "school_language_contents")
            row = c.execute("SELECT author_id, status FROM school_language_contents WHERE content_id=%s", (cid,)).fetchone()
            if not row: raise AppError(404, "CONTENT_NOT_FOUND", "Contenu introuvable.")
            if row["author_id"] == a.id:
                audit(c, a, "LANG_CONTENT_REVIEW", "LANG_CONTENT", cid, "DENIED", {"reason": "self_review"}); c.commit()
                raise AppError(403, "SELF_REVIEW_FORBIDDEN", "L'auteur ne peut pas valider son propre contenu.")
            c.execute("""UPDATE school_language_contents SET status=%s, validator_id=%s, validated_at=CASE WHEN %s='validated' THEN now() END,
                         review_comment=%s WHERE content_id=%s""", (body.decision, a.id, body.decision, body.comment.strip(), cid))
            audit(c, a, "LANG_CONTENT_REVIEW", "LANG_CONTENT", cid, "SUCCESS", {"decision": body.decision})
        return {"ok": True, "contentId": cid, "status": body.decision}

    @app.get("/language-contents")
    def list_contents(language: Optional[str] = None, a=Depends(actor_dep)):
        with conn() as c:
            table_ok(c, "school_language_contents")
            q = """SELECT content_id, author_id, language, level_id, title, body, status, review_comment FROM school_language_contents
                   WHERE (status='validated' OR author_id=%s OR %s) AND (%s::text IS NULL OR language=%s) ORDER BY created_at DESC LIMIT 200"""
            rows = c.execute(q, (a.id, a.role in VALIDATORS, language, language)).fetchall()
        return {"ok": True, "contents": rows}
