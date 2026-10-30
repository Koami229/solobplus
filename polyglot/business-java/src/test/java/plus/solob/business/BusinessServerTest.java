package plus.solob.business;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.*;
import java.net.URI;
import java.net.http.*;
import java.sql.DriverManager;
import java.util.*;
import java.util.concurrent.*;
import static org.junit.jupiter.api.Assertions.*;

class BusinessServerTest {
    static final String SECRET = "j".repeat(40);
    static String jdbc; static BusinessServer srv; static int port; static final HttpClient http = HttpClient.newHttpClient();

    @BeforeAll static void up() throws Exception {
        String u = System.getenv("TEST_DATABASE_URL");
        Assumptions.assumeTrue(u != null && !u.isBlank(), "TEST_DATABASE_URL unset");
        jdbc = BusinessServer.toJdbc(u);
        srv = new BusinessServer(jdbc, SECRET); port = srv.start("127.0.0.1", 0);
    }
    @AfterAll static void down() { if (srv != null) srv.stop(); }

    static String mkUser(String role) throws Exception {
        String id = "usr_" + UUID.randomUUID().toString().replace("-", "").substring(0, 12);
        try (var c = DriverManager.getConnection(jdbc); var ps = c.prepareStatement("INSERT INTO users (id,email,password_hash,full_name,role,pillar) VALUES (?,?,'x','T',?,'business')")) {
            ps.setString(1, id); ps.setString(2, id + "@e.org"); ps.setString(3, role); ps.executeUpdate();
        }
        return id;
    }
    static HttpResponse<String> post(String path, String body, String uid, String role, String secret) throws Exception {
        var b = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path)).POST(HttpRequest.BodyPublishers.ofString(body));
        if (secret != null) b.header("x-solob-service-secret", secret);
        if (uid != null) b.header("x-solob-user-id", uid).header("x-solob-user-role", role).header("x-solob-user-email", "c@e.org");
        return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }
    static JsonNode j(HttpResponse<String> r) throws Exception { return BusinessServer.M.readTree(r.body()); }
    static String project(String title, long budget) {
        return """
            {"organizationName":"Acme AI","title":"%s","serviceMode":"MANAGED_PROJECT","serviceCategory":"TRANSLATION_LINGUISTIC_VALIDATION",
             "description":"d","deliverablesSpec":"spec","acceptanceCriteria":"crit","targetLanguages":["fon","yor"],"budgetAmountCents":%d}""".formatted(title, budget);
    }

    @Test void health() throws Exception {
        var r = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/health")).build(), HttpResponse.BodyHandlers.ofString());
        assertEquals(200, r.statusCode()); assertEquals("business-java", j(r).get("service").asText());
    }
    @Test void rejectsBadServiceSecret() throws Exception {
        assertEquals(401, post("/projects", project("Corpus Fon", 1000), "u", "org_client", null).statusCode());
        assertEquals("SERVICE_UNAUTHENTICATED", j(post("/projects", "{}", "u", "org_client", "x".repeat(40))).at("/error/code").asText());
        var weak = new BusinessServer(jdbc, ""); int p = weak.start("127.0.0.1", 0);
        try {
            var r = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + p + "/projects")).header("x-solob-service-secret", "")
                    .POST(HttpRequest.BodyPublishers.ofString("{}")).build(), HttpResponse.BodyHandlers.ofString());
            assertEquals(401, r.statusCode());
        } finally { weak.stop(); }
    }
    @Test void rbac() throws Exception {
        assertEquals(403, post("/projects", project("Corpus Fon", 1000), "u", "contributor", SECRET).statusCode());
        assertEquals(403, post("/projects", project("Corpus Fon", 1000), "u", "student", SECRET).statusCode());
    }
    @Test void validation() throws Exception {
        String uid = mkUser("org_client");
        assertEquals("INVALID_PROJECT_TITLE", j(post("/projects", project("ab", 10), uid, "org_client", SECRET)).at("/error/code").asText());
        assertEquals("INVALID_BUDGET", j(post("/projects", project("Corpus", -1), uid, "org_client", SECRET)).at("/error/code").asText());
        assertEquals("INVALID_SERVICE_MODE", j(post("/projects", project("Corpus", 1).replace("MANAGED_PROJECT", "X"), uid, "org_client", SECRET)).at("/error/code").asText());
        assertEquals("VALIDATION_ERROR", j(post("/projects", "{not json", uid, "org_client", SECRET)).at("/error/code").asText());
    }
    @Test void createsProjectReusesOrgAndAudits() throws Exception {
        String uid = mkUser("org_client");
        var r1 = post("/projects", project("Corpus Fon", 10001), uid, "org_client", SECRET);
        assertEquals(201, r1.statusCode(), r1.body());
        var p1 = j(r1).get("project");
        assertEquals("SUBMITTED", p1.get("status").asText()); assertEquals(8501, p1.get("estimatedCostCents").asLong());
        var p2 = j(post("/projects", project("Corpus Yoruba", 500), uid, "org_client", SECRET)).get("project");
        assertEquals(p1.get("organizationId").asText(), p2.get("organizationId").asText());
        try (var c = DriverManager.getConnection(jdbc)) {
            var rs = c.createStatement().executeQuery("SELECT verified FROM organizations WHERE owner_user_id='" + uid + "'");
            assertTrue(rs.next()); assertFalse(rs.getBoolean(1)); assertFalse(rs.next());
            rs = c.createStatement().executeQuery("SELECT COUNT(*) FROM audit_events WHERE actor_user_id='" + uid + "' AND action='PROJECT_REQUEST_CREATED'");
            rs.next(); assertEquals(2, rs.getInt(1));
        }
    }
}
