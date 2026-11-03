package plus.solob.business;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.*;
import java.net.URI;
import java.net.http.*;
import java.nio.file.*;
import java.sql.DriverManager;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;

/** Integration tests against PostgreSQL 16: full Business lifecycle, RBAC, denied audits, rollback, file ACL. */
class BusinessFlowTest {
    static final String SECRET = "k".repeat(40);
    static String jdbc; static BusinessServer srv; static int port; static Path storage;
    static final HttpClient http = HttpClient.newHttpClient();
    static String client, client2, op, contrib, contrib2, reviewer, reviewer2;

    @BeforeAll static void up() throws Exception {
        String u = System.getenv("TEST_DATABASE_URL");
        Assumptions.assumeTrue(u != null && !u.isBlank(), "TEST_DATABASE_URL unset");
        jdbc = BusinessServer.toJdbc(u); storage = Files.createTempDirectory("biz-store");
        srv = new BusinessServer(jdbc, SECRET, storage); port = srv.start("127.0.0.1", 0);
        client = BusinessServerTest.mkUserOn(jdbc, "org_client"); client2 = BusinessServerTest.mkUserOn(jdbc, "org_client");
        op = BusinessServerTest.mkUserOn(jdbc, "operator"); contrib = BusinessServerTest.mkUserOn(jdbc, "contributor");
        contrib2 = BusinessServerTest.mkUserOn(jdbc, "contributor"); reviewer = BusinessServerTest.mkUserOn(jdbc, "reviewer"); reviewer2 = BusinessServerTest.mkUserOn(jdbc, "reviewer");
    }
    @AfterAll static void down() { if (srv != null) srv.stop(); }

    static HttpResponse<String> call(String method, String path, String body, String uid, String role) throws Exception {
        var b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).header("x-solob-service-secret", SECRET)
                .header("x-solob-user-id", uid).header("x-solob-user-role", role).header("x-solob-user-email", uid + "@e.org");
        b = body == null ? b.GET() : b.POST(HttpRequest.BodyPublishers.ofString(body));
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
    static JsonNode act(int expect, String uid, String role, String json) throws Exception {
        var r = call("POST", "/actions", json, uid, role);
        assertEquals(expect, r.statusCode(), r.body()); return BusinessServer.M.readTree(r.body());
    }
    static JsonNode get(int expect, String path, String uid, String role) throws Exception {
        var r = call("GET", path, null, uid, role); assertEquals(expect, r.statusCode(), r.body()); return BusinessServer.M.readTree(r.body());
    }
    static long count(String sql, Object... a) throws Exception {
        try (var c = DriverManager.getConnection(jdbc); var ps = c.prepareStatement(sql)) {
            for (int i = 0; i < a.length; i++) ps.setObject(i + 1, a[i]);
            try (var rs = ps.executeQuery()) { rs.next(); return rs.getLong(1); }
        }
    }
    static String newProject(String clientId) throws Exception {
        return act(201, clientId, "org_client", BusinessServerTest.project("Corpus Fon " + UUID.randomUUID(), 50000).replace("{", "{\"action\":\"create_project\",")).at("/project/id").asText();
    }
    static void verify(String user, String lang) throws Exception {
        act(201, op, "operator", "{\"action\":\"record_assessment\",\"talentUserId\":\"%s\",\"assessmentType\":\"LANGUAGE_PROFICIENCY\",\"languageCode\":\"%s\",\"skillName\":\"Oral\",\"score\":88}".formatted(user, lang));
    }
    static String task(String pid, String c, String r, String lang) throws Exception {
        return act(201, op, "operator", ("{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"Transcribe\",\"instructions\":\"Do it\",\"languageCode\":\"%s\","
                + "\"assignedContributorId\":\"%s\"%s,\"compensationCents\":1200}").formatted(pid, lang, c, r == null ? "" : ",\"assignedReviewerId\":\"" + r + "\"")).at("/task/id").asText();
    }

