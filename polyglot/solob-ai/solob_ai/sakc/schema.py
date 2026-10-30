"""Schéma de métadonnées SAKC (SOLOB African Knowledge Corpus)."""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
import hashlib, uuid

class RightsStatus(str, Enum):
    UNKNOWN = "unknown"            # aucune information: interdit à l'entraînement
    PENDING = "pending_review"     # en cours de vérification
    VERIFIED = "rights_verified"   # licence ouverte vérifiée + preuve enregistrée
    REJECTED = "rejected"          # licence incompatible / protégée

OPEN_LICENSES = {"CC0-1.0", "PUBLIC-DOMAIN", "CC-BY-4.0", "CC-BY-3.0", "CC-BY-SA-4.0", "CC-BY-SA-3.0"}
LEVELS = {"primaire", "college", "lycee", "universite", "general", "inconnu"}
DISCIPLINES = {"mathematiques", "physique", "chimie", "biologie", "informatique", "histoire",
               "geographie", "langues", "litterature", "general", "inconnu"}

@dataclass
class Source:
    source_id: str
    name: str
    url: str
    license: str
    license_url: str
    rights_status: RightsStatus
    proof: dict                    # preuve: URL + extrait + date de vérification
    notes: str = ""

@dataclass
class Resource:
    source_id: str
    url: str
    license: str
    rights_status: RightsStatus
    proof_ref: str                 # pointeur vers la preuve de la source
    country: str                   # ISO 3166-1 alpha-2, ou "AF" (panafricain) / "XX" (inconnu/universel)
    language: str                  # ISO 639 (fr, en, fon, yo, ha, wo, sw, ig, ...)
    discipline: str = "general"
    level: str = "general"
    title: str = ""
    text: str = ""
    version: str = "v0"
    annotation: dict = field(default_factory=dict)  # {annotator, date, labels...}
    resource_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    sha256: str = ""

    def finalize(self) -> "Resource":
        self.sha256 = hashlib.sha256(self.text.encode("utf-8")).hexdigest()
        return self

    def validate(self) -> list[str]:
        errs = []
        if not self.url: errs.append("url manquante")
        if self.rights_status == RightsStatus.VERIFIED and self.license not in OPEN_LICENSES:
            errs.append(f"licence {self.license} non ouverte mais statut verified")
        if self.rights_status == RightsStatus.VERIFIED and not self.proof_ref:
            errs.append("preuve de licence manquante")
        if self.level not in LEVELS: errs.append(f"niveau inconnu {self.level}")
        if self.discipline not in DISCIPLINES: errs.append(f"discipline inconnue {self.discipline}")
        if not self.language: errs.append("langue manquante")
        return errs

    def to_dict(self) -> dict:
        d = asdict(self); d["rights_status"] = self.rights_status.value; return d
