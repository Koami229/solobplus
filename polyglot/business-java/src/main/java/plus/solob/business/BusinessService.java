package plus.solob.business;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.*;
import java.sql.Connection;
import java.util.*;
import plus.solob.business.BusinessServer.Actor;
import plus.solob.business.BusinessServer.AppError;
import static plus.solob.business.BusinessServer.M;
import static plus.solob.business.Db.*;

/** Port of src/lib/business/service.ts (all actions + reads) with the same RBAC/audit/transaction rules,
 *  plus hardening documented in ARCHITECTURE-POLYGLOT.md §8 (self-review ban, reviewer assignment, review only of the latest SUBMITTED revision). */
public final class BusinessService {
    static final Set<String> OPERATOR_ROLES = Set.of("operator", "admin");
    static final Set<String> PROJECT_STATUSES = Set.of("DRAFT", "SUBMITTED", "UNDER_REVIEW", "APPROVED_ACTIVE", "IN_EXECUTION", "QA_REVIEW", "DELIVERED", "CLOSED", "REJECTED");
    static final Set<String> PAY_STATUSES = Set.of("PENDING", "APPROVED", "READY_FOR_PAYOUT", "PAID_SIMULATED", "HELD");
    static final Set<String> ASSESSMENT_TYPES = Set.of("LANGUAGE_PROFICIENCY", "DOMAIN_SKILL", "ANNOTATION_QA");
    static final Set<String> AVAILABILITY = Set.of("AVAILABLE", "PARTIALLY_AVAILABLE", "UNAVAILABLE");
    static final Set<String> DECISIONS = Set.of("APPROVE", "REQUEST_REVISION", "REJECT");
    static final Set<String> TEXT_MIME = Set.of("text/plain", "text/markdown", "text/csv", "application/json");

    final Db db; final Path storageRoot;
    BusinessService(Db db, Path storageRoot) { this.db = db; this.storageRoot = storageRoot.toAbsolutePath().normalize(); }

    // ---------- input helpers ----------
    static String str(JsonNode b, String f) { var n = b.get(f); return n == null || n.isNull() ? "" : n.asText().trim(); }
    static String opt(JsonNode b, String f) { var s = str(b, f); return s.isEmpty() ? null : s; }
    static String req(JsonNode b, String f) { var s = str(b, f); if (s.isEmpty()) throw new AppError(400, "VALIDATION_ERROR", f + " is required."); return s; }
    static Double num(JsonNode b, String f) {
        var n = b.get(f); if (n == null || n.isNull()) return null;
        if (!n.isNumber()) throw new AppError(400, "VALIDATION_ERROR", f + " must be a number.");
        double d = n.asDouble(); if (!Double.isFinite(d)) throw new AppError(400, "VALIDATION_ERROR", f + " must be finite.");
        return d;
    }
    static boolean bool(JsonNode b, String f) { var n = b.get(f); return n != null && n.asBoolean(false); }
    static List<String> strs(JsonNode b, String f) {
        var out = new ArrayList<String>(); var n = b.get(f);
        if (n != null && n.isArray()) for (var x : n) if (x.isTextual() && !x.asText().isBlank()) out.add(x.asText().trim());
        if (out.size() > 50) throw new AppError(400, "VALIDATION_ERROR", f + " has too many entries.");
        return out;
    }
    static void role(Actor a, Set<String> roles) { if (!roles.contains(a.role())) throw new AppError(403, "FORBIDDEN_ROLE", "Your role is not allowed to perform this action."); }
    static ObjectNode meta() { return M.createObjectNode(); }
    static List<String> list(JsonNode arr) { var o = new ArrayList<String>(); if (arr != null && arr.isArray()) arr.forEach(x -> o.add(x.asText())); return o; }

    public JsonNode dispatch(Actor a, JsonNode b) throws Exception {
        if (b == null || !b.isObject()) throw new AppError(400, "VALIDATION_ERROR", "JSON object expected.");
        return switch (str(b, "action")) {
            case "review_project" -> wrap("project", reviewProject(a, b));
            case "upsert_talent_profile" -> wrap("profile", upsertTalentProfile(a, b));
            case "record_assessment" -> wrap("assessment", recordAssessment(a, b));
            case "create_assign_task" -> ok(createAssignTask(a, b));
            case "submit_work" -> wrap("submission", submitWork(a, b));
            case "review_submission" -> ok(reviewSubmission(a, b));
            case "finalize_delivery" -> wrap("report", finalizeDelivery(a, b));
            case "update_compensation" -> wrap("compensation", updateCompensation(a, b));
            default -> throw new AppError(400, "UNKNOWN_ACTION", "Unsupported business action.");
        };
    }
    static ObjectNode wrap(String k, JsonNode v) { var o = M.createObjectNode().put("ok", true); o.set(k, v); return o; }
    static ObjectNode ok(ObjectNode v) { var o = M.createObjectNode().put("ok", true); o.setAll(v); return o; }

    // ---------- operator: project review ----------
    JsonNode reviewProject(Actor a, JsonNode b) throws Exception {
        role(a, OPERATOR_ROLES);
        String pid = req(b, "projectId"), ns = req(b, "newStatus");
        if (!PROJECT_STATUSES.contains(ns)) throw new AppError(400, "INVALID_PROJECT_STATUS", "Unknown project status.");
        Double est = num(b, "estimatedCostCents");
        if (est != null && (est < 0 || est != Math.floor(est))) throw new AppError(400, "INVALID_ESTIMATE", "estimatedCostCents must be a non-negative integer.");
        return db.tx(c -> {
            var p = one(c, "SELECT id, client_user_id, title, status FROM business_projects WHERE id=? FOR UPDATE", pid);
            if (p == null) throw new AppError(404, "PROJECT_NOT_FOUND", "Business project not found.");
            exec(c, """
                UPDATE business_projects SET status=?, operator_notes=COALESCE(?,operator_notes), acceptance_criteria=COALESCE(?,acceptance_criteria),
                  estimated_cost_cents=COALESCE(?,estimated_cost_cents), reviewed_by_user_id=?, updated_at=NOW() WHERE id=?""",
                ns, opt(b, "operatorNotes"), opt(b, "acceptanceCriteriaOverride"), est == null ? null : est.longValue(), a.id(), pid);
            Db.notify(c, p.get("client_user_id").asText(), "PROJECT_STATUS", "Statut du projet mis à jour : " + ns,
                    "Votre projet \"" + p.get("title").asText() + "\" est passé de " + p.get("status").asText() + " à " + ns + ".");
            audit(c, a, "PROJECT_STATUS_TRANSITIONED", "PROJECT", pid, "SUCCESS",
                    meta().put("previousStatus", p.get("status").asText()).put("newStatus", ns).put("operatorNotes", opt(b, "operatorNotes")));
            return one(c, "SELECT * FROM business_projects WHERE id=?", pid);
        });
    }