    @Test void fullLifecycleWithSelfReviewBanAndDeniedAudits() throws Exception {
        String pid = newProject(client);
        // talent profile (claimed, unverified) -> assignment blocked + DENIED audit committed despite rollback
        var prof = act(200, contrib, "contributor", "{\"action\":\"upsert_talent_profile\",\"headline\":\"Fon linguist\",\"country\":\"BJ\",\"nativeLanguages\":[\"FON\"],\"dialects\":[\"Gun\"],\"consentVoiceDataset\":true,\"targetUserId\":\"" + op + "\"}");
        assertEquals(contrib, prof.at("/profile/user/id").asText(), "contributor cannot write someone else's profile");
        assertEquals("fon", prof.at("/profile/verificationSummary/unverifiedClaimedLanguages/0").asText());
        var blocked = act(400, op, "operator", "{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"T\",\"instructions\":\"I\",\"languageCode\":\"fon\",\"assignedContributorId\":\"%s\",\"compensationCents\":10}".formatted(pid, contrib));
        assertEquals("UNVERIFIED_LANGUAGE_PROFICIENCY", blocked.at("/error/code").asText());
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='TASK_ASSIGNMENT_BLOCKED_UNVERIFIED_LANGUAGE' AND target_id=? AND status='DENIED'", pid));
        assertEquals(0, count("SELECT count(*) FROM business_tasks WHERE project_id=?", pid));
        act(403, contrib, "contributor", "{\"action\":\"record_assessment\",\"talentUserId\":\"%s\",\"assessmentType\":\"LANGUAGE_PROFICIENCY\",\"languageCode\":\"fon\",\"skillName\":\"x\",\"score\":99}".formatted(contrib));
        act(400, op, "operator", "{\"action\":\"record_assessment\",\"talentUserId\":\"%s\",\"assessmentType\":\"LANGUAGE_PROFICIENCY\",\"languageCode\":\"fon\",\"skillName\":\"x\",\"score\":101}".formatted(contrib));
        verify(contrib, "fon");

        // matching (operator only)
        var m = get(200, "/matches/" + pid, op, "operator");
        var mine = new ArrayList<JsonNode>(); m.get("candidates").forEach(x -> { if (x.get("userId").asText().equals(contrib)) mine.add(x); });
        assertEquals(1, mine.size()); assertTrue(mine.get(0).get("eligibleForVerifiedAssignment").asBoolean());
        assertEquals(27.5 + 5 + 10 + 10, mine.get(0).get("matchScore").asDouble()); // fon verified of [fon,yor]
        get(403, "/matches/" + pid, contrib, "contributor");

        // reviewer == contributor refused; then assign
        act(400, op, "operator", "{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"T\",\"instructions\":\"I\",\"languageCode\":\"fon\",\"assignedContributorId\":\"%s\",\"assignedReviewerId\":\"%s\",\"compensationCents\":10}".formatted(pid, contrib, contrib));
        String tid = task(pid, contrib, reviewer, "fon");
        assertEquals("IN_EXECUTION", get(200, "/workspace", client, "org_client").at("/workspace/projects/0/status").asText());
        assertEquals(1, count("SELECT count(*) FROM compensation_records WHERE task_id=? AND payment_status='PENDING' AND provider_mode='DISABLED_NO_LIVE_TRANSFER'", tid));
        assertEquals(1, count("SELECT count(*) FROM notifications WHERE user_id=? AND category='TASK_ASSIGNED'", contrib));

        // task ACL
        get(200, "/tasks/" + tid, contrib, "contributor");
        get(200, "/tasks/" + tid, reviewer, "reviewer");
        get(403, "/tasks/" + tid, contrib2, "contributor");
        get(403, "/tasks/" + tid, reviewer2, "reviewer");
        assertEquals(2, count("SELECT count(*) FROM audit_events WHERE action='UNAUTHORIZED_TASK_ACCESS_ATTEMPT' AND target_id=?", tid));

        // submission
        act(403, contrib2, "contributor", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"hello world\"}".formatted(tid));
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='UNAUTHORIZED_TASK_SUBMISSION_ATTEMPT' AND target_id=?", tid));
        act(400, contrib, "contributor", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"hi\"}".formatted(tid));
        String s1 = act(201, contrib, "contributor", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"Mɛ e ɖo xwé\"}".formatted(tid)).at("/submission/id").asText();

        // review rules: no self review, assigned reviewer only, scores validated
        String rev = "{\"action\":\"review_submission\",\"submissionId\":\"%s\",\"decision\":\"%s\",\"qualityScore\":%s,\"feedback\":\"Looks good\"}";
        act(403, contrib, "contributor", rev.formatted(s1, "APPROVE", "90"));
        act(403, reviewer2, "reviewer", rev.formatted(s1, "APPROVE", "90"));
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='UNAUTHORIZED_TASK_REVIEW_ATTEMPT' AND target_id=?", s1));
        act(400, reviewer, "reviewer", rev.formatted(s1, "APPROVE", "150"));
        act(200, reviewer, "reviewer", rev.formatted(s1, "REQUEST_REVISION", "60"));
        assertEquals("REVISION_REQUESTED", get(200, "/tasks/" + tid, op, "operator").at("/task/status").asText());
        act(409, reviewer, "reviewer", rev.formatted(s1, "APPROVE", "95"));  // already reviewed / not latest SUBMITTED
        String s2 = act(201, contrib, "contributor", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"Version 2 corrigée\"}".formatted(tid)).at("/submission/revision_number").asText();
        assertEquals("2", s2);
        String s2id = get(200, "/tasks/" + tid, contrib, "contributor").at("/submissions/0/id").asText();

        // operator who also submitted himself cannot self-review either
        String pidSelf = newProject(client);
        verify(op, "fon");
        String tSelf = task(pidSelf, op, null, "fon");
        String sSelf = act(201, op, "operator", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"self made\"}".formatted(tSelf)).at("/submission/id").asText();
        var self = act(403, op, "operator", rev.formatted(sSelf, "APPROVE", "99"));
        assertEquals("SELF_REVIEW_FORBIDDEN", self.at("/error/code").asText());
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='SELF_REVIEW_BLOCKED' AND target_id=? AND status='DENIED'", sSelf));
        assertEquals(0, count("SELECT count(*) FROM task_reviews WHERE submission_id=?", sSelf));

        // finalize before approval -> refused
        act(400, op, "operator", "{\"action\":\"finalize_delivery\",\"projectId\":\"%s\",\"title\":\"Final\",\"executiveSummary\":\"Done\"}".formatted(pid));
        var ok = act(200, reviewer, "reviewer", rev.formatted(s2id, "APPROVE", "92"));
        assertEquals("APPROVED", ok.at("/compensation/payment_status").asText());
        assertEquals("APPROVED", ok.at("/task/status").asText());
        act(409, contrib, "contributor", "{\"action\":\"submit_work\",\"taskId\":\"%s\",\"contentText\":\"late change\"}".formatted(tid));

        var rep = act(201, op, "operator", "{\"action\":\"finalize_delivery\",\"projectId\":\"%s\",\"title\":\"Final\",\"executiveSummary\":\"Done\"}".formatted(pid)).get("report");
        assertEquals(92.0, rep.get("average_quality_score").asDouble());
        assertEquals(1, rep.get("total_tasks_approved").asInt());
        assertEquals(1, count("SELECT count(*) FROM compensation_records WHERE task_id=? AND payment_status='READY_FOR_PAYOUT'", tid));
        assertEquals(1, count("SELECT count(*) FROM business_projects WHERE id=? AND status='DELIVERED'", pid));
        String rid = rep.get("id").asText();
        get(200, "/reports/" + rid, client, "org_client");
        get(403, "/reports/" + rid, client2, "org_client");
        get(403, "/reports/" + rid, contrib, "contributor");
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='DELIVERY_REPORT_ACCESS_DENIED' AND target_id=?", rid));

        // compensation: live transfer always blocked, simulated payout allowed
        String cid = ok.at("/compensation/id").asText();
        var live = act(400, op, "operator", "{\"action\":\"update_compensation\",\"compensationId\":\"%s\",\"newStatus\":\"PAID_SIMULATED\",\"attemptLiveTransfer\":true}".formatted(cid));
        assertEquals("LIVE_TRANSFER_DISABLED", live.at("/error/code").asText());
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='LIVE_MONEY_TRANSFER_BLOCKED' AND target_id=?", cid));
        var paid = act(200, op, "operator", "{\"action\":\"update_compensation\",\"compensationId\":\"%s\",\"newStatus\":\"PAID_SIMULATED\"}".formatted(cid));
        assertEquals("SANDBOX_SIMULATED", paid.at("/compensation/provider_mode").asText());
        act(403, contrib, "contributor", "{\"action\":\"update_compensation\",\"compensationId\":\"%s\",\"newStatus\":\"PAID_SIMULATED\"}".formatted(cid));
        act(400, op, "operator", "{\"action\":\"update_compensation\",\"compensationId\":\"%s\",\"newStatus\":\"WIRED\"}".formatted(cid));

        // workspace isolation
        var wc = get(200, "/workspace", contrib2, "contributor").get("workspace");
        assertEquals(0, wc.get("tasks").size()); assertEquals(0, wc.get("compensations").size());
        var wr2 = get(200, "/workspace", reviewer2, "reviewer").get("workspace");
        wr2.get("tasks").forEach(t -> assertNotEquals(tid, t.get("id").asText()));
        var wcl2 = get(200, "/workspace", client2, "org_client").get("workspace");
        assertEquals(0, wcl2.get("deliveryReports").size());
    }

