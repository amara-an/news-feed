# Academic Feed

개인 학술 피드 — 영문 RSS 자동 수집 + 승인 후 한국어 번역 게시.

- RSS: Nature / Nature Human Behaviour / arXiv AI
- 각 피드: 하루 신규 기사 최대 20건
- 중복 제거: DOI / URL / 제목
- 보존: 최근 30일
- 자동 수집: GitHub Actions, 01:00 KST
- 번역: ChatGPT 대화에서 사용자의 명시적 승인 후 GitHub에 게시 (별도 OpenAI API 호출 없음)
- 예약 확인: ChatGPT, 04:00 KST (번역·게시 자동 승인 아님)

영문: `/en/`, 한국어: `/ko/` (GitHub Pages).

## 설정

1. 저장소 Settings → Pages → Source를 **GitHub Actions**로 변경.
2. Actions 권한의 `GITHUB_TOKEN`에 Contents: write 허용 (필요시).
3. Actions의 "Collect academic feeds"에서 **Run workflow**로 수동 시험.
4. 학술 자료 수집과 HTML 게시 결과 확인 후 ChatGPT 승인형 번역 연결.

수집·게시 구조는 기존 GitHub RSS 리더 프로젝트(YourFeedHub, osmos::feed 등)의 일반적인 Actions + Pages 배치를 참고하되 코드는 독립 구현.
