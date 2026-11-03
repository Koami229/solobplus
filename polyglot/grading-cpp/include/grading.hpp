// Port of the School exercise grading heuristic (src/lib/school/service.ts).
#pragma once
#include <string>
#include <vector>
namespace solob {
struct Question { double maxPoints; std::vector<std::string> keywords; };
struct QuestionResult { double points; int matched; std::vector<int> matchedIndices; };
struct GradeResult { std::vector<QuestionResult> perQuestion; double score; double maxScore; double percent; std::string feedbackLevel; };
QuestionResult grade_answer(const Question& q, const std::string& answer);
GradeResult grade(const std::vector<Question>& qs, const std::vector<std::string>& answers, double maxScore = 20.0);
double round2(double v);
std::size_t utf8_trimmed_length(const std::string& s);
}