    @Test void reviewProjectOperatorOnlyAndValidated() throws Exception {
        String pid = newProject(client);
        act(403, client, "org_client", "{\"action\":\"review_project\",\"projectId\":\"%s\",\"newStatus\":\"APPROVED_ACTIVE\"}".formatted(pid));
        act(400, op, "operator", "{\"action\":\"review_project\",\"projectId\":\"%s\",\"newStatus\":\"WHATEVER\"}".formatted(pid));
        act(404, op, "operator", "{\"action\":\"review_project\",\"projectId\":\"nope\",\"newStatus\":\"UNDER_REVIEW\"}");
        var r = act(200, op, "operator", "{\"action\":\"review_project\",\"projectId\":\"%s\",\"newStatus\":\"APPROVED_ACTIVE\",\"operatorNotes\":\"ok\"}".formatted(pid));
        assertEquals("APPROVED_ACTIVE", r.at("/project/status").asText());
        assertEquals(op, r.at("/project/reviewed_by_user_id").asText());
        assertEquals(1, count("SELECT count(*) FROM notifications WHERE user_id=? AND category='PROJECT_STATUS'", client));
        assertEquals(1, count("SELECT count(*) FROM audit_events WHERE action='PROJECT_STATUS_TRANSITIONED' AND target_id=?", pid));
        act(400, op, "operator", "{\"action\":\"nope\"}");
    }