    // ---------- talent ----------
    JsonNode upsertTalentProfile(Actor a, JsonNode b) throws Exception {
        role(a, Set.of("contributor", "reviewer", "operator", "admin"));
        String target = opt(b, "targetUserId") != null && OPERATOR_ROLES.contains(a.role()) ? opt(b, "targetUserId") : a.id();
        String headline = req(b, "headline"), country = req(b, "country");
        Double hours = num(b, "availabilityHoursPerWeek");
        int h = hours == null ? 20 : hours.intValue();
        if (h < 0 || h > 168) throw new AppError(400, "INVALID_AVAILABILITY", "availabilityHoursPerWeek must be between 0 and 168.");
        String status = opt(b, "availabilityStatus") == null ? "AVAILABLE" : str(b, "availabilityStatus");
        if (!AVAILABILITY.contains(status)) throw new AppError(400, "INVALID_AVAILABILITY", "Invalid availability status.");
        boolean cv = bool(b, "consentVoiceDataset"), cc = bool(b, "consentLinguisticCorpus");
        var langs = M.valueToTree(strs(b, "nativeLanguages")); var dialects = M.valueToTree(strs(b, "dialects")); var skills = M.valueToTree(strs(b, "skills"));
        JsonNode samples = b.has("workSamples") && b.get("workSamples").isArray() ? b.get("workSamples") : M.createArrayNode();
        return db.tx(c -> {
            if (one(c, "SELECT id FROM users WHERE id=?", target) == null) throw new AppError(404, "USER_NOT_FOUND", "Target user does not exist.");
            var signed = cv || cc ? new java.sql.Timestamp(System.currentTimeMillis()) : null;
            var ex = one(c, "SELECT id FROM talent_profiles WHERE user_id=? FOR UPDATE", target);
            String profileId;
            if (ex != null) {
                profileId = ex.get("id").asText();
                exec(c, """
                    UPDATE talent_profiles SET headline=?, country=?, native_languages_json=?::jsonb, dialects_json=?::jsonb, skills_json=?::jsonb,
                      work_samples_json=?::jsonb, availability_hours_per_week=?, availability_status=?, consent_voice_dataset=?, consent_linguistic_corpus=?,
                      consent_signed_at=COALESCE(?,consent_signed_at), updated_at=NOW() WHERE user_id=?""",
                    headline, country, langs, dialects, skills, samples, h, status, cv, cc, signed, target);
            } else {
                profileId = BusinessServer.newId("tal");
                exec(c, """
                    INSERT INTO talent_profiles (id,user_id,headline,country,native_languages_json,dialects_json,skills_json,work_samples_json,
                      availability_hours_per_week,availability_status,consent_voice_dataset,consent_linguistic_corpus,consent_signed_at)
                    VALUES (?,?,?,?,?::jsonb,?::jsonb,?::jsonb,?::jsonb,?,?,?,?,?)""",
                    profileId, target, headline, country, langs, dialects, skills, samples, h, status, cv, cc, signed);
            }
            var m = meta().put("targetUserId", target).put("note", "Claimed languages remain UNVERIFIED until a corresponding assessment is passed.");
            m.set("claimedLanguages", langs);
            audit(c, a, "TALENT_PROFILE_SAVED", "TALENT_PROFILE", profileId, "SUCCESS", m);
            return talent(c, target);
        });
    }

    JsonNode recordAssessment(Actor a, JsonNode b) throws Exception {
        role(a, OPERATOR_ROLES);
        String talent = req(b, "talentUserId"), type = req(b, "assessmentType"), skill = req(b, "skillName");
        if (!ASSESSMENT_TYPES.contains(type)) throw new AppError(400, "INVALID_ASSESSMENT_TYPE", "Invalid assessment type.");
        Double score = num(b, "score"); Double pass = num(b, "passingScore");
        if (score == null || score < 0 || score > 100) throw new AppError(400, "INVALID_SCORE", "Assessment score must be between 0 and 100.");
        double ps = pass == null ? 75 : pass;
        if (ps < 0 || ps > 100) throw new AppError(400, "INVALID_SCORE", "Passing score must be between 0 and 100.");
        String lang = opt(b, "languageCode") == null ? null : str(b, "languageCode").toLowerCase(Locale.ROOT);
        if ("LANGUAGE_PROFICIENCY".equals(type) && lang == null) throw new AppError(400, "MISSING_LANGUAGE", "languageCode is required for a language assessment.");
        boolean passed = score >= ps;
        return db.tx(c -> {
            if (one(c, "SELECT id FROM users WHERE id=?", talent) == null) throw new AppError(404, "USER_NOT_FOUND", "Talent user does not exist.");
            String id = BusinessServer.newId("asr");
            exec(c, """
                INSERT INTO talent_assessments (id,talent_user_id,assessment_type,language_code,dialect,skill_name,score,passing_score,passed,verified_by_user_id,notes)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""", id, talent, type, lang, opt(b, "dialect"), skill, score, ps, passed, a.id(), opt(b, "notes"));
            audit(c, a, "TALENT_ASSESSMENT_RECORDED", "TALENT_ASSESSMENT", id, "SUCCESS", meta().put("talentUserId", talent).put("assessmentType", type)
                    .put("languageCode", lang).put("score", score).put("passingScore", ps).put("passed", passed));
            return one(c, "SELECT * FROM talent_assessments WHERE id=?", id);
        });
    }

