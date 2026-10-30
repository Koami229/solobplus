"""SOLOB School service (Python/FastAPI). Internal only: reached through the Rust gateway,
which authenticates the user and forwards identity headers + a shared service secret."""
from __future__ import annotations
import hmac, json, os, secrets
from typing import Optional
import psycopg
from psycopg.rows import dict_row
from fastapi import Depends, FastAPI, Header, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

SCHOOL_ROLES = {"student", "teacher", "admin"}

class AppError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message

class Actor(BaseModel):
    id: str
    role: str
    email: str

class ProfileIn(BaseModel):
    country: str = Field(default="", max_length=64)
    curriculumId: str = Field(default="", max_length=64)
    levelId: str = Field(default="", max_length=64)
    primarySubjectId: str = Field(default="", max_length=64)
    institutionName: Optional[str] = Field(default=None, max_length=200)
    learningGoals: Optional[str] = Field(default=None, max_length=2000)

CATALOG_SQL = [
    """INSERT INTO academic_curricula (id, code, name, country, education_system, verified, description) VALUES
 ('cur_bj_bac','BJ-BAC-GENERAL','Programme National Bénin — Enseignement Secondaire Général (BAC/BEPC)','BJ','Francophone West Africa',TRUE,'Verified core syllabus outlines for Terminale C/D and 3ème in Benin.'),
 ('cur_waec_sss','WAEC-WASSCE','WAEC West African Senior School Certificate Examination','NG','Anglophone West Africa',TRUE,'Verified core STEM and Humanities modules for WASSCE candidates.'),
 ('cur_sn_bac','SN-BAC-UEMOA','Programme Sénégal & Harmonisé UEMOA (Lycée)','SN','Francophone West Africa',FALSE,'Community-contributed curriculum structure — awaiting official ministry verification.')
 ON CONFLICT (code) DO NOTHING""",
    """INSERT INTO academic_levels (id, curriculum_id, code, name, stage_order, verified) VALUES
 ('lvl_bj_3e','cur_bj_bac','3EME','Troisième (BEPC)',1,TRUE),
 ('lvl_bj_tle_cd','cur_bj_bac','TLE-CD','Terminale C & D (Scientifique)',2,TRUE),
 ('lvl_waec_ss3','cur_waec_sss','SS3','Senior Secondary 3 (SS3)',3,TRUE),
 ('lvl_sn_tle','cur_sn_bac','TLE-S','Terminale S (Non vérifié)',4,FALSE)
 ON CONFLICT (curriculum_id, code) DO NOTHING""",
    """INSERT INTO academic_subjects (id, curriculum_id, level_id, code, name, category, verified) VALUES
 ('sub_bj_svt','cur_bj_bac','lvl_bj_tle_cd','SVT-TLE','Sciences de la Vie et de la Terre (Génétique & Écologie)','STEM',TRUE),
 ('sub_bj_math','cur_bj_bac','lvl_bj_tle_cd','MATH-TLE','Mathématiques (Analyse, Suites & Probabilités)','STEM',TRUE),
 ('sub_bj_pct','cur_bj_bac','lvl_bj_tle_cd','PCT-TLE','Physique, Chimie et Technologie','STEM',TRUE),
 ('sub_bj_hist','cur_bj_bac','lvl_bj_3e','HIST-GEO-3E','Histoire-Géographie (Royaumes du Danxomè & Afrique de l''Ouest)','HUMANITIES',TRUE),
 ('sub_waec_bio','cur_waec_sss','lvl_waec_ss3','WAEC-BIO','WASSCE Biology (Cell Physiology & Genetics)','STEM',TRUE),
 ('sub_sn_philo','cur_sn_bac','lvl_sn_tle','SN-PHILO','Philosophie Africaine & Épistémologie (Couverture partielle non vérifiée)','HUMANITIES',FALSE)
 ON CONFLICT (curriculum_id, code) DO NOTHING""",
]

def new_id(prefix: str) -> str:
    return f"{prefix}_{secrets.token_hex(12)}"

