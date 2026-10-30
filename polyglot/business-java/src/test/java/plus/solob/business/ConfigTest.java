package plus.solob.business;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class ConfigTest {
    @Test void serviceSecretRules() {
        String good = "s".repeat(32);
        assertEquals(good, BusinessServer.resolveServiceSecret(good, "production"));
        assertEquals(BusinessServer.DEV_ONLY_SERVICE_SECRET, BusinessServer.resolveServiceSecret(null, "development"));
        assertTrue(BusinessServer.DEV_ONLY_SERVICE_SECRET.length() >= 32);
        String[][] bad = {{null, "production"}, {"", null}, {"short", "development"}, {"x".repeat(31), "production"}, {"changeme".repeat(5), "production"}, {null, "staging"}};
        for (var b : bad) assertThrows(IllegalStateException.class, () -> BusinessServer.resolveServiceSecret(b[0], b[1]));
    }
}