    /** getTalentProfileWithVerification: a language is verified ONLY by a passed LANGUAGE_PROFICIENCY assessment. */
    static ObjectNode talent(Connection c, String uid) throws Exception {
        var profile = one(c, "SELECT * FROM talent_profiles WHERE user_id=?", uid);
        var user = one(c, "SELECT id, full_name, email, role FROM users WHERE id=?", uid);
        var as = rows(c, "SELECT * FROM talent_assessments WHERE talent_user_id=? ORDER BY evaluated_at DESC", uid);
        var verified = new LinkedHashSet<String>(); var domain = new ArrayList<String>();
        for (var x : as) {
            if (!x.get("passed").asBoolean()) continue;
            if ("LANGUAGE_PROFICIENCY".equals(x.get("assessment_type").asText())) { if (!x.get("language_code").isNull()) verified.add(x.get("language_code").asText().toLowerCase(Locale.ROOT)); }
            else domain.add(x.get("skill_name").asText());
        }
        var unverified = new ArrayList<String>();
        if (profile != null) for (var l : list(profile.get("native_languages_json"))) { var ll = l.toLowerCase(Locale.ROOT); if (!verified.contains(ll)) unverified.add(ll); }
        var o = M.createObjectNode();
        o.set("user", user == null ? M.nullNode() : user); o.set("profile", profile == null ? M.nullNode() : profile); o.set("assessments", as);
        var vs = o.putObject("verificationSummary");
        vs.set("verifiedLanguages", M.valueToTree(verified)); vs.set("unverifiedClaimedLanguages", M.valueToTree(unverified));
        vs.set("passedDomainSkills", M.valueToTree(domain)); vs.put("hasVerifiedLanguageSkills", !verified.isEmpty());
        return o;
    }

    public JsonNode matches(Actor a, String projectId) throws Exception {
        role(a, OPERATOR_ROLES);
        return db.tx(c -> {
            var p = one(c, "SELECT * FROM business_projects WHERE id=?", projectId);
            if (p == null) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found.");
            var tl = list(p.get("target_languages_json")); var td = list(p.get("target_dialects_json"));
            var cands = new ArrayList<ObjectNode>();
            for (var r : rows(c, "SELECT user_id FROM talent_profiles")) {
                var d = talent(c, r.get("user_id").asText());
                if (d.get("profile").isNull() || d.get("user").isNull()) continue;
                var pr = d.get("profile"); var vs = d.get("verificationSummary");
                var res = Matching.score(tl, td, new Matching.Candidate(list(vs.get("verifiedLanguages")), list(pr.get("native_languages_json")),
                        list(pr.get("dialects_json")), list(vs.get("passedDomainSkills")), pr.get("availability_status").asText(), pr.get("availability_hours_per_week").asInt()));
                var u = d.get("user");
                var o = M.createObjectNode().put("userId", u.get("id").asText()).put("fullName", u.get("full_name").asText()).put("email", u.get("email").asText())
                        .put("role", u.get("role").asText()).put("headline", pr.get("headline").asText()).put("country", pr.get("country").asText())
                        .put("matchScore", res.score()).put("eligibleForVerifiedAssignment", res.eligible());
                o.set("verifiedLanguages", vs.get("verifiedLanguages")); o.set("unverifiedClaimedLanguages", vs.get("unverifiedClaimedLanguages"));
                o.set("passedDomainSkills", vs.get("passedDomainSkills")); o.set("explanationReasons", M.valueToTree(res.reasons()));
                cands.add(o);
            }
            cands.sort((x, y) -> Double.compare(y.get("matchScore").asDouble(), x.get("matchScore").asDouble()));
            var out = M.createObjectNode().put("ok", true).put("projectId", projectId).put("projectTitle", p.get("title").asText());
            out.set("targetLanguages", M.valueToTree(tl.stream().map(s -> s.toLowerCase(Locale.ROOT)).toList()));
            out.set("candidates", M.valueToTree(cands));
            return out;
        });
    }

