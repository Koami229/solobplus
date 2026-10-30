package plus.solob.business;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.sql.*;
import java.util.*;
import java.util.concurrent.Executors;

/** SOLOB Business service (Java 21, JDK HttpServer + JDBC). Internal only: called by the Rust gateway. */
public final class BusinessServer {
    static final ObjectMapper M = new ObjectMapper();
    static final Set<String> CREATE_PROJECT_ROLES = Set.of("org_client", "operator", "admin");
    static final Set<String> BUSINESS_ROLES = Set.of("org_client", "contributor", "reviewer", "operator", "admin");
    static final Set<String> MODES = Set.of("MANAGED_PROJECT", "QUALIFIED_TALENT_PROVISION");
    static final Set<String> CATEGORIES = Set.of("AFRICAN_LANG_TRANSCRIPTION_ANNOTATION", "TRANSLATION_LINGUISTIC_VALIDATION",
            "MULTILINGUAL_DATA_PREP", "AI_EVALUATION_MODEL_TESTING", "EXPERT_DATA_ANNOTATION_QA", "SPECIALIZED_AI_PROJECT_TEAM");

    public static final class AppError extends RuntimeException {
        final int status; final String code;
        AppError(int status, String code, String msg) { super(msg); this.status = status; this.code = code; }
    }
    public record Actor(String id, String role, String email) {}

    private final String jdbcUrl; private final byte[] secret;
    private HttpServer server;

    public BusinessServer(String jdbcUrl, String serviceSecret) {
        this.jdbcUrl = jdbcUrl; this.secret = serviceSecret == null ? new byte[0] : serviceSecret.getBytes(StandardCharsets.UTF_8);
    }

    public static String toJdbc(String url) { // postgres://user@host:port/db -> jdbc:postgresql://host:port/db?user=user
        if (url == null || url.isBlank() || url.startsWith("jdbc:")) return url;
        var u = java.net.URI.create(url);
        String q = "";
        if (u.getUserInfo() != null) { var p = u.getUserInfo().split(":", 2); q = "?user=" + p[0] + (p.length > 1 ? "&password=" + p[1] : ""); }
        return "jdbc:postgresql://" + u.getHost() + ":" + (u.getPort() > 0 ? u.getPort() : 5432) + u.getPath() + q;
    }

