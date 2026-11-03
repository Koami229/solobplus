package plus.solob.business;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.*;

/** Pure port of the explainable talent-match scoring (computeExplainableTalentMatches).
 *  Kept in Java on purpose: it is 4 additions over small lists; a C++ subprocess per candidate would cost more than it computes. */
public final class Matching {
    private Matching() {}
    public record Candidate(List<String> verifiedLanguages, List<String> claimedLanguages, List<String> dialects,
                            List<String> passedDomainSkills, String availabilityStatus, int hoursPerWeek) {}
    public record Result(double score, boolean eligible, List<String> reasons, List<String> unverifiedClaimed) {}

    static List<String> lower(List<String> l) { var o = new ArrayList<String>(); for (var s : l) if (s != null) o.add(s.toLowerCase(Locale.ROOT)); return o; }

    public static Result score(List<String> targetLangsIn, List<String> targetDialectsIn, Candidate c) {
        var targetLangs = lower(targetLangsIn); var targetDialects = lower(targetDialectsIn);
        var verified = lower(c.verifiedLanguages());
        var unverifiedClaimed = new ArrayList<String>();
        for (var l : lower(c.claimedLanguages())) if (!verified.contains(l)) unverifiedClaimed.add(l);
        var vMatch = targetLangs.stream().filter(verified::contains).toList();
        var uMatch = targetLangs.stream().filter(unverifiedClaimed::contains).toList();
        var cand = lower(c.dialects());
        var dMatch = targetDialects.stream().filter(td -> cand.stream().anyMatch(cd -> cd.contains(td) || td.contains(cd))).toList();

        double lang = targetLangs.isEmpty() ? 40 : (double) vMatch.size() / targetLangs.size() * 55;
        double skill = c.passedDomainSkills().isEmpty() ? 5 : 25;
        double dial = targetDialects.isEmpty() ? 10 : (double) dMatch.size() / targetDialects.size() * 10;
        double avail = "AVAILABLE".equals(c.availabilityStatus()) && c.hoursPerWeek() >= 10 ? 10 : 3;
        double total = BigDecimal.valueOf(Math.min(100, lang + skill + dial + avail)).setScale(1, RoundingMode.HALF_UP).doubleValue();
        boolean eligible = targetLangs.isEmpty() || !vMatch.isEmpty();

        var reasons = new ArrayList<String>();
        if (!vMatch.isEmpty()) reasons.add("Verified assessment passed for language(s): " + String.join(", ", vMatch).toUpperCase(Locale.ROOT));
        else if (!uMatch.isEmpty()) reasons.add("Claimed language(s) [" + String.join(", ", uMatch).toUpperCase(Locale.ROOT) + "] are UNVERIFIED (no passed assessment on record — blocked from verified assignment)");
        else reasons.add("No verified match for target language(s): " + String.join(", ", targetLangs).toUpperCase(Locale.ROOT));
        if (!c.passedDomainSkills().isEmpty()) reasons.add("Passed domain assessments: " + String.join(", ", c.passedDomainSkills()));
        if (!dMatch.isEmpty()) reasons.add("Dialect match: " + String.join(", ", dMatch));
        reasons.add("Availability: " + c.availabilityStatus() + " (" + c.hoursPerWeek() + "h/week)");
        return new Result(total, eligible, reasons, unverifiedClaimed);
    }
}