    // ---------- tasks / deliverable lifecycle ----------
    ObjectNode createAssignTask(Actor a, JsonNode b) throws Exception {
        role(a, OPERATOR_ROLES);
        String pid = req(b, "projectId"), title = req(b, "title"), instr = req(b, "instructions"), contributor = req(b, "assignedContributorId");
        String lang = req(b, "languageCode").toLowerCase(Locale.ROOT), reviewer = opt(b, "assignedReviewerId"), src = opt(b, "sourceFileId");
        Double comp = num(b, "compensationCents");
        if (comp == null || comp < 0 || comp != Math.floor(comp)) throw new AppError(400, "INVALID_COMPENSATION", "compensationCents must be a non-negative integer.");
        String currency = opt(b, "currency") == null ? "USD" : str(b, "currency").toUpperCase(Locale.ROOT);
        if (!currency.matches("[A-Z]{3}")) throw new AppError(400, "INVALID_CURRENCY", "Currency must be an ISO-4217 code.");
        if (contributor.equals(reviewer)) throw new AppError(400, "REVIEWER_IS_CONTRIBUTOR", "The assigned reviewer cannot be the contributor of the same task.");
        boolean requireVerified = !(b.has("requireVerifiedLanguage") && b.get("requireVerifiedLanguage").isBoolean() && !b.get("requireVerifiedLanguage").asBoolean());
        return db.tx(c -> {
            var p = one(c, "SELECT id, title, status FROM business_projects WHERE id=? FOR UPDATE", pid);
            if (p == null) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found.");
            var t = talent(c, contributor);
            if (t.get("user").isNull()) throw new AppError(404, "CONTRIBUTOR_NOT_FOUND", "Assigned contributor user does not exist.");
            if (reviewer != null) {
                var r = one(c, "SELECT role FROM users WHERE id=?", reviewer);
                if (r == null) throw new AppError(404, "REVIEWER_NOT_FOUND", "Assigned reviewer does not exist.");
                if (!Set.of("reviewer", "operator", "admin").contains(r.get("role").asText())) throw new AppError(400, "INVALID_REVIEWER_ROLE", "Assigned reviewer must have a reviewer, operator or admin role.");
            }
            var verified = list(t.at("/verificationSummary/verifiedLanguages"));
            if (requireVerified && !verified.contains(lang)) {
                var m = meta().put("contributorUserId", contributor).put("requiredLanguage", lang);
                m.set("verifiedLanguages", t.at("/verificationSummary/verifiedLanguages")); m.set("unverifiedClaimedLanguages", t.at("/verificationSummary/unverifiedClaimedLanguages"));
                throw new Db.Denied(400, "UNVERIFIED_LANGUAGE_PROFICIENCY", "Contributor '" + t.at("/user/full_name").asText() + "' has NOT passed a verified proficiency assessment for language '" + lang
                        + "'. SOLOB+ forbids assigning contributors to language-specific tasks without a passed assessment.", a, "TASK_ASSIGNMENT_BLOCKED_UNVERIFIED_LANGUAGE", "PROJECT", pid, m);
            }
            if (src != null) {
                var f = one(c, "SELECT pillar, task_id FROM stored_files WHERE id=? FOR UPDATE", src);
                if (f == null) throw new AppError(404, "FILE_NOT_FOUND", "Source file not found.");
                if (!"business".equals(f.get("pillar").asText())) throw new AppError(400, "INVALID_SOURCE_FILE", "Only Business files can be attached to a Business task.");
                if (!f.get("task_id").isNull()) throw new AppError(409, "SOURCE_FILE_ALREADY_BOUND", "This file is already bound to another task.");
            }
            var team = one(c, "SELECT id FROM project_teams WHERE project_id=? ORDER BY created_at LIMIT 1", pid);
            String teamId;
            if (team != null) teamId = team.get("id").asText();
            else { teamId = BusinessServer.newId("tem"); exec(c, "INSERT INTO project_teams (id,project_id,name,lead_operator_id) VALUES (?,?,?,?)", teamId, pid, "Équipe " + p.get("title").asText(), a.id()); }
            var expl = meta().put("verifiedLanguage", lang); expl.set("verifiedLanguagesList", t.at("/verificationSummary/verifiedLanguages"));
            exec(c, """
                INSERT INTO project_team_members (id,team_id,project_id,user_id,member_role,match_score,match_explanation_json,assigned_by_user_id)
                VALUES (?,?,?,?,'CONTRIBUTOR',92.0,?::jsonb,?) ON CONFLICT (project_id,user_id,member_role) DO NOTHING""",
                BusinessServer.newId("ptm"), teamId, pid, contributor, expl, a.id());
            String taskId = BusinessServer.newId("tsk");
            exec(c, """
                INSERT INTO business_tasks (id,project_id,assigned_contributor_id,assigned_reviewer_id,title,instructions,language_code,dialect,source_file_id,
                  status,compensation_cents,currency,due_date,created_by_user_id) VALUES (?,?,?,?,?,?,?,?,?,'ASSIGNED',?,?,?,?)""",
                taskId, pid, contributor, reviewer, title, instr, lang, opt(b, "dialect"), src, comp.longValue(), currency, opt(b, "dueDate"), a.id());
            if (src != null) exec(c, "UPDATE stored_files SET visibility='assigned_task', project_id=?, task_id=? WHERE id=?", pid, taskId, src);
            String compId = BusinessServer.newId("cmp");
            exec(c, """
                INSERT INTO compensation_records (id,project_id,task_id,contributor_user_id,amount_cents,currency,payment_status,provider_mode,audit_note)
                VALUES (?,?,?,?,?,?,'PENDING','DISABLED_NO_LIVE_TRANSFER',?)""", compId, pid, taskId, contributor, comp.longValue(), currency,
                "Task assigned; compensation escrowed in PENDING status (no live money transfer configured).");
            exec(c, "UPDATE business_projects SET status='IN_EXECUTION', updated_at=NOW() WHERE id=? AND status IN ('SUBMITTED','UNDER_REVIEW','APPROVED_ACTIVE')", pid);
            Db.notify(c, contributor, "TASK_ASSIGNED", "Nouvelle tâche assignée : " + title, "Une tâche vérifiée (" + lang.toUpperCase(Locale.ROOT) + ") vous a été attribuée.");
            audit(c, a, "TASK_CREATED_AND_ASSIGNED", "TASK", taskId, "SUCCESS", meta().put("projectId", pid).put("assignedContributorId", contributor)
                    .put("assignedReviewerId", reviewer).put("languageCode", lang).put("compensationCents", comp.longValue()));
            var out = M.createObjectNode();
            out.set("task", one(c, "SELECT * FROM business_tasks WHERE id=?", taskId));
            out.set("compensation", one(c, "SELECT * FROM compensation_records WHERE id=?", compId));
            return out;
        });
    }

    static boolean canSeeTask(Actor a, JsonNode t) {
        String contributor = t.get("assigned_contributor_id").isNull() ? null : t.get("assigned_contributor_id").asText();
        String reviewer = t.get("assigned_reviewer_id").isNull() ? null : t.get("assigned_reviewer_id").asText();
        return OPERATOR_ROLES.contains(a.role())
                || ("contributor".equals(a.role()) && a.id().equals(contributor))
                || ("reviewer".equals(a.role()) && (a.id().equals(reviewer) || reviewer == null));
    }

