"""Port of src/lib/core/storage.ts: upload validation, private local storage, authorized reads."""
from __future__ import annotations
import hashlib, json, os, re, secrets
from pathlib import Path
from .errors import AppError

ALLOWED_MIME = {"text/plain", "text/markdown", "text/csv", "application/json", "application/pdf", "audio/wav", "audio/mpeg"}
FORBIDDEN_EXTENSIONS = {".exe", ".sh", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".php", ".py", ".rb", ".pl", ".dll", ".so",
                        ".dylib", ".jar", ".msi", ".com", ".scr", ".ps1", ".vbs", ".html", ".htm", ".svg"}
TEXT_MIME = {"text/plain", "text/markdown", "text/csv", "application/json"}
EXT_MIME = {".pdf": "application/pdf", ".md": "text/markdown", ".markdown": "text/markdown", ".csv": "text/csv",
            ".json": "application/json", ".txt": "text/plain", ".wav": "audio/wav", ".mp3": "audio/mpeg"}

def max_upload_bytes() -> int:
    try:
        v = int(os.environ.get("MAX_UPLOAD_BYTES", "10485760"))
        return v if v > 0 else 10485760
    except ValueError:
        return 10485760

def storage_dir() -> Path:
    return Path(os.environ.get("LOCAL_STORAGE_DIR", "./data/storage")).resolve()

def ext_of(name: str) -> str:
    i = name.rfind(".")
    return name[i:].lower() if i > 0 or (i == 0 and len(name) > 1) else ""

def infer_mime(name: str, provided: str | None) -> str:
    ext = ext_of(name)
    p = (provided or "").strip().lower()
    if p in ALLOWED_MIME:
        if ext == ".pdf": return "application/pdf"
        if ext == ".json": return "application/json"
        return p
    return EXT_MIME.get(ext) or p or "application/octet-stream"

def validate_signature(data: bytes, mime: str, name: str) -> None:
    bad = AppError(400, "INVALID_FILE_SIGNATURE", "File content signature does not match an allowed document type.")
    if data[:4] == b"\x7fELF" or data[:4] in (bytes.fromhex("feedface"), bytes.fromhex("feedfacf"), bytes.fromhex("cefaedfe"),
                                                bytes.fromhex("cffaedfe")) or data[:2] in (b"MZ", b"#!"):
        raise bad
    if ext_of(name) == ".pdf" and mime != "application/pdf":
        raise AppError(400, "INVALID_MIME_TYPE", "PDF files must use application/pdf.")
    if mime == "application/pdf":
        if data[:5] != b"%PDF-": raise bad
    elif mime == "audio/wav":
        if data[:4] != b"RIFF" or data[8:12] != b"WAVE": raise bad
    elif mime == "audio/mpeg":
        if not (data[:3] == b"ID3" or (len(data) > 1 and data[0] == 0xFF and (data[1] & 0xE0) == 0xE0)): raise bad
    elif mime in TEXT_MIME:
        if b"\x00" in data: raise bad
        if mime == "application/json":
            try: json.loads(data.decode("utf-8"))
            except Exception: raise AppError(400, "INVALID_FILE_CONTENT", "JSON file content is not valid JSON.")

def safe_path(key: str) -> Path:
    root = storage_dir()
    p = (root / key).resolve()
    if root not in p.parents:
        raise AppError(400, "INVALID_STORAGE_KEY", "Invalid storage key.")
    return p

def audit(c, actor, action, target_id, status, meta):
    c.execute("""INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json)
                 VALUES (%s,%s,%s,'school',%s,'STORED_FILE',%s,%s,%s::jsonb)""",
              ("aud_" + secrets.token_hex(12), actor.id, actor.role, action, target_id, status, json.dumps(meta)))

def validate_upload(name: str, mime_in: str | None, data: bytes) -> tuple[str, str]:
    """Returns (trimmed name, mime) or raises. Audit of blocked attempts is done by the caller (needs a connection)."""
    n = (name or "").strip()
    if not (1 <= len(n) <= 200):
        raise AppError(400, "INVALID_FILE_NAME", "File name must be between 1 and 200 characters.")
    if ext_of(n) in FORBIDDEN_EXTENSIONS:
        raise AppError(400, "FORBIDDEN_FILE_TYPE", "Executable or script file types are not allowed.")
    mime = infer_mime(n, mime_in)
    if mime not in ALLOWED_MIME:
        raise AppError(400, "INVALID_MIME_TYPE", f"MIME type '{mime}' is not allowed.")
    if len(data) == 0:
        raise AppError(400, "EMPTY_FILE", "Uploaded file is empty.")
    if len(data) > max_upload_bytes():
        raise AppError(413, "FILE_TOO_LARGE", f"File exceeds maximum allowed size of {max_upload_bytes()} bytes.")
    validate_signature(data, mime, n)
    return n, mime

def store(c, actor, name: str, mime_in: str | None, data: bytes, visibility="private") -> tuple[dict, Path]:
    """Validates, writes the object (0600) and inserts stored_files inside caller's transaction.
    Caller must delete the returned path if the transaction later fails."""
    n, mime = validate_upload(name, mime_in, data)  # blocked-type audit is recorded by the caller
    fid = "fil_" + secrets.token_hex(12)
    safe = re.sub(r"[^a-zA-Z0-9._-]", "_", n)
    key = f"school/{actor.id}/{fid}_{safe}"
    path = safe_path(key)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    try:
        row = c.execute("""INSERT INTO stored_files (id,owner_user_id,pillar,original_name,storage_key,mime_type,size_bytes,sha256_checksum,visibility)
            VALUES (%s,%s,'school',%s,%s,%s,%s,%s,%s) RETURNING id,owner_user_id,pillar,original_name,mime_type,size_bytes,sha256_checksum,visibility,created_at""",
            (fid, actor.id, n, key, mime, len(data), hashlib.sha256(data).hexdigest(), visibility)).fetchone()
        audit(c, actor, "FILE_UPLOADED", fid, "SUCCESS", {"originalName": n, "mimeType": mime, "sizeBytes": len(data), "visibility": visibility})
    except Exception:
        path.unlink(missing_ok=True)
        raise
    return row, path

def read_authorized(c, actor, file_id: str) -> tuple[dict, bytes]:
    f = c.execute("SELECT * FROM stored_files WHERE id=%s", (file_id,)).fetchone()
    if not f:
        raise AppError(404, "FILE_NOT_FOUND", "File not found.")
    ok = f["owner_user_id"] == actor.id or actor.role == "admin" or (
        f["pillar"] == "school" and f["visibility"] == "curriculum_resource" and actor.role in ("student", "teacher"))
    # Business task-based rules (operator/contributor/reviewer/client) are owned by the Java service; not granted here.
    if not ok:
        audit(c, actor, "FILE_ACCESS_DENIED", file_id, "DENIED", {"pillar": f["pillar"]})
        c.connection.commit()
        raise AppError(403, "FORBIDDEN_FILE_ACCESS", "You do not have access to this file.")
    return f, safe_path(f["storage_key"]).read_bytes()
