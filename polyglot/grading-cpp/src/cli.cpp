// CLI: stdin lines "maxPoints|kw1,kw2|answer" ; optional argv[1]=maxScore. Outputs JSON.
#include "grading.hpp"
#include <iostream>
#include <sstream>
using namespace solob;
int main(int argc, char** argv){
  double maxScore = argc > 1 ? std::stod(argv[1]) : 20.0;
  std::vector<Question> qs; std::vector<std::string> as; std::string line;
  while (std::getline(std::cin, line)) {
    auto a = line.find('|'), b = line.find('|', a == std::string::npos ? 0 : a+1);
    if (a == std::string::npos || b == std::string::npos) { std::cerr << "bad line\n"; return 2; }
    Question q{ std::stod(line.substr(0,a)), {} };
    std::stringstream ks(line.substr(a+1, b-a-1)); std::string k; while (std::getline(ks,k,',')) if(!k.empty()) q.keywords.push_back(k);
    qs.push_back(q); as.push_back(line.substr(b+1));
  }
  auto r = grade(qs, as, maxScore);
  std::cout << "{\"score\":" << r.score << ",\"maxScore\":" << r.maxScore << ",\"percent\":" << r.percent << ",\"feedbackLevel\":\"" << r.feedbackLevel << "\"}\n";
}
