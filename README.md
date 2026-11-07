# Academic Feed

학술 RSS를 읽기 위한 개인용 영문·한국어 피드.

## 구성
- 자료: Nature, Nature Human Behaviour, arXiv AI
- Cloudflare Workers: 매일 01:00 KST, 출처별 신규 최대 20건 수집, 중복 제거
- GitHub Actions: 매일 02:00 KST, **공개된 Cloudflare JSON API**에서 이미 수집한 영문 기사를 가져와 `docs/data/en.json`에 저장하고 GitHub Pages 배포
- 보관 기간: 영문·한국어 기사 모두 최근 30일
- ChatGPT 예약 확인: 매일 04:00 KST, 신규 미번역 기사를 확인하고 사용자에게 번역·게시 승인 요청
- **사용자 승인 후에만** ChatGPT 일반 대화에서 신규 기사를 한국어로 번역해 `docs/data/ko.json`에 게시. 별도 OpenAI API 사용 없음

## 읽기
- 영어: https://amara-an.github.io/news-feed/en/
- 한국어: https://amara-an.github.io/news-feed/ko/
- 수집 로그: https://github.com/amara-an/news-feed/actions

## 수동 시험
1. GitHub → Actions → Collect academic feeds → Run workflow
2. 실행 로그의 Cloudflare HTTP 호출과 import 결과 확인
3. `docs/data/en.json`의 기사와 GitHub Pages 배포 결과 확인

GitHub에서 학술 RSS를 직접 호출하지 않는다. Cloudflare의 기존 검증된 수집기를 계속 사용한다. 실패 시 기존 GitHub JSON을 덮어쓰지 않도록 Cloudflare 데이터가 비어 있거나 형식이 틀리면 수집 워크플로를 실패 처리한다.