    public int start(String host, int port) throws IOException {
        server = HttpServer.create(new InetSocketAddress(host, port), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/health", ex -> handle(ex, () -> M.createObjectNode().put("ok", true).put("service", "business-java"), 200));
        server.createContext("/projects", ex -> {
            if (!"POST".equals(ex.getRequestMethod())) { handle(ex, () -> { throw new AppError(405, "METHOD_NOT_ALLOWED", "POST only."); }, 0); return; }
            handle(ex, () -> createProject(actor(ex), M.readTree(ex.getRequestBody().readNBytes(256 * 1024))), 201);
        });
        server.start();
        return server.getAddress().getPort();
    }
    public void stop() { if (server != null) server.stop(0); }

    interface Body { JsonNode get() throws Exception; }
    private void handle(HttpExchange ex, Body b, int ok) throws IOException {
        int status; JsonNode out;
        try { out = b.get(); status = ok; }
        catch (AppError e) { status = e.status; out = err(e.code, e.getMessage()); }
        catch (com.fasterxml.jackson.core.JacksonException e) { status = 400; out = err("VALIDATION_ERROR", "Invalid JSON body."); }
        catch (Exception e) { status = 500; out = err("INTERNAL_ERROR", "Unexpected error."); }
        byte[] bytes = M.writeValueAsBytes(out);
        ex.getResponseHeaders().set("content-type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (var os = ex.getResponseBody()) { os.write(bytes); }
    }
    static JsonNode err(String code, String msg) {
        ObjectNode n = M.createObjectNode(); n.put("ok", false); n.putObject("error").put("code", code).put("message", msg); return n;
    }

    Actor actor(HttpExchange ex) {
        var h = ex.getRequestHeaders();
        byte[] given = Optional.ofNullable(h.getFirst("x-solob-service-secret")).orElse("").getBytes(StandardCharsets.UTF_8);
        if (secret.length < 32 || !MessageDigest.isEqual(given, secret)) throw new AppError(401, "SERVICE_UNAUTHENTICATED", "Invalid internal service credentials.");
        String id = h.getFirst("x-solob-user-id"), role = h.getFirst("x-solob-user-role");
        if (id == null || id.isBlank()) throw new AppError(401, "UNAUTHENTICATED", "Authentication required.");
        if (role == null || !BUSINESS_ROLES.contains(role)) throw new AppError(403, "FORBIDDEN_ROLE", "Role not allowed for SOLOB Business.");
        return new Actor(id, role, Optional.ofNullable(h.getFirst("x-solob-user-email")).orElse(""));
    }

    static String text(JsonNode b, String f) { var n = b.get(f); return n == null || n.isNull() ? "" : n.asText().trim(); }
    static String newId(String p) { var r = new byte[12]; new java.security.SecureRandom().nextBytes(r); return p + "_" + HexFormat.of().formatHex(r); }

    /** Port of createProjectRequest (src/lib/business/service.ts). */
    public JsonNode createProject(Actor a, JsonNode b) throws SQLException {
        if (!CREATE_PROJECT_ROLES.contains(a.role())) throw new AppError(403, "FORBIDDEN_ROLE", "Role not allowed to create projects.");
        if (b == null || !b.isObject()) throw new AppError(400, "VALIDATION_ERROR", "JSON object expected.");
        String title = text(b, "title"), org = text(b, "organizationName");
        if (title.length() < 3) throw new AppError(400, "INVALID_PROJECT_TITLE", "Project title is required (min 3 characters).");
        if (org.isEmpty()) throw new AppError(400, "MISSING_ORGANIZATION", "Organization name is required.");
        if (text(b, "deliverablesSpec").isEmpty() || text(b, "acceptanceCriteria").isEmpty())
            throw new AppError(400, "MISSING_PROJECT_SPECS", "Deliverables specification and acceptance criteria are required.");
        if (!MODES.contains(text(b, "serviceMode"))) throw new AppError(400, "INVALID_SERVICE_MODE", "Invalid service mode.");
        if (!CATEGORIES.contains(text(b, "serviceCategory"))) throw new AppError(400, "INVALID_SERVICE_CATEGORY", "Invalid service category.");
        var budgetNode = b.get("budgetAmountCents");
        if (budgetNode == null || !budgetNode.canConvertToLong() || !budgetNode.isIntegralNumber()) throw new AppError(400, "INVALID_BUDGET", "Budget must be an integer number of cents.");
        long budget = budgetNode.asLong();
        if (budget < 0) throw new AppError(400, "INVALID_BUDGET", "Project budget cannot be negative.");
        String currency = text(b, "currency").isEmpty() ? "USD" : text(b, "currency").toUpperCase(Locale.ROOT);
        if (!currency.matches("[A-Z]{3}")) throw new AppError(400, "INVALID_CURRENCY", "Currency must be an ISO-4217 code.");
        long estimated = Math.round(budget * 0.85);
        var langs = b.has("targetLanguages") && b.get("targetLanguages").isArray() ? b.get("targetLanguages") : M.createArrayNode();
        var dialects = b.has("targetDialects") && b.get("targetDialects").isArray() ? b.get("targetDialects") : M.createArrayNode();

        try (Connection c = DriverManager.getConnection(jdbcUrl)) {
            c.setAutoCommit(false);
            try {
                String orgId = null;
                try (var ps = c.prepareStatement("SELECT id FROM organizations WHERE owner_user_id=? AND name=? FOR UPDATE")) {
                    ps.setString(1, a.id()); ps.setString(2, org);
                    try (var rs = ps.executeQuery()) { if (rs.next()) orgId = rs.getString(1); }
                }
                if (orgId == null) {
                    orgId = newId("org");
                    // Divergence from TS (which set verified=TRUE): a self-declared organization is NOT verified.
                    try (var ps = c.prepareStatement("INSERT INTO organizations (id,owner_user_id,name,country,industry,contact_email,billing_currency,verified) VALUES (?,?,?,?,?,?,?,FALSE)")) {
                        ps.setString(1, orgId); ps.setString(2, a.id()); ps.setString(3, org);
                        ps.setString(4, text(b, "organizationCountry").isEmpty() ? "BJ" : text(b, "organizationCountry"));
                        ps.setString(5, text(b, "organizationIndustry").isEmpty() ? "AI & Language Technology" : text(b, "organizationIndustry"));
                        ps.setString(6, a.email()); ps.setString(7, currency); ps.executeUpdate();
                    }
                }
                String pid = newId("prj");
                try (var ps = c.prepareStatement("""
                        INSERT INTO business_projects (id,organization_id,client_user_id,title,service_mode,service_category,status,
                          description,deliverables_spec,acceptance_criteria,target_languages_json,target_dialects_json,
                          budget_amount_cents,estimated_cost_cents,currency,deadline_date)
                        VALUES (?,?,?,?,?,?,'SUBMITTED',?,?,?,?::jsonb,?::jsonb,?,?,?,?)""")) {
                    int i = 1;
                    ps.setString(i++, pid); ps.setString(i++, orgId); ps.setString(i++, a.id()); ps.setString(i++, title);
                    ps.setString(i++, text(b, "serviceMode")); ps.setString(i++, text(b, "serviceCategory"));
                    ps.setString(i++, text(b, "description")); ps.setString(i++, text(b, "deliverablesSpec")); ps.setString(i++, text(b, "acceptanceCriteria"));
                    ps.setString(i++, M.writeValueAsString(langs)); ps.setString(i++, M.writeValueAsString(dialects));
                    ps.setLong(i++, budget); ps.setLong(i++, estimated); ps.setString(i++, currency);
                    ps.setString(i, text(b, "deadlineDate").isEmpty() ? null : text(b, "deadlineDate"));
                    ps.executeUpdate();
                }
                var meta = M.createObjectNode().put("organizationId", orgId).put("serviceMode", text(b, "serviceMode"))
                        .put("serviceCategory", text(b, "serviceCategory")).put("budgetAmountCents", budget);
                meta.set("targetLanguages", langs);
                try (var ps = c.prepareStatement("INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json) VALUES (?,?,?,'business','PROJECT_REQUEST_CREATED','PROJECT',?,'SUCCESS',?::jsonb)")) {
                    ps.setString(1, newId("aud")); ps.setString(2, a.id()); ps.setString(3, a.role()); ps.setString(4, pid); ps.setString(5, M.writeValueAsString(meta)); ps.executeUpdate();
                }
                c.commit();
                var out = M.createObjectNode().put("ok", true);
                out.putObject("project").put("id", pid).put("organizationId", orgId).put("organizationName", org).put("title", title)
                        .put("status", "SUBMITTED").put("budgetAmountCents", budget).put("estimatedCostCents", estimated).put("currency", currency);
                return out;
            } catch (Exception e) { c.rollback(); throw e; }
        } catch (com.fasterxml.jackson.core.JsonProcessingException e) { throw new AppError(400, "VALIDATION_ERROR", "Invalid JSON."); }
    }

    public static void main(String[] args) throws Exception {
        String bind = Optional.ofNullable(System.getenv("BIND_HOST")).orElse("127.0.0.1");
        int port = Integer.parseInt(Optional.ofNullable(System.getenv("PORT")).orElse("8102"));
        new BusinessServer(toJdbc(System.getenv("DATABASE_URL")), System.getenv("SERVICE_SECRET")).start(bind, port);
        System.out.println("business-java listening on " + bind + ":" + port);
    }
}
