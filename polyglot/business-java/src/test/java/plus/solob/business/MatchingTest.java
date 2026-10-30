package plus.solob.business;

import org.junit.jupiter.api.Test;
import java.util.List;
import static org.junit.jupiter.api.Assertions.*;

class MatchingTest {
    static Matching.Candidate cand(List<String> verified, List<String> claimed, List<String> dialects, List<String> skills, String st, int h) {
        return new Matching.Candidate(verified, claimed, dialects, skills, st, h);
    }
    @Test void fullVerifiedMatchScores100() {
        var r = Matching.score(List.of("FON"), List.of("gun"), cand(List.of("fon"), List.of("fon"), List.of("Gun-gbe"), List.of("QA"), "AVAILABLE", 20));
        assertEquals(100.0, r.score()); assertTrue(r.eligible());
        assertEquals("Verified assessment passed for language(s): FON", r.reasons().get(0));
        assertTrue(r.reasons().contains("Dialect match: gun"));
    }
    @Test void claimedButUnverifiedIsIneligible() {
        var r = Matching.score(List.of("fon", "yor"), List.of(), cand(List.of(), List.of("Fon"), List.of(), List.of(), "PARTIALLY_AVAILABLE", 30));
        assertEquals(18.0, r.score()); // 0 + 5 + 10 + 3
        assertFalse(r.eligible());
        assertTrue(r.reasons().get(0).contains("[FON] are UNVERIFIED"));
        assertEquals(List.of("fon"), r.unverifiedClaimed());
    }
    @Test void partialAndRounding() {
        // 1/3*55 = 18.333.. + 25 + 0 (dialect miss) + 3 (<10h) = 46.333 -> 46.3
        var r = Matching.score(List.of("fon", "yor", "dendi"), List.of("x"), cand(List.of("yor"), List.of("yor"), List.of("y"), List.of("ASR"), "AVAILABLE", 5));
        assertEquals(46.3, r.score()); assertTrue(r.eligible());
    }
    @Test void noTargetsDefaults() {
        var r = Matching.score(List.of(), List.of(), cand(List.of(), List.of(), List.of(), List.of(), "UNAVAILABLE", 40));
        assertEquals(58.0, r.score()); assertTrue(r.eligible()); // 40+5+10+3
        assertTrue(r.reasons().get(0).startsWith("No verified match"));
    }
}
