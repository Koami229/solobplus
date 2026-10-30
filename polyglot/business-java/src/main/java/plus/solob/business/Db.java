package plus.solob.business;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import java.math.BigDecimal;
import java.sql.*;
import java.util.*;
import static plus.solob.business.BusinessServer.M;

/** HikariCP-backed pool + small JDBC helpers. One transaction per business action. */
public final class Db implements AutoCloseable {
    private final HikariDataSource ds;

    public Db(String jdbcUrl) {
        var cfg = new HikariConfig();
        cfg.setJdbcUrl(jdbcUrl);
        cfg.setPoolName("business-java");
        cfg.setMaximumPoolSize(Integer.parseInt(Optional.ofNullable(System.getenv("DB_POOL_MAX")).orElse("10")));
        cfg.setMinimumIdle(1);
        cfg.setConnectionTimeout(5_000);
        cfg.setAutoCommit(false);
        cfg.setInitializationFailTimeout(-1); // start even if PG is down; requests then fail with 503
        ds = new HikariDataSource(cfg);
    }
    public HikariDataSource dataSource() { return ds; }
    @Override public void close() { ds.close(); }

    /** Denial that must leave an audit trail even though the business transaction is rolled back. */
    public static final class Denied extends BusinessServer.AppError {
        final BusinessServer.Actor actor; final String action, targetType, targetId; final ObjectNode meta;
        Denied(int status, String code, String msg, BusinessServer.Actor a, String action, String targetType, String targetId, ObjectNode meta) {
            super(status, code, msg); this.actor = a; this.action = action; this.targetType = targetType; this.targetId = targetId; this.meta = meta;
        }
    }

    public interface TxFn<T> { T run(Connection c) throws Exception; }
    public <T> T tx(TxFn<T> fn) throws Exception {
        try (Connection c = get()) {
            try { T r = fn.run(c); c.commit(); return r; }
            catch (Denied d) {
                c.rollback();
                audit(c, d.actor, d.action, d.targetType, d.targetId, "DENIED", d.meta);
                c.commit();
                throw d;
            } catch (Exception e) { c.rollback(); throw e; }
        }
    }
    private Connection get() {
        try { return ds.getConnection(); }
        catch (SQLException e) { throw new BusinessServer.AppError(503, "DATABASE_UNAVAILABLE", "Business database is unavailable."); }
    }

    static PreparedStatement ps(Connection c, String sql, Object... args) throws SQLException {
        var ps = c.prepareStatement(sql);
        for (int i = 0; i < args.length; i++) {
            Object a = args[i];
            if (a instanceof JsonNode j) ps.setString(i + 1, j.toString());
            else ps.setObject(i + 1, a);
        }
        return ps;
    }
    public static int exec(Connection c, String sql, Object... args) throws SQLException { try (var p = ps(c, sql, args)) { return p.executeUpdate(); } }
    public static ArrayNode rows(Connection c, String sql, Object... args) throws Exception {
        try (var p = ps(c, sql, args); var rs = p.executeQuery()) {
            var out = M.createArrayNode(); var md = rs.getMetaData();
            while (rs.next()) {
                ObjectNode o = out.addObject();
                for (int i = 1; i <= md.getColumnCount(); i++) put(o, md.getColumnLabel(i), rs.getObject(i));
            }
            return out;
        }
    }
    public static ObjectNode one(Connection c, String sql, Object... args) throws Exception {
        var r = rows(c, sql, args); return r.isEmpty() ? null : (ObjectNode) r.get(0);
    }
    static void put(ObjectNode o, String k, Object v) throws Exception {
        if (v == null) o.putNull(k);
        else if (v instanceof org.postgresql.util.PGobject pg && pg.getType() != null && pg.getType().startsWith("json")) o.set(k, pg.getValue() == null ? M.nullNode() : M.readTree(pg.getValue()));
        else if (v instanceof BigDecimal b) o.put(k, b.doubleValue());
        else if (v instanceof Integer n) o.put(k, n);
        else if (v instanceof Long n) o.put(k, n);
        else if (v instanceof Boolean b) o.put(k, b);
        else if (v instanceof Timestamp t) o.put(k, t.toInstant().toString());
        else o.put(k, v.toString());
    }

    public static void audit(Connection c, BusinessServer.Actor a, String action, String targetType, String targetId, String status, ObjectNode meta) throws SQLException {
        exec(c, "INSERT INTO audit_events (id,actor_user_id,actor_role,pillar,action,target_type,target_id,status,redacted_metadata_json) VALUES (?,?,?,'business',?,?,?,?,?::jsonb)",
                BusinessServer.newId("aud"), a.id(), a.role(), action, targetType, targetId, status, meta == null ? M.createObjectNode() : meta);
    }
    public static void notify(Connection c, String userId, String category, String title, String message) throws SQLException {
        exec(c, "INSERT INTO notifications (id,user_id,category,title,message,link_path) VALUES (?,?,?,?,?,'/business')",
                BusinessServer.newId("ntf"), userId, category, title, message);
    }
}