    public JsonNode task(Actor a, String taskId) throws Exception {
        return db.tx(c -> {
            var t = one(c, "SELECT * FROM business_tasks WHERE id=?", taskId);
            if (t == null) throw new AppError(404, "TASK_NOT_FOUND", "Task not found.");
            if (!canSeeTask(a, t)) {
                String contributor = t.get("assigned_contributor_id").isNull() ? null : t.get("assigned_contributor_id").asText();
                throw new Db.Denied(403, "FORBIDDEN_TASK_ACCESS", "You are not authorized to view or access this task. Contributors may only access tasks explicitly assigned to them.",
                        a, "UNAUTHORIZED_TASK_ACCESS_ATTEMPT", "TASK", taskId, meta().put("assignedContributorId", contributor).put("requestingUserId", a.id()));
            }
            var out = M.createObjectNode().put("ok", true);
            out.set("task", t);
            out.set("submissions", rows(c, "SELECT * FROM task_submissions WHERE task_id=? ORDER BY revision_number DESC", taskId));
            out.set("reviews", rows(c, "SELECT * FROM task_reviews WHERE task_id=? ORDER BY reviewed_at DESC", taskId));
            return out;
        });
    }

    JsonNode submitWork(Actor a, JsonNode b) throws Exception {
        role(a, Set.of("contributor", "operator", "admin"));
        String taskId = req(b, "taskId"), content = str(b, "contentText"), att = opt(b, "attachmentFileId");
        if (content.length() > 200_000) throw new AppError(400, "INVALID_SUBMISSION_CONTENT", "Submission content is too long.");
        JsonNode payload = b.has("structuredPayload") && b.get("structuredPayload").isObject() ? b.get("structuredPayload") : M.createObjectNode();
        return db.tx(c -> {
            var t = one(c, "SELECT * FROM business_tasks WHERE id=? FOR UPDATE", taskId);
            if (t == null) throw new AppError(404, "TASK_NOT_FOUND", "Task not found.");
            String assignee = t.get("assigned_contributor_id").isNull() ? null : t.get("assigned_contributor_id").asText();
            if ("contributor".equals(a.role()) && !a.id().equals(assignee))
                throw new Db.Denied(403, "FORBIDDEN_TASK_SUBMISSION", "You cannot submit work for a task not assigned to you.", a,
                        "UNAUTHORIZED_TASK_SUBMISSION_ATTEMPT", "TASK", taskId, meta().put("assignedContributorId", assignee));
            if (content.length() < 5) throw new AppError(400, "INVALID_SUBMISSION_CONTENT", "Submission content is required (min 5 characters).");
            String st = t.get("status").asText();
            if (st.equals("APPROVED") || st.equals("REJECTED")) throw new AppError(409, "TASK_CLOSED", "This task is closed (" + st + "); no new revision can be submitted.");
            if (att != null) {
                var f = one(c, "SELECT owner_user_id, pillar, task_id FROM stored_files WHERE id=? FOR UPDATE", att);
                if (f == null) throw new AppError(404, "FILE_NOT_FOUND", "Attachment not found.");
                if (!f.get("owner_user_id").asText().equals(a.id()) || !"business".equals(f.get("pillar").asText())
                        || (!f.get("task_id").isNull() && !f.get("task_id").asText().equals(taskId)))
                    throw new AppError(403, "FORBIDDEN_ATTACHMENT", "You can only attach your own Business files.");
                exec(c, "UPDATE stored_files SET visibility='assigned_task', project_id=?, task_id=? WHERE id=?", t.get("project_id").asText(), taskId, att);
            }
            int rev = one(c, "SELECT COALESCE(MAX(revision_number),0)+1 AS n FROM task_submissions WHERE task_id=?", taskId).get("n").asInt();
            String sid = BusinessServer.newId("tsb");
            exec(c, """
                INSERT INTO task_submissions (id,task_id,project_id,contributor_user_id,revision_number,content_text,structured_payload_json,language_code,dialect,attachment_file_id,contributor_notes)
                VALUES (?,?,?,?,?,?,?::jsonb,?,?,?,?)""", sid, taskId, t.get("project_id").asText(), a.id(), rev, content, payload,
                t.get("language_code").asText(), opt(b, "dialect") != null ? opt(b, "dialect") : (t.get("dialect").isNull() ? null : t.get("dialect").asText()), att, opt(b, "contributorNotes"));
            exec(c, "UPDATE business_tasks SET status='SUBMITTED', updated_at=NOW() WHERE id=?", taskId);
            audit(c, a, "TASK_WORK_SUBMITTED", "TASK_SUBMISSION", sid, "SUCCESS", meta().put("taskId", taskId).put("projectId", t.get("project_id").asText())
                    .put("revisionNumber", rev).put("languageCode", t.get("language_code").asText()));
            return one(c, "SELECT * FROM task_submissions WHERE id=?", sid);
        });
    }

