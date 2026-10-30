#include "grading.hpp"
#include <algorithm>
#include <cctype>
#include <cmath>
namespace solob {
static std::string lower(std::string s){ for(auto&c:s) c=(char)std::tolower((unsigned char)c); return s; }
// Length in Unicode code points of the trimmed UTF-8 string (matches JS String.length for BMP text,
// so accented French answers hit the same 15/40 thresholds as the TypeScript version).
size_t utf8_trimmed_length(const std::string& s){
  auto b=s.find_first_not_of(" \t\r\n\f\v"); if(b==std::string::npos) return 0;
  auto e=s.find_last_not_of(" \t\r\n\f\v"); size_t n=0;
  for(size_t i=b;i<=e;++i) if((static_cast<unsigned char>(s[i]) & 0xC0) != 0x80) ++n;
  return n;
}
double round2(double v){ return std::round(v*100.0)/100.0; }
QuestionResult grade_answer(const Question& q, const std::string& answer){
  double m = q.maxPoints < 0 ? 0 : q.maxPoints, p = 0; size_t len = utf8_trimmed_length(answer);
  if (len >= 40) p += m*0.5; else if (len >= 15) p += m*0.3;
  std::string a = lower(answer); int hit = 0; std::vector<int> idx;
  for (size_t i=0;i<q.keywords.size();++i){ auto& k=q.keywords[i]; if (!k.empty() && a.find(lower(k)) != std::string::npos) { ++hit; idx.push_back((int)i); } }
  double ratio = q.keywords.empty() ? 0.5 : (double)hit / q.keywords.size();
  p += m*0.5*ratio;
  return { round2(std::clamp(p, 0.0, m)), hit, idx };
}
GradeResult grade(const std::vector<Question>& qs, const std::vector<std::string>& ans, double maxScore){
  GradeResult r{}; r.maxScore = maxScore > 0 ? maxScore : 20.0; double t = 0;
  for (size_t i=0;i<qs.size();++i){ auto qr = grade_answer(qs[i], i<ans.size()?ans[i]:std::string()); t += qr.points; r.perQuestion.push_back(qr); }
  r.score = round2(std::clamp(t, 0.0, r.maxScore));
  r.percent = round2(r.score / r.maxScore * 100.0);
  r.feedbackLevel = r.percent >= 75 ? "strong" : r.percent >= 50 ? "partial" : "needs_work";
  return r;
}
}