    @Test void transactionRollsBackOnFailure() throws Exception {
        String pid = newProject(client);
        String c3 = BusinessServerTest.mkUserOn(jdbc, "contributor"); verify(c3, "fon");
        // a non-business source file makes the action fail after team creation would have happened -> nothing persisted
        String fid = "fil_" + UUID.randomUUID().toString().substring(0, 8);
        try (var c = DriverManager.getConnection(jdbc); var ps = c.prepareStatement("INSERT INTO stored_files (id,owner_user_id,pillar,original_name,storage_key,mime_type,size_bytes,sha256_checksum) VALUES (?,?,'school','a.txt',?,'text/plain',1,'x')")) {
            ps.setString(1, fid); ps.setString(2, c3); ps.setString(3, "k/" + fid); ps.executeUpdate();
        }
        act(400, op, "operator", "{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"T\",\"instructions\":\"I\",\"languageCode\":\"fon\",\"assignedContributorId\":\"%s\",\"sourceFileId\":\"%s\",\"compensationCents\":5}".formatted(pid, c3, fid));
        assertEquals(0, count("SELECT count(*) FROM project_teams WHERE project_id=?", pid));
        assertEquals(0, count("SELECT count(*) FROM compensation_records WHERE project_id=?", pid));
        assertEquals(1, count("SELECT count(*) FROM business_projects WHERE id=? AND status='SUBMITTED'", pid));
    }

    @Test void businessTaskFileAcl() throws Exception {
        String pid = newProject(client); String c4 = BusinessServerTest.mkUserOn(jdbc, "contributor"); verify(c4, "fon");
        String fid = "fil_" + UUID.randomUUID().toString().substring(0, 8), key = "business/" + fid + ".txt";
        Files.createDirectories(storage.resolve("business")); Files.writeString(storage.resolve(key), "source corpus");
        try (var c = DriverManager.getConnection(jdbc); var ps = c.prepareStatement("INSERT INTO stored_files (id,owner_user_id,pillar,original_name,storage_key,mime_type,size_bytes,sha256_checksum) VALUES (?,?,'business','src.txt',?,'text/plain',13,'x')")) {
            ps.setString(1, fid); ps.setString(2, op); ps.setString(3, key); ps.executeUpdate();
        }
        get(403, "/files/" + fid, c4, "contributor"); // not yet bound to a task
        String tid = act(201, op, "operator", "{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"T\",\"instructions\":\"I\",\"languageCode\":\"fon\",\"assignedContributorId\":\"%s\",\"assignedReviewerId\":\"%s\",\"sourceFileId\":\"%s\",\"compensationCents\":5}".formatted(pid, c4, reviewer, fid)).at("/task/id").asText();
        assertEquals(1, count("SELECT count(*) FROM stored_files WHERE id=? AND task_id=? AND visibility='assigned_task'", fid, tid));
        var f = get(200, "/files/" + fid, c4, "contributor");
        assertEquals("source corpus", f.get("textContent").asText()); assertFalse(f.get("metadata").has("storage_key"));
        get(200, "/files/" + fid, reviewer, "reviewer");
        get(200, "/files/" + fid, client, "org_client");
        get(403, "/files/" + fid, client2, "org_client");
        get(403, "/files/" + fid, contrib2, "contributor");
        get(404, "/files/fil_missing", c4, "contributor");
        get(404, "/files/../etc", c4, "contributor");
        assertTrue(count("SELECT count(*) FROM audit_events WHERE action='FILE_ACCESS_DENIED' AND target_id=?", fid) >= 3);
        // binding the same file to a second task is refused
        act(409, op, "operator", "{\"action\":\"create_assign_task\",\"projectId\":\"%s\",\"title\":\"T\",\"instructions\":\"I\",\"languageCode\":\"fon\",\"assignedContributorId\":\"%s\",\"sourceFileId\":\"%s\",\"compensationCents\":5}".formatted(pid, c4, fid));
    }

    @Test void poolReusesConnections() throws Exception {
        var ds = srv.db().dataSource();
        for (int i = 0; i < 30; i++) get(200, "/workspace", op, "operator");
        assertTrue(ds.getHikariPoolMXBean().getTotalConnections() <= 10, "pool must stay bounded");
    }
}