    ObjectNode reviewSubmission(Actor a, JsonNode b) throws Exception {
        role(a, Set.of("reviewer", "operator", "admin"));
        String sid = req(b, "submissionId"), decision = req(b, "decision"), feedback = str(b, "feedback");
        if (!DECISIONS.contains(decision)) throw new AppError(400, "INVALID_DECISION", "Invalid review decision.");
        Double q = num(b, "qualityScore"), acc = num(b, "accuracyScore"), fid = num(b, "linguisticFidelityScore");
        for (Double d : new Double[]{q, acc, fid}) if (d != null && (d < 0 || d > 100)) throw new AppError(400, "INVALID_QUALITY_SCORE", "Quality score must be between 0 and 100.");
        if (q == null) throw new AppError(400, "INVALID_QUALITY_SCORE", "Quality score must be between 0 and 100.");
        if (feedback.length() < 3) throw new AppError(400, "MISSING_REVIEW_FEEDBACK", "Reviewer feedback is required.");
        return db.tx(c -> {
            var s = one(c, "SELECT * FROM task_submissions WHERE id=?", sid);
            if (s == null) throw new AppError(404, "SUBMISSION_NOT_FOUND", "Task submission not found.");
            String taskId = s.get("task_id").asText();
            var t = one(c, "SELECT * FROM business_tasks WHERE id=? FOR UPDATE", taskId);
            // Rule: nobody reviews their own deliverable (also covers operators/admins who submitted themselves).
            if (a.id().equals(s.get("contributor_user_id").asText()) || a.id().equals(t.get("assigned_contributor_id").asText(null)))
                throw new Db.Denied(403, "SELF_REVIEW_FORBIDDEN", "You cannot review your own deliverable.", a, "SELF_REVIEW_BLOCKED", "TASK_SUBMISSION", sid,
                        meta().put("taskId", taskId));
            if ("reviewer".equals(a.role()) && !canSeeTask(a, t))
                throw new Db.Denied(403, "FORBIDDEN_TASK_REVIEW", "You are not the reviewer assigned to this task.", a, "UNAUTHORIZED_TASK_REVIEW_ATTEMPT", "TASK_SUBMISSION", sid,
                        meta().put("taskId", taskId).put("assignedReviewerId", t.get("assigned_reviewer_id").asText(null)));
            var latest = one(c, "SELECT id FROM task_submissions WHERE task_id=? ORDER BY revision_number DESC LIMIT 1", taskId);
            if (!"SUBMITTED".equals(t.get("status").asText()) || !sid.equals(latest.get("id").asText()))
                throw new AppError(409, "SUBMISSION_NOT_REVIEWABLE", "Only the latest revision of a task awaiting review can be reviewed.");
            String rid = BusinessServer.newId("rev");
            exec(c, """
                INSERT INTO task_reviews (id,submission_id,task_id,reviewer_user_id,decision,quality_score,accuracy_score,linguistic_fidelity_score,disagreement_flag,disagreement_resolution_notes,feedback)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)""", rid, sid, taskId, a.id(), decision, q, acc == null ? q : acc, fid == null ? q : fid,
                bool(b, "disagreementFlag"), opt(b, "disagreementResolutionNotes"), feedback);
            String ns = switch (decision) { case "APPROVE" -> "APPROVED"; case "REQUEST_REVISION" -> "REVISION_REQUESTED"; default -> "REJECTED"; };
            exec(c, "UPDATE business_tasks SET status=?, updated_at=NOW() WHERE id=?", ns, taskId);
            String qs = new java.math.BigDecimal(q).stripTrailingZeros().toPlainString();
            if (decision.equals("APPROVE"))
                exec(c, "UPDATE compensation_records SET payment_status='APPROVED', approved_by_user_id=?, audit_note=?, updated_at=NOW() WHERE task_id=?",
                        a.id(), "Approved after QA review (" + rid + ") with quality score " + qs + "/100.", taskId);
            else if (decision.equals("REJECT"))
                exec(c, "UPDATE compensation_records SET payment_status='HELD', audit_note=?, updated_at=NOW() WHERE task_id=?", "Held due to submission rejection (" + rid + ").", taskId);
            Db.notify(c, s.get("contributor_user_id").asText(), "TASK_REVIEWED", "Révision QA terminée : " + decision,
                    "Votre soumission (rév. #" + s.get("revision_number").asInt() + ") a reçu la décision " + decision + " (Score qualité : " + qs + "/100).");
            audit(c, a, "TASK_SUBMISSION_REVIEWED", "TASK_REVIEW", rid, "SUCCESS", meta().put("submissionId", sid).put("taskId", taskId)
                    .put("decision", decision).put("qualityScore", q).put("newTaskStatus", ns));
            var out = M.createObjectNode();
            out.set("review", one(c, "SELECT * FROM task_reviews WHERE id=?", rid));
            out.set("task", one(c, "SELECT * FROM business_tasks WHERE id=?", taskId));
            var comp = one(c, "SELECT * FROM compensation_records WHERE task_id=?", taskId);
            out.set("compensation", comp == null ? M.nullNode() : comp);
            return out;
        });
    }

    JsonNode finalizeDelivery(Actor a, JsonNode b) throws Exception {
        role(a, OPERATOR_ROLES);
        String pid = req(b, "projectId"), title = req(b, "title"), summary = req(b, "executiveSummary");
        return db.tx(c -> {
            var p = one(c, "SELECT * FROM business_projects WHERE id=? FOR UPDATE", pid);
            if (p == null) throw new AppError(404, "PROJECT_NOT_FOUND", "Project not found.");
            var tasks = rows(c, "SELECT id, title, language_code, dialect, assigned_contributor_id FROM business_tasks WHERE project_id=? AND status='APPROVED'", pid);
            if (tasks.isEmpty()) throw new AppError(400, "NO_APPROVED_TASKS", "Cannot finalize project delivery before at least one task is QA-approved.");
            var avg = one(c, """
                SELECT COUNT(*) AS n, ROUND(AVG(r.quality_score),2) AS q, ROUND(AVG(r.linguistic_fidelity_score),2) AS f
                FROM task_reviews r JOIN business_tasks t ON t.id=r.task_id WHERE t.project_id=? AND r.decision='APPROVE'""", pid);
            boolean any = avg.get("n").asLong() > 0;
            double aq = any ? avg.get("q").asDouble() : 90.0, af = any ? avg.get("f").asDouble() : 90.0;
            ArrayNode deliverables = M.createArrayNode();
            for (var t : tasks) {
                var d = deliverables.addObject().put("taskId", t.get("id").asText()).put("taskTitle", t.get("title").asText()).put("languageCode", t.get("language_code").asText());
                d.set("dialect", t.get("dialect"));
                var ls = one(c, "SELECT id, revision_number, content_text, language_code, dialect, submitted_at FROM task_submissions WHERE task_id=? ORDER BY revision_number DESC LIMIT 1", t.get("id").asText());
                d.set("latestSubmission", ls == null ? M.nullNode() : ls);
            }
            String rid = BusinessServer.newId("dlv");
            var metrics = meta().put("averageQualityScore", aq).put("averageLinguisticFidelityScore", af).put("approvedTasksCount", tasks.size()).put("qaVerified", true);
            exec(c, """
                INSERT INTO delivery_reports (id,project_id,prepared_by_user_id,title,executive_summary,deliverables_summary_json,quality_metrics_json,total_tasks_approved,average_quality_score,client_authorized)
                VALUES (?,?,?,?,?,?::jsonb,?::jsonb,?,?,TRUE)""", rid, pid, a.id(), title, summary, deliverables, metrics, tasks.size(), aq);
            exec(c, "UPDATE business_projects SET status='DELIVERED', updated_at=NOW() WHERE id=?", pid);
            exec(c, """
                UPDATE compensation_records SET payment_status='READY_FOR_PAYOUT',
                  audit_note=COALESCE(audit_note,'') || ' | Project delivered (' || ? || '); ready for payout once payment provider is enabled.', updated_at=NOW()
                WHERE project_id=? AND payment_status='APPROVED'""", rid, pid);
            Db.notify(c, p.get("client_user_id").asText(), "PROJECT_DELIVERED", "Livrable final disponible : " + title,
                    "Le rapport de livraison officiel pour \"" + p.get("title").asText() + "\" est prêt pour consultation.");
            audit(c, a, "PROJECT_DELIVERABLES_FINALIZED", "DELIVERY_REPORT", rid, "SUCCESS", meta().put("projectId", pid).put("totalTasksApproved", tasks.size()).put("averageQualityScore", aq));
            return one(c, "SELECT * FROM delivery_reports WHERE id=?", rid);
        });
    }

