#include "catch_amalgamated.hpp"
#include "grading.hpp"
using namespace solob;
TEST_CASE("long answer with all keywords gets full marks"){
  auto r = grade_answer({10,{"photosynthese","lumiere"}}, "La photosynthese utilise la lumiere pour produire du glucose.");
  REQUIRE(r.points == 10.0); REQUIRE(r.matched == 2);
}
TEST_CASE("medium answer, half keywords"){ REQUIRE(grade_answer({10,{"a1","zz"}}, "reponse moyenne a1 ok").points == 5.5); }
TEST_CASE("no keywords => ratio 0.5"){ REQUIRE(grade_answer({4,{}}, "court").points == 1.0); }
TEST_CASE("empty answer, negative max clamp"){ REQUIRE(grade_answer({5,{"x"}}, "   ").points == 0.0); REQUIRE(grade_answer({-3,{}}, "abc").points == 0.0); }
TEST_CASE("keyword matching is case-insensitive"){ REQUIRE(grade_answer({2,{"NEWTON"}}, "newton").matched == 1); }
TEST_CASE("total clamped to maxScore and feedback thresholds"){
  std::string longa(50,'x');
  auto r = grade({{15,{}},{15,{}}}, {longa,longa}, 20); REQUIRE(r.score == 20.0); REQUIRE(r.percent == 100.0); REQUIRE(r.feedbackLevel=="strong");
  auto p = grade({{10,{}},{10,{}}}, {longa,""}, 20); REQUIRE(p.score == 10.0); REQUIRE(p.feedbackLevel=="partial");
  REQUIRE(grade({{10,{"k"}},{10,{"k"}}}, {"", ""}, 20).feedbackLevel == "needs_work");
  auto m = grade({{20,{"k"}}}, {"k " + longa}, 20); REQUIRE(m.feedbackLevel=="strong");
  REQUIRE(grade({{20,{"k"}}}, {longa}, 20).feedbackLevel == "partial");
}
TEST_CASE("missing answers count as empty; default maxScore"){ auto r = grade({{5,{}}}, {}, 0); REQUIRE(r.maxScore==20.0); REQUIRE(r.score==1.25); }
TEST_CASE("round2"){ REQUIRE(round2(1.005*1000)/1000 >= 0); REQUIRE(round2(3.14159)==3.14); }
TEST_CASE("utf8 length counts code points like JS for accented text"){
  REQUIRE(utf8_trimmed_length("  éèà  ") == 3);
  std::string fifteen = "ééééééééééééééé"; // 15 code points, 30 bytes
  REQUIRE(utf8_trimmed_length(fifteen) == 15);
  REQUIRE(grade_answer({10,{"zz"}}, "éééééééééééééé").points == 0.0);   // 14 chars < 15
  REQUIRE(grade_answer({10,{"zz"}}, fifteen).points == 3.0);
}
TEST_CASE("matched keyword indices are reported"){
  auto r = grade_answer({4,{"alpha","beta","gamma"}}, "gamma et alpha");
  REQUIRE(r.matchedIndices == std::vector<int>{0,2});
}
