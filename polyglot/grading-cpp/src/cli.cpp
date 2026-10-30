// solob-grade — length-prefixed stdin protocol (robust to any byte in answers/keywords):
//   line 1: "SOLOBGRADE1 <maxScore> <questionCount>"
//   per question: "<maxPoints> <keywordCount>" then for each keyword and finally the answer:
//                 "<byteLength>\n<bytes>\n"
// Output: one JSON object on stdout. Exit 2 on malformed input (message on stderr).
#include "grading.hpp"
#include <iostream>
#include <iomanip>
#include <sstream>
#include <limits>
using namespace solob;

static bool read_blob(std::istream& in, std::string& out) {
  size_t n; if (!(in >> n) || n > 1'000'000) return false;
  in.ignore(1); out.assign(n, '\0');
  if (n && !in.read(out.data(), (std::streamsize)n)) return false;
  return true;
}
static std::string num(double v){ std::ostringstream o; o << std::setprecision(15) << v; return o.str(); }

int main() {
  std::ios::sync_with_stdio(false);
  std::string magic; double maxScore; size_t qn;
  if (!(std::cin >> magic >> maxScore >> qn) || magic != "SOLOBGRADE1" || qn > 200) { std::cerr << "bad header\n"; return 2; }
  std::vector<Question> qs; std::vector<std::string> as;
  for (size_t i = 0; i < qn; ++i) {
    double mp; size_t kn;
    if (!(std::cin >> mp >> kn) || kn > 100) { std::cerr << "bad question\n"; return 2; }
    Question q{mp, {}};
    for (size_t k = 0; k < kn; ++k) { std::string kw; if (!read_blob(std::cin, kw)) { std::cerr << "bad keyword\n"; return 2; } q.keywords.push_back(kw); }
    std::string a; if (!read_blob(std::cin, a)) { std::cerr << "bad answer\n"; return 2; }
    qs.push_back(std::move(q)); as.push_back(std::move(a));
  }
  auto r = grade(qs, as, maxScore);
  std::cout << "{\"score\":" << num(r.score) << ",\"maxScore\":" << num(r.maxScore) << ",\"percent\":" << num(r.percent)
            << ",\"feedbackLevel\":\"" << r.feedbackLevel << "\",\"questions\":[";
  for (size_t i = 0; i < r.perQuestion.size(); ++i) {
    auto& q = r.perQuestion[i];
    std::cout << (i ? "," : "") << "{\"points\":" << num(q.points) << ",\"matchedIndices\":[";
    for (size_t j = 0; j < q.matchedIndices.size(); ++j) std::cout << (j ? "," : "") << q.matchedIndices[j];
    std::cout << "]}";
  }
  std::cout << "]}\n";
  return 0;
}