    public JsonNode report(Actor a, String reportId) throws Exception {
        role(a, Set.of("org_client", "operator", "admin"));
        return db.tx(c -> {
            var r = one(c, "SELECT dr.*, p.client_user_id, p.title AS project_title, p.service_mode FROM delivery_reports dr JOIN business_projects p ON p.id=dr.project_id WHERE dr.id=?", reportId);
            if (r == null) throw new AppError(404, "DELIVERY_REPORT_NOT_FOUND", "Delivery report not found.");
            if ("org_client".equals(a.role()) && !a.id().equals(r.get("client_user_id").asText()))
                throw new Db.Denied(403, "FORBIDDEN_DELIVERY_REPORT", "You are not authorized to view another organization’s delivery report.", a,
                        "DELIVERY_REPORT_ACCESS_DENIED", "DELIVERY_REPORT", reportId, meta().put("reportProjectClientId", r.get("client_user_id").asText()).put("requestingUserId", a.id()));
            return wrap("report", r);
        });
    }

    JsonNode updateCompensation(Actor a, JsonNode b) throws Exception {
        role(a, OPERATOR_ROLES);
        String id = req(b, "compensationId"), ns = req(b, "newStatus");
        if (bool(b, "attemptLiveTransfer")) {
            // No live payment provider exists in this rewrite: live transfers are always refused (PAYMENT_PROVIDER is not consulted).
            String provider = Optional.ofNullable(System.getenv("PAYMENT_PROVIDER")).orElse("disabled");
            return db.tx(c -> { throw new Db.Denied(400, "LIVE_TRANSFER_DISABLED",
                    "Live real-money transfers are disabled until a payment provider is configured, legally verified, and tested in sandbox.", a,
                    "LIVE_MONEY_TRANSFER_BLOCKED", "COMPENSATION", id, meta().put("reason", "PAYMENT_PROVIDER_DISABLED_BY_POLICY").put("paymentProvider", provider)); });
        }
        if (!PAY_STATUSES.contains(ns)) throw new AppError(400, "INVALID_PAYMENT_STATUS", "Invalid payment status.");
        return db.tx(c -> {
            var cur = one(c, "SELECT * FROM compensation_records WHERE id=? FOR UPDATE", id);
            if (cur == null) throw new AppError(404, "COMPENSATION_NOT_FOUND", "Compensation record not found.");
            String mode = ns.equals("PAID_SIMULATED") ? "SANDBOX_SIMULATED" : "DISABLED_NO_LIVE_TRANSFER";
            String prev = cur.get("payment_status").asText();
            exec(c, "UPDATE compensation_records SET payment_status=?, provider_mode=?, approved_by_user_id=?, audit_note=COALESCE(?,audit_note), updated_at=NOW() WHERE id=?",
                    ns, mode, a.id(), opt(b, "auditNote") != null ? opt(b, "auditNote") : "Status updated from " + prev + " to " + ns + " (Simulated/Audited).", id);
            audit(c, a, "COMPENSATION_STATUS_UPDATED", "COMPENSATION", id, "SUCCESS", meta().put("previousStatus", prev).put("newStatus", ns)
                    .put("providerMode", mode).put("amountCents", cur.get("amount_cents").asLong()));
            return one(c, "SELECT * FROM compensation_records WHERE id=?", id);
        });
    }