def create_app(database_url: Optional[str] = None, service_secret: Optional[str] = None) -> FastAPI:
    db_url = database_url or os.environ.get("DATABASE_URL", "")
    secret = service_secret if service_secret is not None else os.environ.get("SERVICE_SECRET", "")
    app = FastAPI(title="solob-school", docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(AppError)
    async def _app_error(_: Request, e: AppError):
        return JSONResponse({"ok": False, "error": {"code": e.code, "message": e.message}}, status_code=e.status)

    def conn():
        if not db_url:
            raise AppError(503, "DATABASE_UNAVAILABLE", "School database is not configured.")
        return psycopg.connect(db_url, row_factory=dict_row)

    def actor(x_solob_service_secret: str = Header(default=""), x_solob_user_id: str = Header(default=""),
              x_solob_user_role: str = Header(default=""), x_solob_user_email: str = Header(default="")) -> Actor:
        # Fail closed: an empty configured secret never authenticates anyone.
        if len(secret) < 32 or not hmac.compare_digest(x_solob_service_secret.encode(), secret.encode()):
            raise AppError(401, "SERVICE_UNAUTHENTICATED", "Invalid internal service credentials.")
        if not x_solob_user_id:
            raise AppError(401, "UNAUTHENTICATED", "Authentication required.")
        if x_solob_user_role not in SCHOOL_ROLES:
            raise AppError(403, "FORBIDDEN_ROLE", "Role not allowed for SOLOB School.")
        return Actor(id=x_solob_user_id, role=x_solob_user_role, email=x_solob_user_email)

    @app.get("/health")
    def health():
        return {"ok": True, "service": "school-python"}

    @app.get("/catalog")
    def catalog(a: Actor = Depends(actor)):
        with conn() as c:
            for q in CATALOG_SQL:
                c.execute(q)
            cur = c.execute("SELECT id, code, name, country, verified FROM academic_curricula ORDER BY name").fetchall()
            lv = c.execute("SELECT id, curriculum_id, name, verified FROM academic_levels ORDER BY stage_order").fetchall()
            sb = c.execute("SELECT id, curriculum_id, level_id, name, category, verified FROM academic_subjects ORDER BY name").fetchall()
        return {"ok": True, "curricula": cur, "levels": lv, "subjects": sb}

    @app.post("/profile")
    def upsert_profile(body: ProfileIn, a: Actor = Depends(actor)):
        if not (body.country.strip() and body.curriculumId and body.levelId and body.primarySubjectId):
            raise AppError(400, "MISSING_PROFILE_FIELDS", "Country, curriculum, level, and primary subject are required.")
        profile_type = "teacher" if a.role == "teacher" else "student"
        with conn() as c:
            for q in CATALOG_SQL:
                c.execute(q)
            cur = c.execute("SELECT id, verified, name FROM academic_curricula WHERE id=%s", (body.curriculumId,)).fetchone()
            if not cur:
                raise AppError(404, "CURRICULUM_NOT_FOUND", "Selected curriculum does not exist.")
            ok = c.execute("""SELECT 1 FROM academic_levels l JOIN academic_subjects s ON s.curriculum_id=l.curriculum_id
                              WHERE l.id=%s AND s.id=%s AND l.curriculum_id=%s""",
                           (body.levelId, body.primarySubjectId, body.curriculumId)).fetchone()
            if not ok:
                raise AppError(400, "INVALID_PROFILE_SELECTION", "Level and subject must belong to the selected curriculum.")
            # Atomic upsert (TS did SELECT-then-INSERT, racy).
            row = c.execute("""INSERT INTO academic_profiles (id,user_id,profile_type,country,curriculum_id,level_id,primary_subject_id,institution_name,learning_goals)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (user_id) DO UPDATE SET country=EXCLUDED.country, curriculum_id=EXCLUDED.curriculum_id,
                  level_id=EXCLUDED.level_id, primary_subject_id=EXCLUDED.primary_subject_id,
                  institution_name=EXCLUDED.institution_name, learning_goals=EXCLUDED.learning_goals, updated_at=NOW()
                RETURNING id""",
                (new_id("acp"), a.id, profile_type, body.country.strip(), body.curriculumId, body.levelId, body.primarySubjectId,
                 (body.institutionName or "").strip() or None, (body.learningGoals or "").strip() or None)).fetchone()
            pid = row["id"]
            c.execute("""INSERT INTO school_learning_activities (id,user_id,activity_type,subject_id,reference_id,summary,duration_seconds,progress_delta,metadata_json)
                VALUES (%s,%s,'PROFILE_CONFIGURED',%s,%s,%s,120,5,%s::jsonb)""",
                (new_id("act"), a.id, body.primarySubjectId, pid, f"Academic profile configured ({cur['name']})",
                 json.dumps({"curriculumVerified": cur["verified"], "profileType": profile_type})))
            c.execute("""INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json)
                VALUES (%s,%s,%s,'school','ACADEMIC_PROFILE_SAVED','ACADEMIC_PROFILE',%s,'SUCCESS',%s::jsonb)""",
                (new_id("aud"), a.id, a.role, pid, json.dumps({"curriculumId": body.curriculumId, "levelId": body.levelId,
                                                               "primarySubjectId": body.primarySubjectId})))
            saved = c.execute("""SELECT ap.id, ap.profile_type, ap.country, ap.curriculum_id, ap.level_id, ap.primary_subject_id,
                ap.institution_name, ap.learning_goals, c.name AS curriculum_name, c.verified AS curriculum_verified
                FROM academic_profiles ap LEFT JOIN academic_curricula c ON c.id=ap.curriculum_id WHERE ap.id=%s""", (pid,)).fetchone()
        return {"ok": True, "profile": saved}

    return app

app = create_app()