    // ---------- workspace ----------
    public JsonNode workspace(Actor a) throws Exception {
        return db.tx(c -> {
            String r = a.role(); boolean op = OPERATOR_ROLES.contains(r);
            var o = M.createObjectNode();
            o.set("projects", op ? rows(c, "SELECT p.*, o.name AS organization_name FROM business_projects p JOIN organizations o ON o.id=p.organization_id ORDER BY p.created_at DESC")
                    : r.equals("org_client") ? rows(c, "SELECT p.*, o.name AS organization_name FROM business_projects p JOIN organizations o ON o.id=p.organization_id WHERE p.client_user_id=? ORDER BY p.created_at DESC", a.id())
                    : rows(c, """
                        SELECT DISTINCT p.id, p.title, p.service_mode, p.service_category, p.status, p.target_languages_json, p.deadline_date, o.name AS organization_name
                        FROM business_projects p JOIN organizations o ON o.id=p.organization_id JOIN business_tasks t ON t.project_id=p.id
                        WHERE t.assigned_contributor_id=? OR t.assigned_reviewer_id=?""", a.id(), a.id()));
            // Divergence: a reviewer only sees tasks/submissions it may act on (assigned to it or unassigned), consistent with the task-detail ACL.
            o.set("tasks", op ? rows(c, "SELECT t.*, p.title AS project_title, u.full_name AS contributor_name FROM business_tasks t JOIN business_projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assigned_contributor_id ORDER BY t.created_at DESC")
                    : r.equals("reviewer") ? rows(c, "SELECT t.*, p.title AS project_title, u.full_name AS contributor_name FROM business_tasks t JOIN business_projects p ON p.id=t.project_id LEFT JOIN users u ON u.id=t.assigned_contributor_id WHERE (t.assigned_reviewer_id=? OR t.assigned_reviewer_id IS NULL) AND t.assigned_contributor_id IS DISTINCT FROM ? ORDER BY t.created_at DESC", a.id(), a.id())
                    : r.equals("contributor") ? rows(c, "SELECT t.*, p.title AS project_title FROM business_tasks t JOIN business_projects p ON p.id=t.project_id WHERE t.assigned_contributor_id=? ORDER BY t.created_at DESC", a.id())
                    : rows(c, "SELECT t.id, t.project_id, t.title, t.language_code, t.dialect, t.status, t.due_date, p.title AS project_title FROM business_tasks t JOIN business_projects p ON p.id=t.project_id WHERE p.client_user_id=? ORDER BY t.created_at DESC", a.id()));
            o.set("submissions", op ? rows(c, "SELECT s.*, t.title AS task_title, u.full_name AS contributor_name FROM task_submissions s JOIN business_tasks t ON t.id=s.task_id JOIN users u ON u.id=s.contributor_user_id ORDER BY s.submitted_at DESC")
                    : r.equals("reviewer") ? rows(c, "SELECT s.*, t.title AS task_title, u.full_name AS contributor_name FROM task_submissions s JOIN business_tasks t ON t.id=s.task_id JOIN users u ON u.id=s.contributor_user_id WHERE (t.assigned_reviewer_id=? OR t.assigned_reviewer_id IS NULL) AND s.contributor_user_id<>? ORDER BY s.submitted_at DESC", a.id(), a.id())
                    : r.equals("contributor") ? rows(c, "SELECT s.*, t.title AS task_title FROM task_submissions s JOIN business_tasks t ON t.id=s.task_id WHERE s.contributor_user_id=? ORDER BY s.submitted_at DESC", a.id())
                    : M.createArrayNode());
            o.set("deliveryReports", op ? rows(c, "SELECT dr.*, p.title AS project_title FROM delivery_reports dr JOIN business_projects p ON p.id=dr.project_id ORDER BY dr.finalized_at DESC")
                    : r.equals("org_client") ? rows(c, "SELECT dr.*, p.title AS project_title FROM delivery_reports dr JOIN business_projects p ON p.id=dr.project_id WHERE p.client_user_id=? ORDER BY dr.finalized_at DESC", a.id())
                    : M.createArrayNode());
            o.set("compensations", op ? rows(c, "SELECT c.*, t.title AS task_title, p.title AS project_title, u.full_name AS contributor_name FROM compensation_records c JOIN business_tasks t ON t.id=c.task_id JOIN business_projects p ON p.id=c.project_id JOIN users u ON u.id=c.contributor_user_id ORDER BY c.created_at DESC")
                    : r.equals("contributor") ? rows(c, "SELECT c.*, t.title AS task_title, p.title AS project_title FROM compensation_records c JOIN business_tasks t ON t.id=c.task_id JOIN business_projects p ON p.id=c.project_id WHERE c.contributor_user_id=? ORDER BY c.created_at DESC", a.id())
                    : M.createArrayNode());
            var dir = M.createArrayNode();
            if (op) for (var u : rows(c, "SELECT id FROM users WHERE role IN ('contributor','reviewer') ORDER BY created_at ASC")) dir.add(talent(c, u.get("id").asText()));
            else if (r.equals("contributor") || r.equals("reviewer")) dir.add(talent(c, a.id()));
            o.set("talentDirectory", dir);
            return wrap("workspace", o);
        });
    }

    // ---------- files (business pillar) ----------
    public JsonNode file(Actor a, String fileId) throws Exception {
        var res = db.tx(c -> {
            var f = one(c, "SELECT * FROM stored_files WHERE id=?", fileId);
            if (f == null) throw new AppError(404, "FILE_NOT_FOUND", "File not found.");
            boolean ok = f.get("owner_user_id").asText().equals(a.id()) || "admin".equals(a.role());
            if (!ok && "business".equals(f.get("pillar").asText())) {
                if ("operator".equals(a.role())) ok = true;
                else if (!f.get("task_id").isNull()) {
                    var t = one(c, "SELECT t.assigned_contributor_id, t.assigned_reviewer_id, p.client_user_id FROM business_tasks t JOIN business_projects p ON p.id=t.project_id WHERE t.id=?", f.get("task_id").asText());
                    if (t != null) for (var k : List.of("assigned_contributor_id", "assigned_reviewer_id", "client_user_id")) if (a.id().equals(t.get(k).asText(null))) ok = true;
                }
            }
            if (!ok) throw new Db.Denied(403, "FORBIDDEN_FILE_ACCESS", "You do not have access to this file.", a, "FILE_ACCESS_DENIED", "FILE", fileId, meta().put("pillar", f.get("pillar").asText()));
            return f;
        });
        Path p = storageRoot.resolve(res.get("storage_key").asText()).normalize();
        if (!p.startsWith(storageRoot) || p.equals(storageRoot)) throw new AppError(400, "INVALID_STORAGE_KEY", "Invalid storage key.");
        byte[] data;
        try { data = Files.readAllBytes(p); } catch (java.io.IOException e) { throw new AppError(404, "FILE_CONTENT_MISSING", "File content is missing from storage."); }
        ((ObjectNode) res).remove("storage_key");
        var out = M.createObjectNode().put("ok", true);
        out.set("metadata", res);
        if (TEXT_MIME.contains(res.get("mime_type").asText())) out.put("textContent", new String(data, java.nio.charset.StandardCharsets.UTF_8));
        else out.putNull("textContent");
        return out;
    }
}
